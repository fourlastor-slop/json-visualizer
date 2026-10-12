/**
 * The page's end of the connection to the bridge: reaching it, pairing with it, answering
 * the calls it passes on, and reaching it again when it has gone. The bridge runs only
 * while an MCP client does, so most of the time there is nothing to reach, and that is
 * not an error.
 */
import { LINK_VERSION } from '../../mcp-bridge/defaults.js';
import { type BridgeMessage, type ClientInfo, type ToolDefinition, type ToolResult, newNonce, proofOf } from './protocol';

export type LinkPhase =
  /** The first attempt is under way. */
  | 'connecting'
  /** Nothing answers on the port. */
  | 'waiting'
  | 'connected'
  /** Something answers, but it is not a bridge that knows the pairing code. */
  | 'rejected'
  /** The bridge and the page speak different versions of the link. */
  | 'outdated'
  /** Another tab or browser connected with the same pairing code. */
  | 'replaced'
  /** The browser asks its user before letting this site reach the computer, and has no answer. */
  | 'unanswered'
  /** The answer was no. */
  | 'forbidden'
  /** The browser does not allow the connection to be made at all, or the page to pair. */
  | 'blocked';

/**
 * The browser's permission for this site to connect to the computer it runs on: the part
 * of a PermissionStatus that is used here.
 */
export interface LoopbackPermission {
  readonly state: string;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface LinkState {
  phase: LinkPhase;
  /** The MCP clients whose calls arrive through the bridge. */
  clients: ClientInfo[];
  bridgeVersion: string | null;
  /** When outdated: the side that has to be updated. */
  behind: 'bridge' | 'page' | null;
  /** Attempts in a row that did not end in a connection. */
  attempts: number;
  /**
   * True when a failed attempt may be the browser's doing: it restricts what a site may
   * reach on the computer, but does not say what it decided for this one.
   */
  unsure: boolean;
}

export interface LinkOptions {
  port: number;
  token: string;
  /** Announced to the bridge, which passes them on to its MCP client. */
  tools: ToolDefinition[];
  call(name: string, args: unknown, client: string | null): Promise<ToolResult>;
  onChange(state: LinkState): void;
  /** Pauses, in milliseconds, before looking for the bridge again; the last one repeats. */
  retryDelays?: number[];
  /** Pause before trying again something that answered but would not pair. */
  refusedDelay?: number;
  /** How long pairing may take once the connection is open. */
  pairingTimeout?: number;
  /**
   * Looks up the browser's permission: `unneeded` where the page needs none, null where
   * the browser has no such permission to look up.
   */
  permission?: () => Promise<LoopbackPermission | 'unneeded' | null>;
}

export interface Link {
  /** Tries now, if no attempt is under way, instead of at the next scheduled time. */
  retry(): void;
  close(): void;
}

/**
 * Chrome asks its user before a site may connect to the computer it runs on, and tells
 * the site what was answered. Pages served from that computer are not asked about.
 */
async function loopbackPermission(): Promise<LoopbackPermission | 'unneeded' | null> {
  const host = globalThis.location?.hostname ?? 'localhost';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) return 'unneeded';
  // The permission was renamed when it was split from the one for the local network.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      return await navigator.permissions.query({ name: name as PermissionName });
    } catch {
      // Not a permission this browser knows by that name.
    }
  }
  return null;
}

function parse(data: unknown): BridgeMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === 'object' && message !== null && typeof (message as { t?: unknown }).t === 'string' ? (message as BridgeMessage) : null;
  } catch {
    return null;
  }
}

export function openLink(options: LinkOptions): Link {
  const { retryDelays = [1000, 2000, 3000, 5000], refusedDelay = 10_000, pairingTimeout = 5000 } = options;
  let state: LinkState = { phase: 'connecting', clients: [], bridgeVersion: null, behind: null, attempts: 0, unsure: false };
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Undefined until the browser has been asked. */
  let permission: LoopbackPermission | 'unneeded' | null | undefined;

  const set = (patch: Partial<LinkState>): void => {
    state = { ...state, ...patch };
    options.onChange(state);
  };

  function attempt(): void {
    clearTimeout(timer);
    if (closed || socket) return;
    let connection: WebSocket;
    try {
      // Pairing needs WebCrypto, which a page served over plain http does not get.
      if (!globalThis.crypto?.subtle) throw new Error('Not a secure context.');
      // By address rather than as "localhost": browsers let a secure page open plain
      // ws:// to the loopback address, and not all of them extend that to the name.
      connection = new WebSocket(`ws://127.0.0.1:${options.port}/`);
    } catch {
      set({ phase: 'blocked', clients: [] });
      return;
    }
    socket = connection;

    const clientNonce = newNonce();
    /** What this attempt came to; reported when the connection closes. */
    let outcome: LinkPhase = 'waiting';
    let behind: LinkState['behind'] = null;
    /** The bridge has proved it knows the pairing code. */
    let trusted = false;
    let paired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const calls = new Map<number, AbortController>();
    // Proofs are computed asynchronously; messages are still handled in the order they came.
    let handled = Promise.resolve();

    const send = (message: unknown): void => {
      if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
    };
    const giveUp = (as: LinkPhase): void => {
      outcome = as;
      connection.close();
    };

    async function handle(message: BridgeMessage): Promise<void> {
      if (!paired) {
        if (message.t === 'denied') {
          behind = message.reason === 'version' ? ((message.v ?? 0) < LINK_VERSION ? 'bridge' : 'page') : null;
          giveUp(message.reason === 'version' ? 'outdated' : 'rejected');
        } else if (message.t === 'challenge' && !trusted) {
          if (message.proof !== (await proofOf(options.token, 'bridge', clientNonce, message.nonce))) return giveUp('rejected');
          trusted = true;
          send({ t: 'auth', proof: await proofOf(options.token, 'page', clientNonce, message.nonce), app: { name: 'JSON Explorer' }, tools: options.tools });
        } else if (message.t === 'ready' && trusted) {
          paired = true;
          clearTimeout(deadline);
          // From here on, a connection that closes is a bridge that went away.
          outcome = 'waiting';
          set({ phase: 'connected', clients: message.clients ?? [], bridgeVersion: message.bridge?.version ?? null, behind: null, attempts: 0 });
        }
        return;
      }
      switch (message.t) {
        case 'clients':
          set({ clients: message.clients });
          break;
        case 'call': {
          const { id } = message;
          const controller = new AbortController();
          calls.set(id, controller);
          const result = await options.call(message.name, message.args, message.client ?? null).catch(
            (error: unknown): ToolResult => ({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }),
          );
          calls.delete(id);
          // An answer nobody is waiting for any more is not sent.
          if (!controller.signal.aborted) send({ t: 'result', id, result });
          break;
        }
        case 'cancel':
          calls.get(message.id)?.abort();
          break;
        case 'bye':
          if (message.reason === 'replaced') outcome = 'replaced';
          break;
        default:
          break;
      }
    }

    connection.addEventListener('open', () => {
      // Whatever answers now and does not pair is not the bridge this page was set up with.
      outcome = 'rejected';
      deadline = setTimeout(() => connection.close(), pairingTimeout);
      send({ t: 'hello', v: LINK_VERSION, role: 'page', nonce: clientNonce });
    });
    connection.addEventListener('message', (event: MessageEvent) => {
      const message = parse(event.data);
      if (!message) return;
      // Calls run side by side; only pairing has to go step by step.
      if (paired) void handle(message);
      else handled = handled.then(() => handle(message)).catch(() => giveUp('rejected'));
    });
    connection.addEventListener('close', () => {
      clearTimeout(deadline);
      for (const controller of calls.values()) controller.abort();
      if (socket === connection) socket = null;
      if (closed) return;
      // Nothing answered. Where the browser says it did not let the page through, that
      // is why, and trying again would only make it ask its user again.
      if (outcome === 'waiting' && !paired && typeof permission === 'object' && permission !== null && permission.state !== 'granted') {
        outcome = permission.state === 'denied' ? 'forbidden' : 'unanswered';
      }
      set({ phase: outcome, clients: [], behind, attempts: paired ? 0 : state.attempts + 1, unsure: permission === null });
      if (outcome === 'replaced' || outcome === 'unanswered' || outcome === 'forbidden') return;
      const pause = outcome === 'waiting' ? retryDelays[Math.min(state.attempts, retryDelays.length) - 1] ?? retryDelays[0] : refusedDelay;
      timer = setTimeout(attempt, pause);
    });
    // A failed connection closes as well; that is where it is dealt with.
    connection.addEventListener('error', () => {});
  }

  // When the user changes the answer in the browser's settings, there is reason to try again.
  const permissionChanged = (): void => attempt();
  options.onChange(state);
  // The first attempt waits for the permission to be known, so that its failure can be read.
  void (options.permission ?? loopbackPermission)()
    .catch(() => null)
    .then((found) => {
      permission = found;
      if (typeof found === 'object' && found !== null && !closed) found.addEventListener('change', permissionChanged);
      attempt();
    });

  return {
    retry() {
      attempt();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      if (typeof permission === 'object' && permission !== null) permission.removeEventListener('change', permissionChanged);
      socket?.close();
    },
  };
}
