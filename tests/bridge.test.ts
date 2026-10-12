import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { newNonce, proofOf } from '../mcp-bridge/auth.js';
import { type Bridge, startBridge } from '../mcp-bridge/bridge.js';
import { LINK_VERSION } from '../mcp-bridge/defaults.js';
import { PROTOCOL_VERSIONS } from '../mcp-bridge/mcp.js';
import bundledTools from '../mcp-bridge/tools.json';
import { FrameError, FrameParser, OPCODE, encodeFrame } from '../mcp-bridge/websocket.js';

const TOKEN = 'a-pairing-code-for-the-tests-0123456789';
const ORIGIN = 'https://explorer.test';
/** Short enough for tests to see the timeouts happen. */
const TIMINGS = { handshake: 400, ping: 10_000, pageWait: 80, call: 400, retry: 30 };

type Json = Record<string, any>;

const until = async (condition: () => boolean, what: string, ms = 2000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** What an MCP client does: writes requests on one pipe, reads answers from the other. */
function mcpClient() {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map<number, (message: Json) => void>();
  const notifications: Json[] = [];
  const stray: Json[] = [];
  let buffer = '';
  let nextId = 1;
  output.on('data', (chunk) => {
    buffer += String(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as Json;
      buffer = buffer.slice(end + 1);
      if (waiting.has(message.id)) waiting.get(message.id)!(message);
      else if ('id' in message) stray.push(message);
      else notifications.push(message);
    }
  });
  const send = (message: unknown) => input.write(typeof message === 'string' ? message : JSON.stringify(message) + '\n');
  const request = (method: string, params?: Json) => {
    const id = nextId++;
    const answer = new Promise<Json>((resolve) => waiting.set(id, resolve));
    send({ jsonrpc: '2.0', id, method, params });
    return Object.assign(answer, { id });
  };
  const notify = (method: string, params?: Json) => send({ jsonrpc: '2.0', method, params });
  /** The handshake every client opens with. */
  const initialize = async (name = 'test-client') => {
    const answer = await request('initialize', { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name, version: '1.0' } });
    notify('notifications/initialized');
    return answer;
  };
  return { input, output, send, request, notify, initialize, notifications, stray };
}

interface PageOptions {
  origin?: string | null;
  token?: string;
  role?: 'page' | 'peer';
  version?: number;
  tools?: unknown;
  /** What the tab answers to a call; by default it echoes the call back. */
  answer?: (call: Json) => unknown;
}

/** What the tab does: connects, pairs, and answers the calls it is sent. */
class FakePage {
  readonly received: Json[] = [];
  readonly calls: Json[] = [];
  /** The proof the bridge gave of knowing the pairing code, and what it should have been. */
  bridgeProof: { given: string; expected: string } | null = null;
  closeCode: number | null = null;
  private socket: WebSocket;

  constructor(port: number, options: PageOptions = {}) {
    const { origin = ORIGIN, token = TOKEN, role = 'page', version = LINK_VERSION, tools, answer = (call) => ({ content: [{ type: 'text', text: JSON.stringify({ name: call.name, args: call.args }) }] }) } = options;
    const clientNonce = newNonce();
    // Node's WebSocket takes request headers, which is how a test can pose as a page of a site.
    const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    this.socket = new Socket(`ws://127.0.0.1:${port}/`, { headers: origin === null ? {} : { Origin: origin } });
    this.socket.addEventListener('open', () => this.send({ t: 'hello', v: version, role, nonce: clientNonce }));
    this.socket.addEventListener('close', (event) => {
      this.closeCode = event.code;
    });
    this.socket.addEventListener('error', () => {});
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Json;
      this.received.push(message);
      if (message.t === 'challenge') {
        this.bridgeProof = { given: message.proof, expected: proofOf(TOKEN, 'bridge', clientNonce, message.nonce) };
        this.send({ t: 'auth', proof: proofOf(token, role, clientNonce, message.nonce), app: { name: 'JSON Explorer' }, tools, client: { name: 'peer-client' } });
      } else if (message.t === 'call') {
        this.calls.push(message);
        void Promise.resolve(answer(message)).then((result) => result !== undefined && this.send({ t: 'result', id: message.id, result }));
      }
    });
  }

  send(message: Json): void {
    this.socket.send(JSON.stringify(message));
  }

  has(type: string): boolean {
    return this.received.some((message) => message.t === type);
  }

  last(type: string): Json | undefined {
    return this.received.findLast((message) => message.t === type);
  }

  async ready(): Promise<this> {
    await until(() => this.has('ready') || this.closeCode !== null, 'the page to be paired');
    if (!this.has('ready')) throw new Error(`The page was turned away (close code ${this.closeCode})`);
    return this;
  }

  async closed(): Promise<number> {
    await until(() => this.closeCode !== null, 'the page to be disconnected');
    return this.closeCode!;
  }

  close(): void {
    this.socket.close();
  }
}

const open: Array<{ close(): void }> = [];

afterEach(() => {
  for (const thing of open.splice(0)) thing.close();
});

/** A bridge with an MCP client attached, on a port of its own unless one is given. */
async function start(options: { port?: number; origins?: string[]; timings?: Partial<typeof TIMINGS>; name?: string } = {}) {
  const client = mcpClient();
  const log: string[] = [];
  const bridge: Bridge = startBridge({
    input: client.input,
    output: client.output,
    token: TOKEN,
    port: options.port ?? 0,
    origins: options.origins ?? [ORIGIN],
    timings: { ...TIMINGS, ...options.timings },
    log: (line) => log.push(line),
  });
  open.push(bridge);
  await bridge.settled;
  await client.initialize(options.name);
  return { bridge, client, log };
}

async function page(port: number, options?: PageOptions): Promise<FakePage> {
  const fake = new FakePage(port, options);
  open.push(fake);
  return fake.ready();
}

const textOf = (answer: Json): string => answer.result.content[0].text;

// ── WebSocket frames ─────────────────────────────────────────────────────────

/** A frame as a browser sends it: masked. */
function clientFrame(opcode: number, payload: Buffer | string, { fin = true, masked = true } = {}): Buffer {
  const body = Buffer.from(payload);
  const first = (fin ? 0x80 : 0) | opcode;
  const flag = masked ? 0x80 : 0;
  let head: Buffer;
  if (body.length < 126) {
    head = Buffer.from([first, flag | body.length]);
  } else if (body.length < 0x10000) {
    head = Buffer.alloc(4);
    head.writeUInt16BE(body.length, 2);
    head[0] = first;
    head[1] = flag | 126;
  } else {
    head = Buffer.alloc(10);
    head.writeBigUInt64BE(BigInt(body.length), 2);
    head[0] = first;
    head[1] = flag | 127;
  }
  if (!masked) return Buffer.concat([head, body]);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  return Buffer.concat([head, mask, body.map((byte, i) => byte ^ mask[i & 3]!)]);
}

/** The frames in bytes a server sent, which are not masked. */
function serverFrames(bytes: Buffer): Array<{ opcode: number; payload: Buffer }> {
  const frames = [];
  let at = 0;
  while (at + 2 <= bytes.length) {
    let length = bytes[at + 1]! & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at + 2);
      offset = at + 4;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(at + 2));
      offset = at + 10;
    }
    if (offset + length > bytes.length) break;
    frames.push({ opcode: bytes[at]! & 0x0f, payload: bytes.subarray(offset, offset + length) });
    at = offset + length;
  }
  return frames;
}

describe('WebSocket frames', () => {
  it.each([0, 1, 125, 126, 65_535, 65_536, 300_000])('carry a message of %i bytes, whichever way the length is written', (size) => {
    const text = 'é'.repeat(Math.floor(size / 2)) + 'x'.repeat(size % 2);
    const [frame] = new FrameParser(1_000_000).push(clientFrame(OPCODE.text, text));
    expect(frame).toMatchObject({ fin: true, opcode: OPCODE.text });
    expect(frame!.payload.toString()).toBe(text);
    // And what the server writes can be read back.
    const [sent] = serverFrames(encodeFrame(OPCODE.text, Buffer.from(text)));
    expect(sent!.payload.toString()).toBe(text);
  });

  it('are put together from bytes that arrive in any pieces', () => {
    const bytes = Buffer.concat([clientFrame(OPCODE.text, 'first'), clientFrame(OPCODE.ping, ''), clientFrame(OPCODE.text, 'y'.repeat(70_000))]);
    const parser = new FrameParser(1_000_000);
    const frames = [];
    for (let at = 0; at < bytes.length; at += 7) frames.push(...parser.push(bytes.subarray(at, at + 7)));
    expect(frames.map((frame) => [frame.opcode, frame.payload.length])).toEqual([
      [OPCODE.text, 5],
      [OPCODE.ping, 0],
      [OPCODE.text, 70_000],
    ]);
  });

  it('are refused when they break the protocol', () => {
    const refusal = (bytes: Buffer, maxPayload = 1000) => {
      try {
        new FrameParser(maxPayload).push(bytes);
      } catch (error) {
        return (error as FrameError).code;
      }
      return null;
    };
    expect(refusal(clientFrame(OPCODE.text, 'hello'))).toBeNull();
    expect(refusal(clientFrame(OPCODE.text, 'not masked', { masked: false }))).toBe(1002);
    expect(refusal(clientFrame(OPCODE.ping, 'p'.repeat(126)))).toBe(1002);
    expect(refusal(clientFrame(OPCODE.ping, 'split', { fin: false }))).toBe(1002);
    expect(refusal(clientFrame(OPCODE.text, 'x'.repeat(1001)))).toBe(1009);
    const reserved = clientFrame(OPCODE.text, 'compressed?');
    reserved[0]! |= 0x40;
    expect(refusal(reserved)).toBe(1002);
    // A length that claims far more than is allowed is refused before any of it arrives.
    expect(refusal(clientFrame(OPCODE.text, 'x'.repeat(70_000)).subarray(0, 10))).toBe(1009);
  });
});

/** A WebSocket client reduced to a socket, to send what a browser never would. */
async function rawSocket(port: number, headers: Record<string, string> = {}) {
  const socket = connect(port, '127.0.0.1');
  let bytes = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
  });
  socket.on('error', () => {});
  open.push({ close: () => socket.destroy() });
  const request = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers };
  socket.write(`GET / HTTP/1.1\r\n${Object.entries(request).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
  await until(() => bytes.includes('\r\n\r\n'), 'the answer to the upgrade request');
  const end = bytes.indexOf('\r\n\r\n') + 4;
  const head = bytes.subarray(0, end).toString();
  return { socket, status: Number(head.split(' ')[1]), head, frames: () => serverFrames(bytes.subarray(end)) };
}

describe('the bridge as a WebSocket server', () => {
  it('completes the handshake and reads a message sent in fragments', async () => {
    const { bridge } = await start();
    const raw = await rawSocket(bridge.port);
    expect(raw.status).toBe(101);
    // The accept key for the sample key of RFC 6455.
    expect(raw.head).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

    const hello = JSON.stringify({ t: 'hello', v: LINK_VERSION, role: 'page', nonce: newNonce() });
    raw.socket.write(clientFrame(OPCODE.text, hello.slice(0, 10), { fin: false }));
    raw.socket.write(clientFrame(OPCODE.ping, 'still there?'));
    raw.socket.write(clientFrame(OPCODE.continuation, hello.slice(10)));
    await until(() => raw.frames().length >= 2, 'the pong and the challenge');
    const [pong, challenge] = raw.frames();
    expect([pong!.opcode, pong!.payload.toString()]).toEqual([OPCODE.pong, 'still there?']);
    expect(JSON.parse(challenge!.payload.toString())).toMatchObject({ t: 'challenge', v: LINK_VERSION });
  });

  it('closes on what it does not understand, saying why', async () => {
    const { bridge } = await start();
    const closeCode = async (...frames: Buffer[]) => {
      const raw = await rawSocket(bridge.port);
      for (const frame of frames) raw.socket.write(frame);
      await until(() => raw.frames().some((frame) => frame.opcode === OPCODE.close), 'a close frame');
      return raw.frames().find((frame) => frame.opcode === OPCODE.close)!.payload.readUInt16BE(0);
    };
    expect(await closeCode(clientFrame(OPCODE.binary, 'bytes'))).toBe(1003);
    expect(await closeCode(clientFrame(OPCODE.text, Buffer.from([0xff, 0xfe])))).toBe(1007);
    expect(await closeCode(clientFrame(OPCODE.continuation, 'of nothing'))).toBe(1002);
    expect(await closeCode(clientFrame(OPCODE.text, 'not json'))).toBe(4400);
    expect(await closeCode(clientFrame(OPCODE.text, JSON.stringify({ t: 'call', id: 1 })))).toBe(4400);
    // Nobody may send megabytes before pairing.
    expect(await closeCode(clientFrame(OPCODE.text, 'x'.repeat(300_000)))).toBe(1009);
    // Silence is not tolerated for long either.
    expect(await closeCode()).toBe(4408);
  });

  it('turns away requests that a page of another site could make', async () => {
    const { bridge, log } = await start();
    expect((await rawSocket(bridge.port, { Origin: 'https://elsewhere.test' })).status).toBe(403);
    expect(log.join('\n')).toContain('https://elsewhere.test');
    // The port reached under another name: DNS rebinding.
    expect((await rawSocket(bridge.port, { Host: `evil.test:${bridge.port}` })).status).toBe(403);
    expect((await rawSocket(bridge.port, { 'Sec-WebSocket-Version': '8' })).status).toBe(426);
    const plain = await fetch(`http://127.0.0.1:${bridge.port}/`);
    expect(plain.status).toBe(426);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ── The MCP side ─────────────────────────────────────────────────────────────

describe('the bridge as an MCP server', () => {
  it('introduces itself and settles on a protocol revision', async () => {
    const client = mcpClient();
    const bridge = startBridge({ input: client.input, output: client.output, token: TOKEN, port: 0, timings: TIMINGS });
    open.push(bridge);
    const answer = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old-client', version: '0.1' } });
    expect(answer.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'json-explorer', title: 'JSON Explorer' },
    });
    expect(answer.result.instructions).toContain('list_projects');
    // A revision from the future is answered with the newest one this server knows.
    const future = await client.request('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'new-client' } });
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect((await client.request('ping')).result).toEqual({});
  });

  it('lists the tools it was built with before any tab has connected', async () => {
    const { client } = await start();
    const { tools } = (await client.request('tools/list')).result;
    expect(tools).toEqual(bundledTools);
    expect(tools.map((tool: Json) => tool.name)).toEqual(['list_projects', 'describe_file', 'run_query', 'get_visualization', 'create_visualization']);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('answers malformed and unknown requests with JSON-RPC errors', async () => {
    const { client } = await start();
    expect((await client.request('resources/list')).error).toMatchObject({ code: -32601 });
    expect((await client.request('tools/call', { name: 'drop_everything', arguments: {} })).error).toMatchObject({ code: -32602 });
    expect((await client.request('tools/call', { name: 'run_query', arguments: [1, 2] })).error).toMatchObject({ code: -32602 });
    client.send('{ this is not json\n');
    client.send('[{"jsonrpc":"2.0","id":7,"method":"ping"}]\n');
    await until(() => client.stray.length === 2, 'two errors without an id');
    expect(client.stray.map((message) => [message.id, message.error.code])).toEqual([
      [null, -32700],
      [null, -32600],
    ]);
  });

  it('says how to connect when no tab is there, after waiting for one once', async () => {
    const { client, bridge } = await start({ timings: { pageWait: 400 } });
    let started = Date.now();
    const first = await client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(first.result.isError).toBe(true);
    expect(textOf(first)).toContain(`Ask the user to open ${ORIGIN}`);
    expect(textOf(first)).toContain(String(bridge.port));
    // It did not come, so the next call does not wait again.
    started = Date.now();
    expect((await client.request('tools/call', { name: 'list_projects', arguments: {} })).result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('stops when its client goes away', async () => {
    const { client, bridge } = await start();
    const tab = await page(bridge.port);
    client.input.end();
    expect(await tab.closed()).toBe(1001);
    expect(bridge.closed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${bridge.port}/`)).rejects.toThrow();
  });
});

// ── Pairing ──────────────────────────────────────────────────────────────────

describe('pairing', () => {
  it('has both sides prove they know the pairing code', async () => {
    const { bridge, log } = await start();
    const tab = await page(bridge.port);
    expect(tab.bridgeProof!.given).toBe(tab.bridgeProof!.expected);
    expect(tab.last('ready')).toMatchObject({ bridge: { version: expect.any(String) }, clients: [{ name: 'test-client', version: '1.0' }] });
    expect(log.join('\n')).toContain(`JSON Explorer connected from ${ORIGIN}`);
    // The code itself is never sent, in either direction.
    expect(JSON.stringify(tab.received)).not.toContain(TOKEN);
  });

  it('turns away a tab with another pairing code', async () => {
    const { bridge, client } = await start();
    const stranger = new FakePage(bridge.port, { token: 'some-other-pairing-code-0123456789' });
    open.push(stranger);
    expect(await stranger.closed()).toBe(4401);
    expect(stranger.last('denied')).toEqual({ t: 'denied', reason: 'token' });
    expect(bridge.page).toBeNull();
    expect((await client.request('tools/call', { name: 'list_projects', arguments: {} })).result.isError).toBe(true);
  });

  it('turns away a tab that speaks another version of the link', async () => {
    const { bridge } = await start();
    const newer = new FakePage(bridge.port, { version: LINK_VERSION + 1 });
    open.push(newer);
    expect(await newer.closed()).toBe(4426);
    expect(newer.last('denied')).toEqual({ t: 'denied', reason: 'version', v: LINK_VERSION });
  });

  it('lets the newest tab replace the one before', async () => {
    const { bridge, client } = await start();
    const first = await page(bridge.port, { answer: () => undefined });
    const inFlight = client.request('tools/call', { name: 'list_projects', arguments: {} });
    await until(() => first.calls.length === 1, 'the call to reach the first tab');
    const second = await page(bridge.port);
    expect(await first.closed()).toBe(4409);
    expect(first.last('bye')).toEqual({ t: 'bye', reason: 'replaced' });
    expect(textOf(await inFlight)).toContain('Another JSON Explorer tab took over');
    await client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(second.calls).toHaveLength(1);
  });
});

// ── Calls ────────────────────────────────────────────────────────────────────

describe('tool calls', () => {
  it('go to the tab and come back', async () => {
    const { bridge, client } = await start({ name: 'Claude Code' });
    const tab = await page(bridge.port);
    const answer = await client.request('tools/call', { name: 'run_query', arguments: { file_ids: ['f1'], query: '$count($)' } });
    expect(answer.result.isError).toBeUndefined();
    expect(JSON.parse(textOf(answer))).toEqual({ name: 'run_query', args: { file_ids: ['f1'], query: '$count($)' } });
    expect(tab.calls[0]).toMatchObject({ t: 'call', name: 'run_query', client: 'Claude Code' });
  });

  it('wait for a tab that is about to connect', async () => {
    const { bridge, client } = await start({ timings: { pageWait: 1500 } });
    const pending = client.request('tools/call', { name: 'list_projects', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await page(bridge.port);
    expect((await pending).result.isError).toBeUndefined();
  });

  it('carry large results', async () => {
    const { bridge, client } = await start();
    const big = 'é'.repeat(700_000);
    await page(bridge.port, { answer: () => ({ content: [{ type: 'text', text: big }] }) });
    expect(textOf(await client.request('tools/call', { name: 'list_projects', arguments: {} }))).toBe(big);
  });

  it('follow the tools the tab announces, and tell the client when they change', async () => {
    const { bridge, client } = await start();
    const announced = [{ name: 'only_tool', description: 'The one tool of a newer page.', inputSchema: { type: 'object' } }];
    const tab = await page(bridge.port, { tools: announced });
    await until(() => client.notifications.length === 1, 'a notification');
    expect(client.notifications[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect((await client.request('tools/list')).result.tools).toEqual(announced);
    expect((await client.request('tools/call', { name: 'only_tool', arguments: {} })).result.isError).toBeUndefined();
    expect((await client.request('tools/call', { name: 'run_query', arguments: {} })).error).toMatchObject({ code: -32602 });

    tab.close();
    await until(() => client.notifications.length === 2, 'a second notification');
    expect((await client.request('tools/list')).result.tools).toEqual(bundledTools);
  });

  it('say nothing of a list that did not change', async () => {
    const { bridge, client } = await start();
    const tab = await page(bridge.port, { tools: bundledTools });
    tab.close();
    await tab.closed();
    await until(() => bridge.page === null, 'the bridge to notice');
    expect(client.notifications).toEqual([]);
  });

  it('fail when the tab goes away or does not answer in time', async () => {
    const { bridge, client } = await start();
    const silent = await page(bridge.port, { answer: () => undefined });
    const slow = await client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(textOf(slow)).toContain('did not answer within');
    await until(() => silent.has('cancel'), 'the tab to be told to stop');
    expect(silent.last('cancel')).toEqual({ t: 'cancel', id: silent.calls[0]!.id });

    const lost = client.request('tools/call', { name: 'list_projects', arguments: {} });
    await until(() => silent.calls.length === 2, 'the second call');
    silent.close();
    expect(textOf(await lost)).toContain('went away');
  });

  it('can be cancelled by the client, which then gets no answer', async () => {
    const { bridge, client } = await start({ timings: { call: 5000 } });
    const tab = await page(bridge.port, { answer: () => undefined });
    const call = client.request('tools/call', { name: 'list_projects', arguments: {} });
    let answered = false;
    void call.then(() => (answered = true));
    await until(() => tab.calls.length === 1, 'the call to reach the tab');
    client.notify('notifications/cancelled', { requestId: call.id, reason: 'The user pressed stop.' });
    await until(() => tab.has('cancel'), 'the tab to be told');
    // A late answer from the tab changes nothing.
    tab.send({ t: 'result', id: tab.calls[0]!.id, result: { content: [] } });
    expect((await client.request('ping')).result).toEqual({});
    expect(answered).toBe(false);
  });

  it('do not trust an answer that is not a tool result', async () => {
    const { bridge, client } = await start();
    await page(bridge.port, { answer: () => 'just a string' });
    const answer = await client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(answer.result).toMatchObject({ isError: true });
  });
});

// ── Several MCP clients ──────────────────────────────────────────────────────

describe('several bridges on one port', () => {
  it('share the tab: the first has the port, the others call through it', async () => {
    const first = await start({ name: 'Claude Desktop' });
    const second = await start({ port: first.bridge.port, name: 'Claude Code' });
    expect([first.bridge.role, second.bridge.role]).toEqual(['primary', 'secondary']);

    const announced = [{ name: 'only_tool', inputSchema: { type: 'object' } }];
    const tab = await page(first.bridge.port, { tools: announced });
    expect(tab.last('ready')!.clients).toEqual([
      { name: 'Claude Desktop', version: '1.0' },
      { name: 'Claude Code', version: '1.0' },
    ]);
    // The second client learns of the tab's tools too.
    await until(() => second.client.notifications.length === 1, 'the second client to be notified');
    expect((await second.client.request('tools/list')).result.tools).toEqual(announced);

    const answer = await second.client.request('tools/call', { name: 'only_tool', arguments: { n: 1 } });
    expect(JSON.parse(textOf(answer))).toEqual({ name: 'only_tool', args: { n: 1 } });
    expect(tab.calls[0]).toMatchObject({ client: 'Claude Code' });
    await first.client.request('tools/call', { name: 'only_tool', arguments: {} });
    expect(tab.calls[1]).toMatchObject({ client: 'Claude Desktop' });

    // A client that leaves is no longer listed.
    second.bridge.close();
    await until(() => tab.last('clients')?.clients.length === 1, 'the tab to be told');
    expect(tab.last('clients')!.clients).toEqual([{ name: 'Claude Desktop', version: '1.0' }]);
  });

  it('hand the port over when the one that has it exits', async () => {
    const first = await start();
    const second = await start({ port: first.bridge.port });
    const third = await start({ port: first.bridge.port });
    const port = first.bridge.port;
    await page(port);

    first.bridge.close();
    await until(() => [second.bridge.role, third.bridge.role].sort().join() === 'primary,secondary', 'the others to settle again');
    // The tab reconnects by itself, to whichever copy has the port now.
    const tab = await page(port);
    for (const { client } of [second, third]) {
      const answer = await client.request('tools/call', { name: 'list_projects', arguments: {} });
      expect(answer.result.isError).toBeUndefined();
    }
    expect(tab.calls).toHaveLength(2);
  });

  it('cancel the calls of a client through the bridge that has the port', async () => {
    const first = await start({ timings: { call: 5000 } });
    const second = await start({ port: first.bridge.port, timings: { call: 5000 } });
    const tab = await page(first.bridge.port, { answer: () => undefined });
    const call = second.client.request('tools/call', { name: 'list_projects', arguments: {} });
    await until(() => tab.calls.length === 1, 'the call to reach the tab');
    second.client.notify('notifications/cancelled', { requestId: call.id });
    await until(() => tab.has('cancel'), 'the tab to be told');
  });

  it('explain themselves when the port belongs to something else', async () => {
    // Another program altogether.
    const other = createServer((_request, response) => response.end('hello'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    open.push({ close: () => other.close() });
    const port = (other.address() as { port: number }).port;
    const blocked = await start({ port });
    const answer = await blocked.client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(textOf(answer)).toContain(`Port ${port} is in use by another program`);
    expect(blocked.log.join('\n')).toContain('in use by another program');

    // A bridge that was started with another pairing code.
    const client = mcpClient();
    const stranger = startBridge({ input: client.input, output: client.output, token: 'some-other-pairing-code-0123456789', port: 0, timings: TIMINGS });
    open.push(stranger);
    await stranger.settled;
    const mismatched = await start({ port: stranger.port });
    expect(textOf(await mismatched.client.request('tools/call', { name: 'list_projects', arguments: {} }))).toContain('different pairing code');
  });

  it('take the port once it is free', async () => {
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as { port: number }).port;
    const { bridge, client } = await start({ port });
    expect(bridge.role).toBe('starting');
    other.close();
    await until(() => bridge.role === 'primary', 'the bridge to take the port');
    await page(port);
    expect((await client.request('tools/call', { name: 'list_projects', arguments: {} })).result.isError).toBeUndefined();
  });
});
