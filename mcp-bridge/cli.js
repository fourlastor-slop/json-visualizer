#!/usr/bin/env node
/** Runs the bridge for the MCP client that started this process. */
import { MIN_TOKEN_LENGTH } from './auth.js';
import { VERSION, startBridge } from './bridge.js';
import { DEFAULT_ORIGIN, DEFAULT_PORT, TOKEN_VARIABLE } from './defaults.js';

const NAME = 'json-explorer-mcp';

const USAGE = `${NAME} ${VERSION}

Lets an MCP client use JSON Explorer while it is open in a browser tab. The client starts
this program and talks to it over standard input and output; the tab connects to it on
this computer. JSON Explorer shows the exact settings for your client under "MCP server".

Usage: ${NAME} [--port <number>] [--origin <url>]...

  ${TOKEN_VARIABLE}   (environment, required) The pairing code shown in JSON Explorer.
  --port <number>     Port to listen on, on 127.0.0.1 only. Default: ${DEFAULT_PORT}.
  --origin <url>      Address JSON Explorer is served from. Repeat for several.
                      Default: ${DEFAULT_ORIGIN}
  --version, --help
`;

/** @param {string} message */
function refuse(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(1);
}

if (Number(process.versions.node.split('.')[0]) < 22) refuse(`Node.js 22 or newer is needed; this is ${process.versions.node}.`);

let port = DEFAULT_PORT;
/** @type {string[]} */
const origins = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = /** @type {string} */ (args[i]);
  // Both `--port 5766` and `--port=5766`.
  const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
  const value = () => inline ?? args[++i] ?? refuse(`${flag} needs a value.`);
  if (flag === '--help' || flag === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (flag === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  } else if (flag === '--port') {
    port = Number(value());
    if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('--port takes a number between 1 and 65535.');
  } else if (flag === '--origin') {
    const given = String(value());
    try {
      origins.push(new URL(given).origin);
    } catch {
      refuse(`--origin takes an address such as ${DEFAULT_ORIGIN}; got "${given}".`);
    }
  } else {
    refuse(`Unknown option ${flag}. Try --help.`);
  }
}

const token = process.env[TOKEN_VARIABLE] ?? '';
if (token.length < MIN_TOKEN_LENGTH) {
  refuse(`${token === '' ? `${TOKEN_VARIABLE} is not set` : `${TOKEN_VARIABLE} is too short`}. Set it to the pairing code JSON Explorer shows under "MCP server".`);
}

const bridge = startBridge({
  input: process.stdin,
  output: process.stdout,
  token,
  port,
  origins,
  // Standard output belongs to the protocol; everything for people goes to standard error.
  log: (line) => process.stderr.write(`[${NAME}] ${line}\n`),
  onClose: () => process.exit(0),
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => bridge.close());
