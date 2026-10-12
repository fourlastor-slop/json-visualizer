/**
 * Bundles the MCP bridge (mcp-bridge/) into a single file with nothing to install, and
 * puts it where the site serves it: the "MCP server" dialog tells people to download it
 * from there. Run before `dev` and `build`, like the copy of Blockly's media.
 */
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  build: {
    // A build for Node: its built-in modules stay imports, everything else is included.
    ssr: 'mcp-bridge/cli.js',
    target: 'node22',
    outDir: 'public',
    emptyOutDir: false,
    minify: false,
    rolldownOptions: { output: { entryFileNames: 'json-explorer-mcp.mjs' } },
  },
  ssr: { noExternal: true },
});
