/**
 * The server side of a WebSocket, as much of RFC 6455 as the bridge needs: text messages,
 * no extensions, no subprotocols. Written out instead of taken from a library so that the
 * bridge has nothing to install and can be handed over as a single file.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });

/** Close codes used here. 1006 is never sent: it reports a connection that just dropped. */
export const CLOSE = Object.freeze({ normal: 1000, goingAway: 1001, protocol: 1002, unsupported: 1003, dropped: 1006, badText: 1007, tooBig: 1009 });

/** How long the other side gets to answer a closing handshake before the socket is cut. */
const CLOSE_GRACE_MS = 2000;

/**
 * @typedef {object} Frame
 * @property {boolean} fin
 * @property {number} opcode
 * @property {Buffer} payload
 */

/** A frame that breaks the protocol, with the close code that says how. */
export class FrameError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} key */
export function acceptKey(key) {
  return createHash('sha1')
    .update(key + HANDSHAKE_GUID)
    .digest('base64');
}

/**
 * Why an HTTP request cannot be upgraded to a WebSocket, as a status line; null if it can.
 * @param {import('node:http').IncomingMessage} request
 * @returns {[status: number, reason: string] | null}
 */
export function upgradeProblem(request) {
  if (request.method !== 'GET') return [405, 'Method Not Allowed'];
  if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return [426, 'Upgrade Required'];
  if (request.headers['sec-websocket-version'] !== '13') return [426, 'Upgrade Required'];
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return [400, 'Bad Request'];
  return null;
}

/**
 * Answers an upgrade request with a refusal and hangs up.
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} reason
 */
export function refuseUpgrade(socket, status, reason) {
  const headers = [`HTTP/1.1 ${status} ${reason}`, 'Connection: close', 'Content-Length: 0'];
  if (status === 426) headers.push('Sec-WebSocket-Version: 13');
  socket.end(headers.join('\r\n') + '\r\n\r\n');
}

/**
 * One frame, ready to send. Frames from a server are not masked.
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function encodeFrame(opcode, payload) {
  const length = payload.length;
  /** @type {Buffer} */
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Cuts a byte stream from a client into frames, unmasking their payloads. */
export class FrameParser {
  /** @param {number} maxPayload */
  constructor(maxPayload) {
    this.maxPayload = maxPayload;
    /** Bytes received that do not make a whole frame yet. @type {Buffer} */
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {Frame[]} The frames completed by this chunk.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    return frames;
  }

  /** @returns {Frame | null} */
  next() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const first = /** @type {number} */ (buffer[0]);
    const second = /** @type {number} */ (buffer[1]);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0) throw new FrameError(CLOSE.protocol, 'Reserved bits are set, but no extension was agreed.');
    if ((second & 0x80) === 0) throw new FrameError(CLOSE.protocol, 'Frames from a client must be masked.');

    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const long = buffer.readBigUInt64BE(2);
      if (long > BigInt(this.maxPayload)) throw new FrameError(CLOSE.tooBig, 'Message too large.');
      length = Number(long);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || length > 125)) throw new FrameError(CLOSE.protocol, 'Control frames must be short and whole.');
    if (length > this.maxPayload) throw new FrameError(CLOSE.tooBig, 'Message too large.');

    const end = offset + 4 + length;
    if (buffer.length < end) return null;
    const mask = buffer.subarray(offset, offset + 4);
    // Copied, so that the frame does not keep the whole receive buffer alive.
    const payload = Buffer.from(buffer.subarray(offset + 4, end));
    for (let i = 0; i < length; i++) payload[i] = /** @type {number} */ (payload[i]) ^ /** @type {number} */ (mask[i & 3]);
    this.buffer = buffer.subarray(end);
    return { fin, opcode, payload };
  }
}

/**
 * An open WebSocket. Emits `message` with each text message and `close` once, with the
 * code and reason, however the connection ended.
 */
export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} socket
   * @param {{ maxPayload: number }} options
   */
  constructor(socket, { maxPayload }) {
    super();
    this.socket = socket;
    this.parser = new FrameParser(maxPayload);
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    /** Pieces of a message that is arriving in several frames. @type {Buffer[] | null} */
    this.fragments = null;
    this.fragmentBytes = 0;
    this.closeSent = false;
    this.closed = false;
    /** True while the other side has answered the last ping. */
    this.alive = true;
    /** @type {NodeJS.Timeout | undefined} */
    this.heartbeat = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this.closeTimer = undefined;

    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.finish(CLOSE.dropped, ''));
  }

  /** Raises or lowers the largest message accepted from now on. */
  set maxPayload(bytes) {
    this.parser.maxPayload = bytes;
  }

  get maxPayload() {
    return this.parser.maxPayload;
  }

  /** @param {Buffer} chunk */
  receive(chunk) {
    if (this.closed) return;
    try {
      for (const frame of this.parser.push(chunk)) this.handle(frame);
    } catch (error) {
      if (!(error instanceof FrameError)) throw error;
      this.close(error.code, error.message);
    }
  }

  /** @param {Frame} frame */
  handle({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.text:
      case OPCODE.binary:
        if (this.fragments) throw new FrameError(CLOSE.protocol, 'A new message began inside another.');
        if (opcode === OPCODE.binary) throw new FrameError(CLOSE.unsupported, 'Only text messages are understood.');
        if (fin) this.deliver(payload);
        else this.collect(payload, true);
        break;
      case OPCODE.continuation:
        if (!this.fragments) throw new FrameError(CLOSE.protocol, 'Continuation of a message that never began.');
        this.collect(payload, false);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = null;
          this.deliver(whole);
        }
        break;
      case OPCODE.ping:
        this.write(OPCODE.pong, payload);
        break;
      case OPCODE.pong:
        this.alive = true;
        break;
      case OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal;
        const reason = payload.subarray(2).toString('utf8');
        // The closing handshake: answer with a close frame unless ours came first.
        if (!this.closeSent) this.write(OPCODE.close, payload.subarray(0, 2));
        this.closeSent = true;
        this.socket.end();
        this.finish(code, reason);
        break;
      }
      default:
        throw new FrameError(CLOSE.protocol, `Unknown opcode ${opcode}.`);
    }
  }

  /**
   * @param {Buffer} piece
   * @param {boolean} first
   */
  collect(piece, first) {
    if (first) {
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    this.fragmentBytes += piece.length;
    if (this.fragmentBytes > this.parser.maxPayload) throw new FrameError(CLOSE.tooBig, 'Message too large.');
    /** @type {Buffer[]} */ (this.fragments).push(piece);
  }

  /** @param {Buffer} payload */
  deliver(payload) {
    let text;
    try {
      text = this.decoder.decode(payload);
    } catch {
      throw new FrameError(CLOSE.badText, 'Text that is not UTF-8.');
    }
    this.emit('message', text);
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  write(opcode, payload) {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(encodeFrame(opcode, payload));
  }

  /** @param {string} text */
  send(text) {
    if (!this.closeSent && !this.closed) this.write(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  /**
   * Starts the closing handshake. The socket is cut if the other side does not follow.
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE.normal, reason = '') {
    if (this.closed || this.closeSent) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    // A control frame carries at most 125 bytes.
    this.write(OPCODE.close, body.subarray(0, 125));
    this.closeSent = true;
    // Nothing more will be said; the other side answers with its own close and hangs up.
    this.socket.end();
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS);
    this.closeTimer.unref();
    this.finish(code, reason);
  }

  /** Drops the connection without the closing handshake. */
  terminate() {
    this.socket.destroy();
    this.finish(CLOSE.dropped, '');
  }

  /**
   * Pings at an interval and drops the connection when a ping went unanswered: a laptop
   * that slept or a tab that was discarded leaves a socket open that nobody is behind.
   * @param {number} intervalMs
   */
  keepAlive(intervalMs) {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.terminate();
        return;
      }
      this.alive = false;
      this.write(OPCODE.ping, Buffer.alloc(0));
    }, intervalMs);
    this.heartbeat.unref();
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.emit('close', code, reason);
  }
}

/**
 * Completes the handshake for a request that `upgradeProblem` found nothing wrong with.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head Bytes that arrived right behind the request.
 * @param {{ maxPayload: number }} options
 */
export function acceptWebSocket(request, socket, head, options) {
  const key = /** @type {string} */ (request.headers['sec-websocket-key']);
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`].join('\r\n') + '\r\n\r\n');
  const connection = new WebSocketConnection(socket, options);
  if (head.length > 0) connection.receive(head);
  return connection;
}
