/**
 * What the page and the bridge say to each other over their WebSocket. The bridge's side
 * is mcp-bridge/bridge.js; the two must agree, and LINK_VERSION (mcp-bridge/defaults.js)
 * changes when they would not.
 */
import type { JsonSchema } from './validate';

/** A tool as MCP describes it to a client. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}

/** What a tool call gives back, in MCP's shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** An MCP client whose calls arrive through the bridge. */
export interface ClientInfo {
  name: string;
  version?: string;
}

export type BridgeMessage =
  | { t: 'challenge'; v: number; nonce: string; proof: string }
  | { t: 'denied'; reason: 'token' | 'version'; v?: number }
  | { t: 'ready'; bridge: { version: string }; clients: ClientInfo[] }
  | { t: 'clients'; clients: ClientInfo[] }
  | { t: 'call'; id: number; name: string; args: unknown; client?: string }
  | { t: 'cancel'; id: number }
  | { t: 'bye'; reason: string };

export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(18)));
}

/** A pairing code: long and random, because it is copied and never typed. */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encoder = new TextEncoder();

/**
 * What one side sends to show it knows the pairing code, without sending the code: an
 * HMAC over who is speaking and the two nonces of this connection. Computed the same way
 * in mcp-bridge/auth.js.
 */
export async function proofOf(token: string, role: 'bridge' | 'page', clientNonce: string, serverNonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode([role, clientNonce, serverNonce].join('\n')));
  return base64url(new Uint8Array(signature));
}
