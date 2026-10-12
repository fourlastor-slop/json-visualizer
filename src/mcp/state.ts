/**
 * The MCP switch, and what the connection behind it is doing, for the interface. This
 * much is always loaded; the code that serves MCP clients (server.ts) is fetched when the
 * switch is first on.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_PORT } from '../../mcp-bridge/defaults.js';
import type { LinkPhase, LinkState } from './link';
import { newToken } from './protocol';

export interface McpSettings {
  /** Whether MCP clients may reach this browser's copy of the app. Off until asked for. */
  enabled: boolean;
  /** Loopback port the bridge listens on. */
  port: number;
  /** The pairing code shared with the bridge; empty until the switch is first turned on. */
  token: string;
}

/** A tool call made by an MCP client, for the list of recent ones. */
export interface McpCall {
  id: number;
  tool: string;
  /** What it was about: the query, the file, the name. */
  about: string;
  client: string | null;
  at: number;
  /** How long it took; null while it runs. */
  ms: number | null;
  failed: boolean;
}

export interface McpStatus extends Omit<LinkState, 'phase'> {
  /** `off`: the switch is off. `standby`: another tab of this browser is the one connected. */
  phase: LinkPhase | 'off' | 'standby';
  /** The most recent calls, newest first. */
  calls: McpCall[];
}

const STORAGE_KEY = 'jx-mcp';
const KEPT_CALLS = 30;

function read(): McpSettings {
  const settings: McpSettings = { enabled: false, port: DEFAULT_PORT, token: '' };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<McpSettings> | null;
    if (stored?.enabled === true) settings.enabled = true;
    if (Number.isInteger(stored?.port) && stored!.port! >= 1 && stored!.port! <= 65535) settings.port = stored!.port!;
    if (typeof stored?.token === 'string') settings.token = stored.token;
  } catch {
    // Storage is unavailable or holds something else: start from the defaults.
  }
  return settings;
}

let settings = read();
let status: McpStatus = { phase: 'off', clients: [], bridgeVersion: null, behind: null, attempts: 0, unsure: false, calls: [] };
const settingsListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

const subscribeTo = (listeners: Set<() => void>) => (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function emit(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

export const subscribeMcpSettings = subscribeTo(settingsListeners);
const subscribeMcpStatus = subscribeTo(statusListeners);

export function getMcpSettings(): McpSettings {
  return settings;
}

export function useMcpSettings(): McpSettings {
  return useSyncExternalStore(subscribeMcpSettings, getMcpSettings);
}

export function getMcpStatus(): McpStatus {
  return status;
}

export function useMcpStatus(): McpStatus {
  return useSyncExternalStore(subscribeMcpStatus, getMcpStatus);
}

export function setMcpStatus(patch: Partial<McpStatus>): void {
  status = { ...status, ...patch };
  emit(statusListeners);
}

/** Adds a call to the recent ones, or updates it once it has finished. */
export function recordMcpCall(call: McpCall): void {
  setMcpStatus({ calls: [call, ...status.calls.filter((other) => other.id !== call.id)].sort((a, b) => b.id - a.id).slice(0, KEPT_CALLS) });
}

export type McpTone = 'ok' | 'idle' | 'warn';

/** The state of the connection in a few words, and how it should look. */
export function describeMcpStatus(status: McpStatus, settings: McpSettings): { tone: McpTone; title: string; detail: string } {
  const { port } = settings;
  switch (status.phase) {
    case 'off':
      return { tone: 'idle', title: 'Off', detail: 'No program outside this page can reach your projects.' };
    case 'connecting':
      return { tone: 'idle', title: 'Looking for the bridge…', detail: '' };
    case 'waiting':
      return {
        tone: 'idle',
        title: 'Waiting for the bridge',
        detail:
          status.attempts < 3
            ? `It listens on port ${port} while your MCP client runs. This tab keeps looking for it.`
            : `Nothing answers on port ${port}. The bridge runs only while your MCP client does: start the client, or restart it if you have just set it up.${
                status.unsure ? ' If it is running, your browser may be keeping this site from connecting to programs on this device: look for such a permission in the site settings next to the address.' : ''
              }`,
      };
    case 'unanswered':
      return {
        tone: 'warn',
        title: 'Waiting for your permission',
        detail: 'Your browser asks before it lets a site connect to programs on this device, and the bridge is one. It is the only thing on this device that the page connects to.',
      };
    case 'forbidden':
      return {
        tone: 'warn',
        title: 'Not allowed by the browser',
        detail: 'This site is not allowed to connect to programs on this device, so it cannot reach the bridge. Allow it in the site settings next to the address; the permission is called “apps on device” or “local network access”.',
      };
    case 'standby':
      return { tone: 'idle', title: 'Handled by another tab', detail: 'Another tab of JSON Explorer in this browser is the one that connects to the bridge. This one takes over when that tab closes.' };
    case 'connected': {
      const names = status.clients.map((client) => (client.version ? `${client.name} ${client.version}` : client.name));
      return { tone: 'ok', title: names.length > 0 ? `Connected to ${names.join(', ')}` : 'Connected to the bridge', detail: 'Keep this tab open: the calls are answered here.' };
    }
    case 'rejected':
      return {
        tone: 'warn',
        title: 'Not the right bridge',
        detail: `Something answers on port ${port}, but it does not have this pairing code. Give your MCP client the settings below again and restart it; if another program uses the port, choose a different one.`,
      };
    case 'outdated':
      return status.behind === 'page'
        ? { tone: 'warn', title: 'This page is out of date', detail: 'The bridge is newer than this page. Reload the page.' }
        : { tone: 'warn', title: 'The bridge is out of date', detail: 'Download it again (step 1 below) and restart your MCP client.' };
    case 'replaced':
      return { tone: 'warn', title: 'Connected somewhere else', detail: 'Another browser connected with the same pairing code, and the bridge follows the latest one.' };
    case 'blocked':
      return { tone: 'warn', title: 'Blocked by the browser', detail: 'The browser does not let this page connect to a program on the same computer. The page has to be open over https, in a browser that allows such connections: Chrome, Edge and Firefox do.' };
  }
}

let server: Promise<typeof import('./server')> | null = null;

/** Starts serving MCP clients if the switch is on. Safe to call at any time. */
export function syncMcp(): void {
  if (settings.enabled) server ??= import('./server').then((module) => (module.serve(), module));
}

export function updateMcpSettings(patch: Partial<McpSettings>): void {
  settings = { ...settings, ...patch };
  if (settings.enabled && settings.token === '') settings.token = newToken();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is unavailable (private mode): the settings last for this visit.
  }
  emit(settingsListeners);
  syncMcp();
}

/** Looks for the bridge now instead of at the next scheduled attempt. */
export function retryMcp(): void {
  void server?.then((module) => module.retry());
}

// The switch is per browser, not per tab: follow it when another tab flips it.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  settings = read();
  emit(settingsListeners);
  syncMcp();
});
