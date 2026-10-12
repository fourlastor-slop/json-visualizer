# JSON Explorer MCP bridge

Lets an MCP client (Claude Code, Claude Desktop, Cursor…) use
[JSON Explorer](https://json.fourlastor.org) while it is open in a browser tab.

```
MCP client  ⇄ stdio ⇄  this program  ⇄ WebSocket on 127.0.0.1 ⇄  the open tab
```

A web page cannot accept connections and an MCP client cannot reach into a browser, so
this program listens for both. The client starts it and talks to it over standard input
and output; the tab connects to it and answers the tool calls, which is where the data
is. The bridge knows nothing about the tools: it announces the list the tab gives it and
passes calls on.

## Using it

Open JSON Explorer, click the plug icon ("MCP server") and follow the steps there: they
contain the pairing code of your browser and the command for your client. In short:

```bash
curl -fsSL https://json.fourlastor.org/json-explorer-mcp.mjs -o ~/json-explorer-mcp.mjs
claude mcp add --scope user json-explorer -e JSON_EXPLORER_MCP_TOKEN=<pairing code> -- node ~/json-explorer-mcp.mjs
```

It needs Node.js 22 or newer and has no dependencies. From a clone of the repository,
`node mcp-bridge/cli.js` is the same program, unbundled.

| Setting | |
| --- | --- |
| `JSON_EXPLORER_MCP_TOKEN` | Environment variable, required: the pairing code shown in JSON Explorer |
| `--port <number>` | Port to listen on, on 127.0.0.1. Default 5766; set the same one in JSON Explorer |
| `--origin <url>` | Address JSON Explorer is served from, if not json.fourlastor.org. Repeatable |

## What it lets through

- It listens on the loopback address only, and answers nothing over plain HTTP.
- A browser connection is accepted only from the origins given (browsers state the origin
  of a WebSocket, and a page cannot forge it) and only under the bridge's own host name,
  which rules out DNS rebinding.
- Before anything else, the two sides prove to each other that they hold the pairing code,
  with an HMAC over fresh nonces from both: the code itself never travels. A loopback port
  is open to every program and every user of the machine, so the page checks the bridge as
  much as the bridge checks the page.
- Tool calls are answered by the page. What it returns goes to the MCP client and nowhere
  else.

## Several clients

Every MCP client starts its own copy, but there is one port and one tab. The copy that
gets the port serves the tab; the others connect to it, paired the same way, and send
their calls through it. When it exits, one of the others takes the port and the tab
reconnects by itself.

## Layout

| File | |
| --- | --- |
| `cli.js` | Reads the settings and runs the bridge on stdin/stdout |
| `bridge.js` | The bridge: who has the port, pairing, passing calls along |
| `mcp.js` | MCP over stdio, server side: JSON-RPC, one message per line |
| `websocket.js` | The server side of a WebSocket, written out to avoid a dependency |
| `auth.js` | Nonces and proofs of the pairing code |
| `defaults.js` | Port, origin and link version, shared with the page |
| `tools.json` | The tools, as announced before a tab has connected. The page reads this file too |

`npm run typecheck` in the repository checks these files with TypeScript, and
`tests/bridge.test.ts` and `tests/mcp.test.ts` exercise them. `scripts/build-bridge.mjs`
bundles them into the single file the site serves.
