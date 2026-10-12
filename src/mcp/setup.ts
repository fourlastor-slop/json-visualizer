/** The commands and settings that connect an MCP client to this browser, as shown in the dialog. */
import { DEFAULT_ORIGIN, DEFAULT_PORT, TOKEN_VARIABLE } from '../../mcp-bridge/defaults.js';
import type { McpSettings } from './state';

/** The bridge as the site serves it, bundled by scripts/build-bridge.mjs. */
export const BRIDGE_FILE = 'json-explorer-mcp.mjs';

/** What the bridge is called in an MCP client's list of servers. */
const SERVER_NAME = 'json-explorer';

export interface Setup {
  /** Where the bridge is downloaded from: next to the page. */
  bridgeUrl: string;
  /** Shell command that saves the bridge in the home directory. */
  download: string;
  /** Shell command that adds the bridge to Claude Code. */
  claudeCode: string;
  /** The same for clients that are set up in a JSON file. */
  json: string;
}

/** A word as a shell takes it literally. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** @param pageUrl Address of the app as it is open now. */
export function setupFor(settings: Pick<McpSettings, 'port' | 'token'>, pageUrl: string): Setup {
  const page = new URL(pageUrl);
  page.hash = '';
  page.search = '';
  const bridgeUrl = new URL(BRIDGE_FILE, page).href;
  // The bridge only has to be told what differs from what it assumes.
  const options = [...(page.origin === DEFAULT_ORIGIN ? [] : ['--origin', page.origin]), ...(settings.port === DEFAULT_PORT ? [] : ['--port', String(settings.port)])];
  return {
    bridgeUrl,
    download: `curl -fsSL ${shellWord(bridgeUrl)} -o ~/${BRIDGE_FILE}`,
    claudeCode: ['claude mcp add --scope user', SERVER_NAME, '-e', `${TOKEN_VARIABLE}=${settings.token}`, '--', 'node', `~/${BRIDGE_FILE}`, ...options.map(shellWord)].join(' '),
    json: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'node', args: [`/path/to/${BRIDGE_FILE}`, ...options], env: { [TOKEN_VARIABLE]: settings.token } } } }, null, 2),
  };
}
