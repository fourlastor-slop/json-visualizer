# JSON Explorer

Visualize and query JSON and JSON Lines files in the browser. Queries are built with
blocks, the blocks generate [JSONata](https://jsonata.org/), and the results are shown as
charts or tables — on one file, or on several files at once to compare them.

It is a static site. There is no backend: files, queries and settings are stored in the
browser's IndexedDB and stay there, unless you connect an AI client to it yourself (see
[MCP server](#mcp-server)).

## Running it

```bash
npm install
npm run dev        # development server on http://localhost:5173
npm test           # unit tests
npm run build      # type-check and build the static site into dist/
npm run preview    # serve dist/ locally
```

`dist/` can be hosted anywhere that serves static files, from any path: asset URLs are
relative and routing uses the URL hash, so no server configuration is needed. It has to be
served over http(s) — opening `index.html` from disk will not work, because browsers do not
load modules or workers from `file://`.

## Deploying

Every push to `main` is published at https://json.fourlastor.org by
`.github/workflows/deploy.yml`, which runs the tests, builds the site and uploads `dist/`
to Cloudflare with [Wrangler](https://developers.cloudflare.com/workers/wrangler/). There
it is a Worker made only of static assets; `wrangler.jsonc` names it and attaches it to
its domain.

The workflow reads the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets. With
the same two variables in your environment, `npm run build && npx wrangler deploy`
publishes from your machine.

## How it is used

- **Projects** hold files and visualizations. Create, rename and delete them from the
  start page.
- **Files** are `.json` or `.jsonl`/`.ndjson`. A JSON Lines file is one record per line; a
  JSON file holding a list is one record per item; any other JSON file is a single record.
  Upload by button or drag and drop. From a file's menu you can **append** more records,
  **replace** its contents (visualizations stay attached), rename or delete it. Uploading
  a file whose name is already taken offers the same choices. Click a file to inspect its
  fields and first records.
- **Visualizations** are a query plus a way to show its result: a line, area, bar or
  scatter chart, or a table. Every chart also has a table view of the same rows, and the
  result can be downloaded as CSV. The expand button on a visualization's card, or on the
  editor's preview, opens the result on its own, filling the window.
- **Several files at once.** A visualization runs its query on each selected file
  separately. In charts each file has its own color: with more than one measure, each
  measure gets its own small plot (or, if you prefer one plot, its own stroke pattern). In
  tables, files are stacked under a "file" column or set side by side on a key column.
- **Colors** are drawn at random for each file from a palette of eight, avoiding pairs
  that are hard to tell apart (including for color-blind readers), and then stay with the
  file in every chart. Click a file's dot to pick another, or use the shuffle button to
  redraw them all.
- **Templates.** Mark a visualization as a template to reuse its query on other files, in
  any project. When you start a visualization from a template, it is checked against each
  selected file: it fits when the file has the fields the query reads, and otherwise you
  are told which fields are missing from which file. A template keeps following its
  visualization's edits, and stays available if the visualization or its project is deleted.

## Building queries

A query is a stack of **steps** under the `records` block. Each step transforms the rows
produced by the one above it; with no steps the result is every record as it is.

| Step | What it does |
| --- | --- |
| keep where | keeps the rows matching a condition |
| pick columns | turns each row into the columns you list: a field, or a named value |
| sort by, keep the first/last _n_ rows | orders and limits rows |
| group by … summarize, summarize all rows | one row per group, or a single row, of sums, averages, counts… |
| for each entry of / for each item of | one row per entry of a dictionary-like object, or per item of a list |
| go into | continues with a nested object or list as the rows |

Value blocks plug into steps: fields, numbers and text, arithmetic, comparisons and logic,
text functions, summaries (sum, average, minimum, maximum, count, distinct count, first,
last), loops over the entries of an object or the items of a list, date helpers, and a raw
JSONata block for anything else.

**Field names come from the data.** A field block lists the fields that exist at its
position: the fields of the selected files at the top of the stack, the columns made by
an earlier `pick columns` further down, the value's fields inside a loop. It can be
browsed level by level (`*` stands for "any key") or searched across all nested paths. The
"Fields" toolbox category lists the top-level fields of the selected files as ready-made
blocks. A block that reads a field one of the files lacks is flagged.

The generated JSONata is shown next to the preview and can be copied. For example, the
blocks for "the share of evaluation games won against pilots, and against the starting
checkpoint, per version" generate:

```
$[$exists(evaluation_suite)].{
  "version": version,
  "pilots %": $round($sum($each(evaluation_suite, function($v, $k) { $k != "blackwing-vs-checkpoint" ? $v.wins })) / 1664 * 100, 1),
  "the start %": $round(evaluation_suite.`blackwing-vs-checkpoint`.wins / 2048 * 100, 1)
}
```

## MCP server

An AI client that speaks the [Model Context Protocol](https://modelcontextprotocol.io/),
such as Claude Code, Claude Desktop or Cursor, can work with the projects in your browser:
list files and their fields, run JSONata queries on them, read your visualizations and add
new ones. It is off until you turn it on, under the plug icon in the top bar; that dialog
also gives the exact commands to set a client up.

A page cannot be connected to from outside, and a static site has no server to relay, so
the client reaches the tab through a small program on your computer, the **bridge**:

```
MCP client  ⇄ stdio ⇄  bridge (Node.js)  ⇄ WebSocket on 127.0.0.1 ⇄  the open tab
```

The client starts the bridge like any other MCP server. The tab connects to it and answers
the calls, with the same data and query engine as the interface, so it works only while a
tab of the app is open. The bridge is a single file with no dependencies, served by the
site itself (`json-explorer-mcp.mjs`); its source is in [`mcp-bridge/`](mcp-bridge/).

| Tool | What it does |
| --- | --- |
| `list_projects` | projects, with their files and visualizations |
| `describe_file` | the fields of a file: types, ranges, examples, and the JSONata path of each |
| `run_query` | runs a JSONata query on one or more files and returns the first rows |
| `get_visualization` | a visualization's files, query, settings and current rows |
| `create_visualization` | adds a chart or table made from a JSONata query |

What to know about it:

- **What a client asks for leaves the browser**, and goes to the client and the AI service
  behind it. A client cannot change or delete files; it can add visualizations.
- **Pairing.** The bridge listens on the loopback address only, accepts pages of this site
  only, and the page and the bridge prove to each other that they hold the same pairing
  code before anything else is said. The code is generated in the browser and given to
  the client as part of its settings.
- **Several clients at once** each start their own bridge. The first takes the port and
  the others send their calls through it; when it exits, another takes over.
- **Browsers.** Chrome, Edge and Firefox let a secure page connect to a program on the
  same computer; Chrome asks for permission first. Safari may refuse.

## How it is built

| Path | Contents |
| --- | --- |
| `src/data/` | Parsing, schema inference, IndexedDB storage, the app store, and the data worker |
| `src/blocks/` | Block definitions, the field picker, the JSONata generator, and the analysis that knows which fields are visible where |
| `src/viz/` | Turning rows into chart and table models, and drawing them (SVG, no charting library) |
| `src/pages/`, `src/ui/` | The React interface |
| `src/mcp/` | The page's side of the MCP server: the tools, and the connection to the bridge |
| `mcp-bridge/` | The bridge: a Node.js program, in plain JavaScript checked by TypeScript |
| `tests/` | Unit tests, including the generator run on headless Blockly, and an MCP client talking to the tools through a real bridge |

A few things worth knowing before changing it:

- **File contents only ever live in the data worker** (`src/data/worker.ts`). Uploads are
  parsed and validated there, stored as one chunk per upload (appending adds a chunk
  instead of rewriting the file), and queried there, so a large file or a slow query does
  not freeze the page. The page holds metadata and each file's inferred schema.
- **Blockly is loaded on demand**, for the editor and for checking templates. Dashboards
  render from the stored query text and do not need it.
- **The generator emits standard JSONata**, with no custom functions, so a query can be
  copied elsewhere. `src/blocks/generator.ts` explains the two shapes it produces (a single
  path, or a block rebinding `$rows`) and why.
- **MCP tools are defined once**, in `mcp-bridge/tools.json`, and carried out in
  `src/mcp/tools.ts`. The bridge passes calls on without knowing the tools: it announces
  the list the page gives it, and falls back on its own copy only until a page connects.
  `scripts/build-bridge.mjs` bundles the bridge into the one file the site serves.
- **Chart colors** are the eight slots defined in `src/styles.css` (light and dark steps of
  the same hues). `src/data/colors.ts` holds the measured separation between every pair,
  which is what the random draw uses.

## Limits

- Everything is in one browser profile: there is no sync, and clearing site data deletes
  it. Keep your original files.
- Files are parsed in memory, so the practical limit is what the browser tab can hold. A
  50 MB JSON Lines file (11,500 records of about 100 fields) uploads in under a second and
  answers queries in tens of milliseconds; far larger files will get slow.
- A query result is capped at 100,000 rows per file, and a query is stopped after 30 seconds.
