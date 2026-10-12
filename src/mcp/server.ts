/**
 * Serving MCP clients from this tab: keeps the connection to the bridge that the settings
 * ask for, and runs the calls that arrive over it. Loaded when the switch is first on.
 */
import { toast } from '../ui/feedback';
import { type Link, openLink } from './link';
import { type McpSettings, getMcpSettings, getMcpStatus, recordMcpCall, setMcpStatus, subscribeMcpSettings } from './state';
import { TOOLS, callTool, describeCall } from './tools';

/**
 * Held by the one tab that is connected. With the app open in several tabs they would
 * otherwise take the bridge from one another; the others wait, and one of them takes
 * over when the tab that holds it is closed.
 */
const LOCK = 'jx-mcp-server';
/** A tab that has not got the lock by then says that another tab is serving. */
const STANDBY_AFTER_MS = 300;

let serving: { key: string; stop(): void } | null = null;
let link: Link | null = null;
let nextCallId = 1;

async function run(name: string, args: unknown, client: string | null) {
  const call = { id: nextCallId++, tool: name, about: describeCall(name, args), client, at: Date.now(), ms: null, failed: false };
  recordMcpCall(call);
  const started = performance.now();
  const result = await callTool(name, args, { baseUrl: location.href.split('#')[0]!, client, announce: toast });
  recordMcpCall({ ...call, ms: Math.round(performance.now() - started), failed: result.isError === true });
  return result;
}

function start(settings: McpSettings): () => void {
  let release: (() => void) | undefined;
  let stopped = false;
  const waiting = new AbortController();
  const connect = (): void => {
    if (!stopped) link = openLink({ port: settings.port, token: settings.token, tools: TOOLS, call: run, onChange: setMcpStatus });
  };

  setMcpStatus({ phase: 'connecting', clients: [], behind: null, attempts: 0, unsure: false });
  const standby = setTimeout(() => !link && setMcpStatus({ phase: 'standby' }), STANDBY_AFTER_MS);
  if (navigator.locks) {
    void navigator.locks
      .request(LOCK, { signal: waiting.signal }, () => {
        connect();
        return new Promise<void>((resolve) => (release = resolve));
      })
      // Aborted when the switch goes off while another tab holds the lock. Anything else
      // means locks cannot be had here: connect without one.
      .catch((error: unknown) => (error as { name?: string } | null)?.name !== 'AbortError' && connect());
  } else {
    connect();
  }

  return () => {
    stopped = true;
    clearTimeout(standby);
    waiting.abort();
    link?.close();
    link = null;
    release?.();
  };
}

function apply(): void {
  const settings = getMcpSettings();
  const key = settings.enabled ? `${settings.port}\n${settings.token}` : '';
  if (serving?.key === key) return;
  serving?.stop();
  serving = null;
  if (key === '') setMcpStatus({ phase: 'off', clients: [], behind: null, attempts: 0, unsure: false });
  else serving = { key, stop: start(settings) };
}

/** Looks for the bridge now, where the tab is the one that should be connected. */
export function retry(): void {
  link?.retry();
}

let started = false;

export function serve(): void {
  if (started) return;
  started = true;
  subscribeMcpSettings(apply);
  apply();
  // Background tabs run their timers rarely. Coming back to the tab, or back online, is
  // a good moment to look for the bridge without waiting for the next one.
  const nudge = (): void => {
    const { phase } = getMcpStatus();
    if (!document.hidden && (phase === 'waiting' || phase === 'rejected' || phase === 'outdated')) retry();
  };
  document.addEventListener('visibilitychange', nudge);
  window.addEventListener('online', nudge);
}
