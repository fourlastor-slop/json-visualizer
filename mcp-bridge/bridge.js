/**
 * The bridge between an MCP client and JSON Explorer open in a browser tab.
 *
 *   MCP client  ⇄ stdio ⇄  this process  ⇄ ws://127.0.0.1 ⇄  the tab
 *
 * A page cannot listen for connections and an MCP client cannot reach into a browser, so
 * this process listens for both: the client starts it and talks to it over stdio, and the
 * tab connects to it over a loopback WebSocket. The tools themselves live in the tab,
 * which has the data; a call is passed along and its answer passed back.
 *
 * Every MCP client starts its own copy of this program, but there is one port and one
 * tab. The copy that gets the port serves the tab ("primary"); the others ("secondary")
 * connect to it like the tab does and send their calls through it. When the primary
 * exits, one of the others takes the port, and the tab reconnects by itself.
 */
import { createServer } from 'node:http';
import { newNonce, proofOf, sameProof } from './auth.js';
import { DEFAULT_ORIGIN, DEFAULT_PORT, LINK_VERSION } from './defaults.js';
import { McpSession, toolError } from './mcp.js';
import manifest from './package.json' with { type: 'json' };
import bundledTools from './tools.json' with { type: 'json' };
import { CLOSE, acceptWebSocket, refuseUpgrade, upgradeProblem } from './websocket.js';

export const VERSION = manifest.version;

/** Close codes of the link, in the range WebSocket leaves to applications. */
export const LINK_CLOSE = Object.freeze({ malformed: 4400, unauthorized: 4401, slow: 4408, replaced: 4409, version: 4426 });

/** Before pairing a connection may only say hello. */
const MAX_HELLO_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOOLS = 64;

const INSTRUCTIONS = [
  'JSON Explorer is an app in the user’s browser where they keep JSON and JSON Lines files in projects and build charts and tables from JSONata queries on them.',
  'These tools reach the copy that is open in their browser, so they only answer while that tab is open with its MCP switch on.',
  'Begin with list_projects, and look at a file with describe_file before querying it.',
].join(' ');

/**
 * @typedef {import('./mcp.js').Tool} Tool
 * @typedef {import('./mcp.js').ToolResult} ToolResult
 * @typedef {import('./mcp.js').ClientInfo} ClientInfo
 * @typedef {import('./websocket.js').WebSocketConnection} Connection
 */

/**
 * @typedef {object} Timings Delays, in milliseconds. Tests shorten them.
 * @property {number} handshake A connection that has not paired within this is dropped.
 * @property {number} ping Interval of the keep-alive pings.
 * @property {number} pageWait How long a call waits for the tab to connect.
 * @property {number} call How long the tab has to answer a call.
 * @property {number} retry Pause before another attempt to take or share the port.
 */

/** @type {Timings} */
const DEFAULT_TIMINGS = { handshake: 5000, ping: 25_000, pageWait: 8000, call: 120_000, retry: 2000 };

/**
 * @typedef {object} BridgeOptions
 * @property {import('node:stream').Readable} input Where the MCP client writes.
 * @property {import('node:stream').Writable} output Where the MCP client reads.
 * @property {string} token The pairing code shared with the tab.
 * @property {number} [port]
 * @property {string[]} [origins] Origins a tab may be served from.
 * @property {(line: string) => void} [log]
 * @property {() => void} [onClose] Called when the bridge has stopped: its MCP client went away, or it was closed.
 * @property {Partial<Timings>} [timings]
 */

/** @typedef {{ connection: Connection, app: { name: string, origin: string } | null, tools: Tool[] | null, pending: Map<number, (result: unknown) => void> }} Page */
/** @typedef {{ client: ClientInfo | null, calls: Map<number, AbortController> }} Peer */
/** @typedef {{ socket: WebSocket, ready: boolean, tools: Tool[] | null, pending: Map<number, (result: unknown) => void> }} Uplink */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} text */
function parse(text) {
  try {
    const message = JSON.parse(text);
    return isObject(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * The tools a tab announced, if they look like tools.
 * @param {unknown} list
 * @returns {Tool[] | null}
 */
function announcedTools(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TOOLS) return null;
  const sound = list.every((tool) => isObject(tool) && typeof tool.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(tool.name) && isObject(tool.inputSchema));
  return sound ? list : null;
}

/**
 * @param {unknown} result
 * @returns {ToolResult}
 */
function toolResult(result) {
  if (isObject(result) && Array.isArray(result.content)) return /** @type {ToolResult} */ (/** @type {unknown} */ (result));
  return toolError('JSON Explorer gave an answer that is not a tool result.');
}

export class Bridge {
  /** @param {BridgeOptions} options */
  constructor(options) {
    this.token = options.token;
    this.port = options.port ?? DEFAULT_PORT;
    this.origins = options.origins && options.origins.length > 0 ? options.origins : [DEFAULT_ORIGIN];
    this.log = options.log ?? (() => {});
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.closed = false;
    /** @type {'starting' | 'primary' | 'secondary'} */
    this.role = 'starting';
    this.nextCallId = 1;
    /** What `tools/list` last stood for, to tell when it changes. */
    this.toolsSeen = JSON.stringify(bundledTools);

    // As the primary.
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {Set<Connection>} */
    this.connections = new Set();
    /** @type {Page | null} */
    this.page = null;
    /** @type {Map<Connection, Peer>} */
    this.peers = new Map();
    /** Calls waiting for a tab to connect. @type {Set<() => void>} */
    this.pageWaiters = new Set();
    /** A call already waited for a tab that did not come: the next ones need not. */
    this.waitedInVain = false;

    // As a secondary.
    /** @type {Uplink | null} */
    this.uplink = null;
    /** Why the port can be neither taken nor shared, in words for the user. @type {string | null} */
    this.obstacle = null;

    /** Resolves once this copy knows whether it has the port, shares it, or can do neither. */
    this.settled = Promise.resolve();
    this.settle = () => {};
    /** @type {NodeJS.Timeout | undefined} */
    this.retryTimer = undefined;

    this.session = new McpSession({
      input: options.input,
      output: options.output,
      serverInfo: { name: 'json-explorer', title: 'JSON Explorer', version: VERSION },
      instructions: INSTRUCTIONS,
      listTools: () => this.tools(),
      callTool: (name, args, signal) => this.call(name, args, signal, this.session.client?.name),
      onClient: () => this.clientsChanged(),
      onClose: () => {
        this.close();
        options.onClose?.();
      },
    });
    void this.elect();
  }

  // ── Which copy has the port ────────────────────────────────────────────────

  /** Takes the port if it is free; otherwise joins the copy that has it. */
  async elect() {
    if (this.closed) return;
    this.role = 'starting';
    this.settled = /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        this.settle = resolve;
      })
    );
    try {
      await this.listen();
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') return this.join();
      return this.blocked(`The bridge cannot listen on port ${this.port}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Closed while the port was being taken.
    if (this.closed) return void this.server?.close();
    this.role = 'primary';
    this.obstacle = null;
    this.log(`Listening for JSON Explorer on 127.0.0.1:${this.port}.`);
    this.settle();
    this.toolsMayHaveChanged();
  }

  /**
   * The port can be neither taken nor shared for now. Calls are told why; another attempt
   * follows.
   * @param {string} why
   */
  blocked(why) {
    if (this.obstacle !== why) this.log(why);
    this.obstacle = why;
    this.settle();
    this.toolsMayHaveChanged();
    this.retryLater();
  }

  retryLater() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    // Spread out, so that copies that lost their primary together do not collide again.
    this.retryTimer = setTimeout(() => void this.elect(), this.timings.retry * (0.5 + Math.random()));
  }

  /** @returns {Promise<void>} */
  listen() {
    return new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        // Nothing here is for plain HTTP: a web page probing the port learns nothing.
        response.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
        response.end('This is the JSON Explorer MCP bridge. It only speaks WebSocket.\n');
      });
      server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
      server.once('error', reject);
      server.listen({ port: this.port, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', reject);
        server.on('error', (error) => this.log(`Server error: ${error.message}`));
        const address = server.address();
        // Port 0 asks for any free port, which is what tests do.
        if (address && typeof address === 'object') this.port = address.port;
        this.server = server;
        resolve();
      });
    });
  }

  // ── Primary: the tab and the other bridges connect here ────────────────────

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  upgrade(request, socket, head) {
    socket.on('error', () => socket.destroy());
    const problem = upgradeProblem(request);
    if (problem) return refuseUpgrade(socket, ...problem);
    // A page of another site reaching for the port by another name (DNS rebinding) still
    // sends that name as the host.
    const host = String(request.headers.host ?? '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return refuseUpgrade(socket, 403, 'Forbidden');
    // Browsers always say which site a WebSocket is opened from, and a page cannot lie
    // about it. Programs on this machine send no origin; the pairing code decides for them.
    const origin = request.headers.origin;
    if (origin !== undefined && !this.origins.includes(origin)) {
      this.log(`Refused a connection from ${origin}: not one of ${this.origins.join(', ')}.`);
      return refuseUpgrade(socket, 403, 'Forbidden');
    }
    if (request.url !== '/') return refuseUpgrade(socket, 404, 'Not Found');
    this.greet(acceptWebSocket(request, socket, head, { maxPayload: MAX_HELLO_BYTES }), origin ?? null);
  }

  /**
   * Pairing: both sides show they know the pairing code before anything else is said.
   * @param {Connection} connection
   * @param {string | null} origin
   */
  greet(connection, origin) {
    this.connections.add(connection);
    connection.on('close', () => this.connections.delete(connection));
    const serverNonce = newNonce();
    /** @type {{ role: 'page' | 'peer', nonce: string } | null} */
    let hello = null;
    const deadline = setTimeout(() => connection.close(LINK_CLOSE.slow, 'Pairing took too long.'), this.timings.handshake);
    connection.on('close', () => clearTimeout(deadline));

    /** @param {string} text */
    const onMessage = (text) => {
      const message = parse(text);
      if (!message) return connection.close(LINK_CLOSE.malformed, 'Not a JSON object.');
      if (!hello) {
        const { role, nonce } = message;
        if (message.t !== 'hello' || (role !== 'page' && role !== 'peer') || typeof nonce !== 'string' || nonce.length < 16) return connection.close(LINK_CLOSE.malformed, 'Expected a hello.');
        if (message.v !== LINK_VERSION) {
          connection.send(JSON.stringify({ t: 'denied', reason: 'version', v: LINK_VERSION }));
          return connection.close(LINK_CLOSE.version, 'Different versions.');
        }
        hello = { role, nonce };
        return connection.send(JSON.stringify({ t: 'challenge', v: LINK_VERSION, nonce: serverNonce, proof: proofOf(this.token, 'bridge', nonce, serverNonce) }));
      }
      if (message.t !== 'auth' || !sameProof(message.proof, proofOf(this.token, hello.role, hello.nonce, serverNonce))) {
        this.log(`Refused a ${hello.role} with a different pairing code.`);
        connection.send(JSON.stringify({ t: 'denied', reason: 'token' }));
        return connection.close(LINK_CLOSE.unauthorized, 'Different pairing codes.');
      }
      clearTimeout(deadline);
      connection.off('message', onMessage);
      connection.maxPayload = MAX_MESSAGE_BYTES;
      connection.keepAlive(this.timings.ping);
      if (hello.role === 'page') this.adoptPage(connection, message, origin);
      else this.adoptPeer(connection, message);
    };
    connection.on('message', onMessage);
  }

  /**
   * @param {Connection} connection
   * @param {Record<string, unknown>} auth
   * @param {string | null} origin
   */
  adoptPage(connection, auth, origin) {
    if (this.page) {
      // The newest tab wins: the one before may be a tab that died without saying so.
      const previous = this.page;
      this.dropPage(previous, 'Another JSON Explorer tab took over while this call was running.');
      previous.connection.send(JSON.stringify({ t: 'bye', reason: 'replaced' }));
      previous.connection.close(LINK_CLOSE.replaced, 'Another tab connected.');
    }
    const app = isObject(auth.app) && typeof auth.app.name === 'string' ? { name: auth.app.name.slice(0, 80), origin: origin ?? 'a local program' } : null;
    /** @type {Page} */
    const page = { connection, app, tools: announcedTools(auth.tools), pending: new Map() };
    this.page = page;
    this.waitedInVain = false;
    this.log(`JSON Explorer connected${origin ? ` from ${origin}` : ''}.`);

    connection.on('message', (/** @type {string} */ text) => {
      const message = parse(text);
      if (message?.t === 'result' && typeof message.id === 'number') page.pending.get(message.id)?.(message.result);
    });
    connection.on('close', () => {
      if (this.page !== page) return;
      this.dropPage(page, 'The JSON Explorer tab went away while this call was running.');
      this.log('JSON Explorer disconnected.');
      this.pageChanged();
    });
    connection.send(JSON.stringify({ t: 'ready', bridge: { version: VERSION }, clients: this.clients() }));
    this.pageChanged();
  }

  /**
   * @param {Page} page
   * @param {string} why What the calls it was answering are told.
   */
  dropPage(page, why) {
    if (this.page === page) this.page = null;
    for (const settle of [...page.pending.values()]) settle(toolError(why));
  }

  /** The tab came or went: wake the calls waiting for it and tell the other bridges. */
  pageChanged() {
    for (const wake of [...this.pageWaiters]) wake();
    const status = JSON.stringify(this.pageStatus());
    for (const connection of this.peers.keys()) connection.send(status);
    this.toolsMayHaveChanged();
  }

  /** What the other bridges are told about the tab: the tools it announced, if it is there. */
  pageStatus() {
    return { t: 'page', tools: this.page?.tools ?? null };
  }

  /**
   * @param {Connection} connection
   * @param {Record<string, unknown>} auth
   */
  adoptPeer(connection, auth) {
    /** @type {Peer} */
    const peer = { client: null, calls: new Map() };
    this.peers.set(connection, peer);

    /** @param {unknown} client */
    const introduce = (client) => {
      peer.client = isObject(client) && typeof client.name === 'string' ? { name: client.name.slice(0, 80), ...(typeof client.version === 'string' ? { version: client.version.slice(0, 40) } : {}) } : null;
      this.clientsChanged();
    };
    introduce(auth.client);

    connection.on('message', (/** @type {string} */ text) => {
      const message = parse(text);
      if (!message) return;
      const { id } = message;
      if (message.t === 'client') {
        introduce(message.client);
      } else if (message.t === 'cancel' && typeof id === 'number') {
        peer.calls.get(id)?.abort();
      } else if (message.t === 'call' && typeof id === 'number' && typeof message.name === 'string') {
        const controller = new AbortController();
        peer.calls.set(id, controller);
        void this.callPage(message.name, isObject(message.args) ? message.args : {}, controller.signal, peer.client?.name).then((result) => {
          peer.calls.delete(id);
          connection.send(JSON.stringify({ t: 'result', id, result }));
        });
      }
    });
    connection.on('close', () => {
      this.peers.delete(connection);
      for (const controller of peer.calls.values()) controller.abort();
      this.clientsChanged();
    });
    connection.send(JSON.stringify({ t: 'ready', bridge: { version: VERSION } }));
    connection.send(JSON.stringify(this.pageStatus()));
  }

  /** The MCP clients whose calls reach the tab through this copy. */
  clients() {
    const all = [this.session.client, ...[...this.peers.values()].map((peer) => peer.client)];
    return all.filter((client) => client !== null);
  }

  /** A client introduced itself or left: the tab shows who is connected. */
  clientsChanged() {
    if (this.uplink?.ready) this.uplink.socket.send(JSON.stringify({ t: 'client', client: this.session.client }));
    this.page?.connection.send(JSON.stringify({ t: 'clients', clients: this.clients() }));
  }

  /**
   * Passes a call to the tab and waits for its answer. Always resolves: what goes wrong
   * becomes a tool result that says so.
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} signal
   * @param {string | undefined} client
   * @returns {Promise<ToolResult>}
   */
  async callPage(name, args, signal, client) {
    const page = this.page ?? (await this.waitForPage(signal));
    if (signal.aborted) return toolError('The call was cancelled.');
    if (!page) return toolError(this.notConnected());
    const id = this.nextCallId++;
    return new Promise((resolve) => {
      /**
       * @param {unknown} result
       * @param {boolean} abandoned The tab is still working on it and should stop.
       */
      const settle = (result, abandoned) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        page.pending.delete(id);
        if (abandoned) page.connection.send(JSON.stringify({ t: 'cancel', id }));
        resolve(toolResult(result));
      };
      const onAbort = () => settle(toolError('The call was cancelled.'), true);
      const timer = setTimeout(() => settle(toolError(`JSON Explorer did not answer within ${Math.round(this.timings.call / 1000)} seconds.`), true), this.timings.call);
      signal.addEventListener('abort', onAbort, { once: true });
      page.pending.set(id, (result) => settle(result, false));
      page.connection.send(JSON.stringify({ t: 'call', id, name, args, client }));
    });
  }

  /**
   * A tab with its switch on keeps trying to connect, so one that is merely between two
   * attempts shows up within seconds. Waited for once: if no tab came, the calls that
   * follow are told so at once.
   * @param {AbortSignal} signal
   * @returns {Promise<Page | null>}
   */
  waitForPage(signal) {
    if (this.waitedInVain || this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pageWaiters.delete(done);
        signal.removeEventListener('abort', done);
        if (!this.page && !signal.aborted) this.waitedInVain = true;
        resolve(this.page);
      };
      const timer = setTimeout(done, this.timings.pageWait);
      this.pageWaiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  notConnected() {
    return [
      'JSON Explorer is not connected.',
      `Ask the user to open ${this.origins[0]} in their browser, click the plug icon in its top bar ("MCP server") and switch it on. The tab has to stay open.`,
      `If it is on already, check that the port (${this.port}) and the pairing code shown there are the ones this bridge was started with.`,
    ].join(' ');
  }

  // ── Secondary: another copy has the port ───────────────────────────────────

  /** Connects to the copy that has the port, the way a tab does. */
  join() {
    const clientNonce = newNonce();
    /** @type {WebSocket} */
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.port}/`);
    } catch (error) {
      return this.blocked(`The bridge cannot use port ${this.port}: ${error instanceof Error ? error.message : String(error)}`);
    }
    /** @type {Uplink} */
    const uplink = { socket, ready: false, tools: null, pending: new Map() };
    this.uplink = uplink;
    /** The primary proved it knows the pairing code. */
    let trusted = false;
    // What answers on the port, unless it turns out to be a bridge.
    let refusal = `Port ${this.port} is in use by another program. Start the bridge with --port and set the same port in JSON Explorer.`;
    const deadline = setTimeout(() => socket.close(), this.timings.handshake);

    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'hello', v: LINK_VERSION, role: 'peer', nonce: clientNonce })));
    socket.addEventListener('message', (event) => {
      const message = typeof event.data === 'string' ? parse(event.data) : null;
      if (!message) return;
      const { id } = message;
      if (!trusted) {
        if (message.t === 'denied' && message.reason === 'version') {
          refusal = `Port ${this.port} is held by another version of this bridge. Use the same version for every MCP client.`;
          return socket.close();
        }
        if (message.t !== 'challenge' || typeof message.nonce !== 'string' || !sameProof(message.proof, proofOf(this.token, 'bridge', clientNonce, message.nonce))) {
          refusal = `Port ${this.port} is held by a JSON Explorer bridge that was started with a different pairing code.`;
          return socket.close();
        }
        trusted = true;
        return socket.send(JSON.stringify({ t: 'auth', proof: proofOf(this.token, 'peer', clientNonce, message.nonce), client: this.session.client }));
      }
      if (message.t === 'ready') {
        clearTimeout(deadline);
        uplink.ready = true;
        this.role = 'secondary';
        this.obstacle = null;
        this.log(`Sharing port ${this.port} with the bridge of another MCP client.`);
        this.settle();
      } else if (message.t === 'page') {
        uplink.tools = announcedTools(message.tools);
        this.toolsMayHaveChanged();
      } else if (message.t === 'result' && typeof id === 'number') {
        uplink.pending.get(id)?.(message.result);
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(deadline);
      if (this.uplink === uplink) this.uplink = null;
      for (const settle of [...uplink.pending.values()]) settle(toolError('The connection to JSON Explorer was lost while this call was running. Try again.'));
      if (this.closed) return;
      // The copy that had the port is gone: take it, or join whichever copy does first.
      if (uplink.ready) void this.elect();
      else this.blocked(refusal);
    });
    // A failed connection also closes; the close handler deals with it.
    socket.addEventListener('error', () => {});
  }

  /**
   * @param {Uplink} uplink
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} signal
   * @returns {Promise<ToolResult>}
   */
  callThrough(uplink, name, args, signal) {
    const id = this.nextCallId++;
    return new Promise((resolve) => {
      /** @param {unknown} result */
      const settle = (result) => {
        signal.removeEventListener('abort', onAbort);
        uplink.pending.delete(id);
        resolve(toolResult(result));
      };
      const onAbort = () => {
        if (uplink.socket.readyState === WebSocket.OPEN) uplink.socket.send(JSON.stringify({ t: 'cancel', id }));
        settle(toolError('The call was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      uplink.pending.set(id, settle);
      uplink.socket.send(JSON.stringify({ t: 'call', id, name, args }));
    });
  }

  // ── What the MCP client sees ───────────────────────────────────────────────

  /**
   * The tools of the tab, as it announced them. Before a tab has connected, the list this
   * bridge was built with stands in, so that a client that reads the list once, at
   * startup, still finds the tools.
   * @returns {Tool[]}
   */
  tools() {
    const announced = this.role === 'secondary' ? this.uplink?.tools : this.page?.tools;
    return announced ?? /** @type {Tool[]} */ (bundledTools);
  }

  toolsMayHaveChanged() {
    if (this.closed) return;
    const now = JSON.stringify(this.tools());
    if (now === this.toolsSeen) return;
    this.toolsSeen = now;
    this.session.toolsChanged();
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} signal
   * @param {string | undefined} client
   * @returns {Promise<ToolResult>}
   */
  async call(name, args, signal, client) {
    await this.settled;
    if (this.role === 'primary') return this.callPage(name, args, signal, client);
    if (this.uplink?.ready) return this.callThrough(this.uplink, name, args, signal);
    return toolError(this.obstacle ?? 'The bridge is restarting. Try again in a moment.');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    for (const wake of [...this.pageWaiters]) wake();
    this.uplink?.socket.close();
    for (const connection of [...this.connections]) connection.close(CLOSE.goingAway, 'The bridge is stopping.');
    this.server?.close();
    this.session.close();
  }
}

/** @param {BridgeOptions} options */
export function startBridge(options) {
  return new Bridge(options);
}
