/**
 * The Model Context Protocol, server side, over standard input and output: one JSON-RPC
 * message per line. Only what a server that offers tools needs.
 */

/** Protocol revisions this server can speak, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A line longer than this is not a message: stop buffering it. */
const MAX_LINE_LENGTH = 64 * 1024 * 1024;

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} [title]
 * @property {string} [description]
 * @property {Record<string, unknown>} inputSchema
 * @property {Record<string, unknown>} [annotations]
 */

/**
 * @typedef {object} ToolResult
 * @property {Array<{ type: string, text?: string }>} content
 * @property {boolean} [isError]
 */

/**
 * @typedef {object} ClientInfo
 * @property {string} name
 * @property {string} [version]
 */

/**
 * @typedef {object} SessionOptions
 * @property {import('node:stream').Readable} input
 * @property {import('node:stream').Writable} output
 * @property {{ name: string, title: string, version: string }} serverInfo
 * @property {string} instructions
 * @property {() => Tool[]} listTools
 * @property {(name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>} callTool
 * @property {(client: ClientInfo | null) => void} [onClient] Called when the client has introduced itself.
 * @property {() => void} [onClose] Called when the client is gone.
 */

/** An error that is reported to the client as it is. */
export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A tool result that says something went wrong, in words the model can act on. */
export function toolError(/** @type {string} */ text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} info
 * @returns {ClientInfo | null}
 */
function clientInfo(info) {
  if (!isObject(info) || typeof info.name !== 'string') return null;
  // `title` is the name meant for people, where the client gives one.
  const name = typeof info.title === 'string' && info.title !== '' ? info.title : info.name;
  return { name: name.slice(0, 80), ...(typeof info.version === 'string' ? { version: info.version.slice(0, 40) } : {}) };
}

export class McpSession {
  /** @param {SessionOptions} options */
  constructor(options) {
    this.options = options;
    this.buffer = '';
    this.closed = false;
    /** Set once the client has said it is ready for notifications. */
    this.initialized = false;
    /** @type {ClientInfo | null} */
    this.client = null;
    /** Requests being answered, so that the client can cancel them. @type {Map<string | number, AbortController>} */
    this.inflight = new Map();

    const { input, output } = options;
    input.setEncoding('utf8');
    input.on('data', (chunk) => this.receive(String(chunk)));
    input.on('end', () => this.close());
    input.on('close', () => this.close());
    input.on('error', () => this.close());
    // The client went away mid-write.
    output.on('error', () => this.close());
  }

  /** @param {string} chunk */
  receive(chunk) {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (line !== '') this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.buffer = '';
      this.fail(null, PARSE_ERROR, 'Message too long.');
    }
  }

  /** @param {string} line */
  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(null, PARSE_ERROR, 'Not JSON.');
      return;
    }
    if (!isObject(message)) {
      // Batches were part of one protocol revision only, and no client sends them here.
      this.fail(null, INVALID_REQUEST, 'Expected a single JSON-RPC message.');
      return;
    }
    const { id, method, params } = message;
    if (typeof method !== 'string') return; // An answer to something this server never asked.
    const given = isObject(params) ? params : {};
    if (typeof id === 'string' || typeof id === 'number') void this.answer(id, method, given);
    else this.notified(method, given);
  }

  /**
   * @param {string | number} id
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  async answer(id, method, params) {
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      const result = await this.request(method, params, controller.signal);
      // A cancelled request gets no answer: the client has stopped waiting for one.
      if (!controller.signal.aborted) this.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (error instanceof RpcError) this.fail(id, error.code, error.message);
      else this.fail(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {AbortSignal} signal
   * @returns {Promise<unknown>}
   */
  async request(method, params, signal) {
    const { serverInfo, instructions, listTools, callTool, onClient } = this.options;
    switch (method) {
      case 'initialize': {
        // The client's revision if this server speaks it; otherwise the newest it does
        // speak, and the client decides whether it can work with that.
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        this.client = clientInfo(params.clientInfo);
        onClient?.(this.client);
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo,
          instructions,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: listTools() };
      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'A tool name is required.');
        if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'Tool arguments must be an object.');
        if (!listTools().some((tool) => tool.name === name)) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
        return callTool(name, args, signal);
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  notified(method, params) {
    if (method === 'notifications/initialized') {
      this.initialized = true;
    } else if (method === 'notifications/cancelled') {
      const { requestId } = params;
      if (typeof requestId === 'string' || typeof requestId === 'number') this.inflight.get(requestId)?.abort();
    }
  }

  /** Tells the client that `tools/list` would now answer differently. */
  toolsChanged() {
    if (this.initialized) this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  /**
   * @param {string | number | null} id
   * @param {number} code
   * @param {string} message
   */
  fail(id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** @param {Record<string, unknown>} message */
  send(message) {
    if (!this.closed && this.options.output.writable) this.options.output.write(JSON.stringify(message) + '\n');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.options.onClose?.();
  }
}
