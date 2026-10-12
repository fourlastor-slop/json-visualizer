/**
 * What the bridge and the page have to agree on. The page imports this file as well, so
 * nothing in it may depend on Node.
 */

/** The loopback port the bridge listens on and the page connects to. */
export const DEFAULT_PORT = 5766;

/** Where JSON Explorer is served from, unless the bridge is told otherwise. */
export const DEFAULT_ORIGIN = 'https://json.fourlastor.org';

/** The environment variable that carries the pairing code to the bridge. */
export const TOKEN_VARIABLE = 'JSON_EXPLORER_MCP_TOKEN';

/**
 * Version of the messages exchanged with the page and between bridges. A bridge and a page
 * with different versions refuse each other and say which one to update.
 */
export const LINK_VERSION = 1;
