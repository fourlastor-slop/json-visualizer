import 'fake-indexeddb/auto';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The tools run queries through the data worker; see directClient.ts.
vi.mock('../src/data/client', () => import('./directClient'));

import { proofOf as bridgeProof } from '../mcp-bridge/auth.js';
import { type Bridge, startBridge } from '../mcp-bridge/bridge.js';
import { LINK_VERSION } from '../mcp-bridge/defaults.js';
import { PROTOCOL_VERSIONS } from '../mcp-bridge/mcp.js';
import * as store from '../src/data/store';
import { type Link, type LinkState, openLink } from '../src/mcp/link';
import { newToken, proofOf } from '../src/mcp/protocol';
import { TOOLS, type ToolContext, callTool, describeCall } from '../src/mcp/tools';
import { ArgumentError, checkArguments } from '../src/mcp/validate';

const upload = (name: string, records: unknown[]) => new File([records.map((record) => JSON.stringify(record)).join('\n')], name);

const LEGEND = 'Each line is a field: its JSONata path from a record, its type, and what was seen in it. An indented line continues the path of the line it is under. Paths look through lists.';

const announced: string[] = [];
const context: ToolContext = { baseUrl: 'https://explorer.test/', client: 'Claude Code', announce: (message) => announced.push(message) };

/** Calls a tool the way the page does, and reads its answer back. */
async function call(name: string, args: unknown = {}): Promise<{ text: string; value: any; failed: boolean }> {
  const result = await callTool(name, args, context);
  const text = result.content[0]!.text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { text, value, failed: result.isError === true };
}

let projectId: string;
let pilots: string;
let itself: string;
let other: string;

beforeAll(async () => {
  await store.loadAll();
  const project = await store.createProject('Self-play runs');
  projectId = project.id;
  const runs = (wins: number[]) =>
    wins.map((won, i) => ({
      version: i + 1,
      'win-rate': won / 10,
      label: i % 2 === 0 ? 'even' : 'odd',
      suite: i === 0 ? undefined : { 'vs-checkpoint': { wins: won, games: 10 }, 'vs-pilot': { wins: won - 1, games: 10 } },
      tags: ['a', 'b'],
    }));
  pilots = (await store.addFile(projectId, upload('pilots.jsonl', runs([3, 6, 5, 8])))).id;
  itself = (await store.addFile(projectId, upload('itself.jsonl', runs([4, 4, 7])))).id;
  const elsewhere = await store.createProject('Elsewhere');
  other = (await store.addFile(elsewhere.id, upload('other.jsonl', [{ n: 1 }]))).id;
});

describe('tool definitions', () => {
  it('are sound, and each has code behind it', async () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(['list_projects', 'describe_file', 'run_query', 'get_visualization', 'create_visualization']);
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      for (const required of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties).toHaveProperty(required);
      // A tool without a handler says so, rather than complaining about its arguments.
      expect((await callTool(tool.name, { no_such_parameter: 1 }, context)).content[0]!.text).toContain('is not a parameter of this tool');
    }
    expect((await call('drop_everything')).text).toContain('no tool called "drop_everything"');
  });
});

describe('checking arguments', () => {
  const schema = TOOLS.find((tool) => tool.name === 'run_query')!.inputSchema;
  const complaint = (args: unknown): string => {
    try {
      checkArguments(schema, args);
    } catch (error) {
      if (error instanceof ArgumentError) return error.message;
      throw error;
    }
    return '';
  };

  it('fills in defaults and drops nothing that was given', () => {
    expect(checkArguments(schema, { file_ids: ['a'], query: '$' })).toEqual({ file_ids: ['a'], query: '$', limit: 50 });
    expect(checkArguments(schema, { file_ids: ['a'], query: '$', limit: null })).toMatchObject({ limit: 50 });
    expect(checkArguments(TOOLS[0]!.inputSchema, undefined)).toEqual({});
  });

  it('says what is wrong in words the caller can act on', () => {
    expect(complaint({ query: '$' })).toBe('`file_ids` is required.');
    expect(complaint({ file_ids: 'a', query: '$' })).toBe('`file_ids` must be a list.');
    expect(complaint({ file_ids: [], query: '$' })).toContain('`file_ids` must have a number of items between 1 and 10; it has 0.');
    expect(complaint({ file_ids: [7], query: '$' })).toBe('`file_ids[0]` must be text.');
    expect(complaint({ file_ids: ['a'], query: '' })).toBe('`query` must not be empty.');
    expect(complaint({ file_ids: ['a'], query: '$', limit: 2.5 })).toBe('`limit` must be a whole number.');
    expect(complaint({ file_ids: ['a'], query: '$', limit: 5000 })).toBe('`limit` must be a whole number between 1 and 500; got 5000.');
    expect(complaint({ file_ids: ['a'], query: '$', file: 'a' })).toContain('`file` is not a parameter of this tool. Its parameters are: file_ids, query, limit.');
    expect(complaint([])).toBe('The arguments must be an object.');
    const create = TOOLS.find((tool) => tool.name === 'create_visualization')!.inputSchema;
    expect(() => checkArguments(create, { file_ids: ['a'], name: 'n', query: '$', kind: 'pie' })).toThrow('`kind` must be one of "chart", "table"; got "pie".');
  });
});

describe('the tools', () => {
  it('list projects with their files and visualizations', async () => {
    const { value } = await call('list_projects');
    expect(value.projects.map((project: any) => project.name)).toEqual(['Self-play runs', 'Elsewhere']);
    expect(value.projects[0].files).toEqual([
      { id: pilots, name: 'pilots.jsonl', records: 4, fields: ['version', 'win-rate', 'label', 'tags', 'suite'] },
      { id: itself, name: 'itself.jsonl', records: 3, fields: ['version', 'win-rate', 'label', 'tags', 'suite'] },
    ]);
    expect(value.projects[0].visualizations).toEqual([]);
  });

  it('describe the fields of a file, with the path that reads each', async () => {
    const { text } = await call('describe_file', { file_id: pilots });
    expect(text.split('\n')).toEqual([
      `pilots.jsonl has 4 records. ${LEGEND}`,
      'version: number, 1 to 4, increasing from one record to the next',
      '`win-rate`: number, 0.3 to 0.8',
      'label: string, e.g. "even", "odd"',
      'tags: list, of strings',
      'suite: object, 2 keys, in 3 of 4',
      '  .`vs-checkpoint`: object, 2 keys',
      '  .`vs-pilot`: object, 2 keys',
    ]);
    const deeper = await call('describe_file', { file_id: pilots, depth: 3 });
    expect(deeper.text.split('\n').slice(-6)).toEqual(['  .`vs-checkpoint`: object, 2 keys', '    .wins: number, 5 to 8', '    .games: number, always 10', '  .`vs-pilot`: object, 2 keys', '    .wins: number, 4 to 7', '    .games: number, always 10']);
  });

  it('describe every field of a wide record before opening any of them up', async () => {
    const wide = Object.fromEntries(Array.from({ length: 280 }, (_, i) => [`field_${i}`, i < 3 ? Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`k${n}`, n])) : i]));
    const file = await store.addFile(projectId, upload('wide.jsonl', [wide]));
    const lines = (await call('describe_file', { file_id: file.id })).text.split('\n');
    // All 280 fields are there; the 20 lines left over do not fit the inside of an object.
    expect(lines.filter((line) => /^field_\d+:/.test(line))).toHaveLength(280);
    expect(lines.filter((line) => line.startsWith('  '))).toEqual([]);
    expect(lines.at(-1)).toBe('Some objects are not opened up here, to keep this short. Describe them on their own with `path`.');
    expect((await call('describe_file', { file_id: file.id, path: ['field_1'] })).text.split('\n')).toHaveLength(31);

    // Beyond what can be described, the names are still given.
    const wider = await store.addFile(projectId, upload('wider.jsonl', [Object.fromEntries(Array.from({ length: 420 }, (_, i) => [`f${i}`, i]))]));
    const all = (await call('describe_file', { file_id: wider.id })).text.split('\n');
    expect(all).toHaveLength(302);
    expect(all.at(-1)).toMatch(/^… and 120 more keys: f300, f301, .*f419\. Describe one by adding it to `path`/);
    await store.deleteFile(file.id);
    await store.deleteFile(wider.id);
  });

  it('describe what is under a path, with "*" for any key', async () => {
    const under = await call('describe_file', { file_id: pilots, path: ['suite', '*'], depth: 1 });
    expect(under.text.split('\n')).toEqual([
      `pilots.jsonl, suite.*: object, 2 keys. ${LEGEND}`,
      'suite.*.wins: number, 4 to 8',
      'suite.*.games: number, always 10',
    ]);
    // The path it gives is one a query can use.
    expect((await call('run_query', { file_ids: [pilots], query: '$max(suite.*.wins)' })).value.results[0].rows).toEqual([[8]]);

    const leaf = await call('describe_file', { file_id: pilots, path: ['label'] });
    expect(leaf.text).toBe('pilots.jsonl, label: string, e.g. "even", "odd". It has no fields of its own.');
    const lost = await call('describe_file', { file_id: pilots, path: ['suite', 'vs-nobody', 'wins'] });
    expect(lost).toMatchObject({ failed: true, text: 'pilots.jsonl has no suite.`vs-nobody`. suite has the keys: vs-checkpoint, vs-pilot.' });
  });

  it('run a query on several files, each on its own', async () => {
    const { value, failed } = await call('run_query', { file_ids: [pilots, itself], query: '$[version > 1].{"version": version, "wins": suite.`vs-checkpoint`.wins}' });
    expect(failed).toBe(false);
    expect(value.results).toEqual([
      { file_id: pilots, file: 'pilots.jsonl', total_rows: 3, columns: ['version', 'wins'], rows: [[2, 6], [3, 5], [4, 8]] },
      { file_id: itself, file: 'itself.jsonl', total_rows: 2, columns: ['version', 'wins'], rows: [[2, 4], [3, 7]] },
    ]);
  });

  it('give back only as many rows as asked, and say how many there are', async () => {
    const { value } = await call('run_query', { file_ids: [pilots], query: '$.version', limit: 2 });
    expect(value.results[0]).toEqual({ file_id: pilots, file: 'pilots.jsonl', total_rows: 4, columns: ['value'], rows: [[1], [2]], note: 'These are the first 2 of 4 rows.' });
    // Rows that lack a column still line up with the others.
    const ragged = await call('run_query', { file_ids: [pilots], query: '$.{"v": version, "games": suite.`vs-pilot`.games}' });
    expect(ragged.value.results[0]).toMatchObject({ columns: ['v', 'games'], rows: [[1, null], [2, 10], [3, 10], [4, 10]] });
  });

  it('keep an answer within what a model can take in', async () => {
    const big = await store.addFile(projectId, upload('big.jsonl', Array.from({ length: 300 }, (_, i) => ({ i, text: 'lorem ipsum '.repeat(100), nested: { list: Array.from({ length: 200 }, (_, n) => n) } }))));
    const { text, value } = await call('run_query', { file_ids: [big.id], query: '$', limit: 300 });
    expect(text.length).toBeLessThan(45_000);
    const [result] = value.results;
    expect(result.total_rows).toBe(300);
    expect(result.rows.length).toBeGreaterThan(20);
    expect(result.rows.length).toBeLessThan(300);
    expect(result.rows[0][1]).toMatch(/^lorem ipsum .*…$/);
    expect(result.rows[0][2]).toMatch(/^\{"list":\[0,1,2.*…$/);
    expect(result.note).toContain(`These are the first ${result.rows.length} of 300 rows.`);
    expect(result.note).toContain('select fewer columns or aggregate');
    expect(result.note).toContain('Long values are cut short');
    await store.deleteFile(big.id);
  });

  it('report a query that fails, on the files where it does', async () => {
    const broken = await call('run_query', { file_ids: [pilots], query: '$[version >' });
    expect(broken.failed).toBe(true);
    expect(broken.text).toMatch(/^The query failed: .+ \(at character \d+ of the query\)$/);
    const unknown = await call('run_query', { file_ids: ['nope'], query: '$' });
    expect(unknown).toMatchObject({ failed: true, text: 'There is no file with the id "nope". list_projects gives the ids.' });
    // A file can be named instead, as long as the name is not shared.
    expect((await call('run_query', { file_ids: ['other.jsonl'], query: '$count($)' })).value.results[0].rows).toEqual([[1]]);
  });

  it('create a chart that the editor can open, and the user is told', async () => {
    const query = '$[version > 1].{\n  "version": version,\n  "won %": `win-rate` * 100\n}';
    const created = await call('create_visualization', { file_ids: [pilots, itself], name: ' Win rate ', query, chart_type: 'bar' });
    expect(created.failed).toBe(false);
    const viz = store.getState().visualizations.find((candidate) => candidate.id === created.value.id)!;
    expect(created.value).toEqual({
      id: viz.id,
      name: 'Win rate',
      kind: 'chart',
      project: 'Self-play runs',
      link: `https://explorer.test/#/p/${projectId}/v/${viz.id}/view`,
      chart: { type: 'bar', x: 'version', y: ['won %'] },
      columns: ['version', 'won %'],
      files: [
        { file: 'pilots.jsonl', rows: 3 },
        { file: 'itself.jsonl', rows: 2 },
      ],
    });
    expect(viz).toMatchObject({ projectId, fileIds: [pilots, itself], kind: 'chart', chart: { type: 'bar', x: null, y: null }, templateId: null });
    expect(announced).toEqual(['Claude Code added “Win rate” to Self-play runs.']);

    // What is stored is what the blocks generate, so opening the editor changes nothing.
    const { compileState } = await import('../src/blocks/headless');
    expect(compileState(viz.workspace, undefined).query).toBe(viz.query);
    // The blocks wrap the query that was given, indenting it; nothing else.
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    expect(flat(viz.query)).toBe(flat(`( $rows := $; $rows := (${query}); $rows )`));
    // And it gives the rows the query alone gives.
    const read = await call('get_visualization', { visualization_id: viz.id });
    expect(read.value).toMatchObject({ name: 'Win rate', kind: 'chart', chart: { type: 'bar' }, query: viz.query, link: created.value.link });
    expect(read.value.results).toEqual((await call('run_query', { file_ids: [pilots, itself], query })).value.results);
    expect((await call('get_visualization', { visualization_id: viz.id, limit: 0 })).value).not.toHaveProperty('results');
    expect((await call('list_projects')).value.projects[0].visualizations).toEqual([{ id: viz.id, name: 'Win rate', kind: 'bar chart', file_ids: [pilots, itself] }]);
  });

  it('create a table, and a chart with the columns it is told to use', async () => {
    const table = await call('create_visualization', { file_ids: [pilots], name: 'Labels', query: '$.{"label": label, "version": version}', kind: 'table' });
    expect(table.value).toMatchObject({ kind: 'table', columns: ['label', 'version'] });
    expect(table.value).not.toHaveProperty('chart');
    const chart = await call('create_visualization', {
      file_ids: [pilots],
      name: 'By label',
      query: '$.{"version": version, "rate": `win-rate`, "wins": suite.`vs-pilot`.wins, "label": label}',
      x: 'version',
      y: ['wins'],
      split_by: 'label',
      chart_type: 'scatter',
    });
    expect(chart.value.chart).toEqual({ type: 'scatter', x: 'version', y: ['wins'], split_by: 'label' });
    expect(store.getState().visualizations.find((viz) => viz.id === chart.value.id)!.chart).toMatchObject({ type: 'scatter', x: 'version', y: ['wins'], splitBy: 'label' });
  });

  it('create nothing from a query that would not show anything', async () => {
    const before = store.getState().visualizations.length;
    const refusal = async (args: Record<string, unknown>) => {
      const answer = await call('create_visualization', { file_ids: [pilots], name: 'Nope', query: '$.{"version": version, "label": label}', ...args });
      expect(answer.failed).toBe(true);
      return answer.text;
    };
    expect(await refusal({ query: '$[version >' })).toMatch(/^Nothing was created: the query fails on pilots\.jsonl \(.+\)\.$/);
    expect(await refusal({ query: '$[version > 99]' })).toBe('Nothing was created: the query gives no rows on these files.');
    expect(await refusal({ x: 'when' })).toBe('Nothing was created: the query has no column "when". Its columns are: version, label.');
    expect(await refusal({ y: ['label'] })).toBe('Nothing was created: `y` takes columns of numbers, and "label" is not.');
    expect(await refusal({ query: '$.{"label": label}' })).toContain('a chart needs a column for the X axis and at least one column of numbers to plot. The query\'s columns are: label (text).');
    expect(await refusal({ file_ids: [pilots, other] })).toContain('the files are in different projects');
    expect(store.getState().visualizations).toHaveLength(before);
  });

  it('sum up a call in a few words', () => {
    expect(describeCall('run_query', { query: '$count($)' })).toBe('$count($)');
    expect(describeCall('describe_file', { file_id: pilots, path: ['suite', '*'] })).toBe('pilots.jsonl ▸ suite.*');
    expect(describeCall('create_visualization', { name: 'Win rate' })).toBe('Win rate');
    expect(describeCall('list_projects', undefined)).toBe('');
  });
});

// ── From an MCP client to the page and back ──────────────────────────────────

const TIMINGS = { handshake: 500, ping: 10_000, pageWait: 80, call: 2000, retry: 30 };

/** An MCP client on a pair of pipes; see bridge.test.ts for the bridge on its own. */
function mcpClient(bridgeInput: PassThrough, bridgeOutput: PassThrough) {
  const waiting = new Map<number, (message: any) => void>();
  let buffer = '';
  let nextId = 1;
  bridgeOutput.on('data', (chunk) => {
    buffer += String(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message);
    }
  });
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      bridgeInput.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method: string) => bridgeInput.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { request, notify, tool: async (name: string, args: unknown = {}) => (await request('tools/call', { name, arguments: args })).result };
}

describe('an MCP client, through the bridge, to the page', () => {
  const token = newToken();
  const states: LinkState[] = [];
  const phase = () => states.at(-1)?.phase;
  let bridge: Bridge;
  let link: Link;
  let client: ReturnType<typeof mcpClient>;

  const until = async (condition: () => boolean, what: string) => {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > 3000) throw new Error(`Timed out waiting for ${what}; the link is ${phase()}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const pageLink = (options: Partial<Parameters<typeof openLink>[0]> = {}) =>
    openLink({ port: bridge.port, token, tools: TOOLS, call: (name, args, from) => callTool(name, args, { ...context, client: from }), onChange: (state) => states.push(state), retryDelays: [20], refusedDelay: 40, pairingTimeout: 300, ...options });

  beforeAll(async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    bridge = startBridge({ input, output, token, port: 0, timings: TIMINGS });
    client = mcpClient(input, output);
    await bridge.settled;
    const hello = await client.request('initialize', { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1' } });
    expect(hello.result.serverInfo.name).toBe('json-explorer');
    client.notify('notifications/initialized');
  });

  afterAll(() => {
    link?.close();
    bridge.close();
  });

  it('computes the same proof of the pairing code in the page as in the bridge', async () => {
    expect(await proofOf(token, 'page', 'client-nonce', 'server-nonce')).toBe(bridgeProof(token, 'page', 'client-nonce', 'server-nonce'));
    expect(await proofOf(token, 'bridge', 'ünïcode', 'x')).toBe(bridgeProof(token, 'bridge', 'ünïcode', 'x'));
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('pairs, and learns which client it is serving', async () => {
    link = pageLink();
    await until(() => phase() === 'connected', 'the page to connect');
    expect(states.at(-1)).toEqual({ phase: 'connected', clients: [{ name: 'Claude Code', version: '2.1' }], bridgeVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), behind: null, attempts: 0, unsure: false });
    expect(LINK_VERSION).toBe(1);
  });

  it('lists the tools of the page', async () => {
    expect((await client.request('tools/list')).result.tools).toEqual(JSON.parse(JSON.stringify(TOOLS)));
  });

  it('answers the calls of the client from the data in the browser', async () => {
    const listed = JSON.parse((await client.tool('list_projects')).content[0].text);
    expect(listed.projects[0].files.map((file: any) => file.name)).toEqual(['pilots.jsonl', 'itself.jsonl']);
    const queried = await client.tool('run_query', { file_ids: [pilots], query: '$sum(suite.*.wins)' });
    expect(JSON.parse(queried.content[0].text).results[0].rows).toEqual([[35]]);
    const refused = await client.tool('run_query', { file_ids: [pilots] });
    expect(refused).toEqual({ content: [{ type: 'text', text: '`query` is required.' }], isError: true });

    announced.length = 0;
    const created = await client.tool('create_visualization', { file_ids: [pilots], name: 'Through the bridge', query: '$.{"version": version, "rate": `win-rate`}' });
    expect(JSON.parse(created.content[0].text)).toMatchObject({ name: 'Through the bridge', chart: { x: 'version', y: ['rate'] } });
    expect(announced).toEqual(['Claude Code added “Through the bridge” to Self-play runs.']);
  });

  it('looks for the bridge again when it has gone, and finds the next one', async () => {
    const port = bridge.port;
    bridge.close();
    await until(() => phase() === 'waiting', 'the page to notice');
    expect(states.at(-1)).toMatchObject({ clients: [], attempts: 0 });
    await until(() => (states.at(-1)?.attempts ?? 0) >= 2, 'a few attempts');

    const input = new PassThrough();
    const output = new PassThrough();
    bridge = startBridge({ input, output, token, port, timings: TIMINGS });
    client = mcpClient(input, output);
    await client.request('initialize', { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'cursor' } });
    await until(() => phase() === 'connected', 'the page to connect again');
    expect(JSON.parse((await client.tool('run_query', { file_ids: [itself], query: '$count($)' })).content[0].text).results[0].rows).toEqual([[3]]);
    expect(states.at(-1)!.clients).toEqual([{ name: 'cursor' }]);
  });

  it('does not answer a bridge that does not know the pairing code', async () => {
    link.close();
    states.length = 0;
    const calls: string[] = [];
    const stranger = pageLink({ token: newToken(), call: async (name) => (calls.push(name), { content: [] }) });
    await until(() => phase() === 'rejected', 'the page to be turned away');
    expect(states.at(-1)).toMatchObject({ phase: 'rejected', attempts: 1 });
    expect((await client.tool('list_projects')).isError).toBe(true);
    expect(calls).toEqual([]);
    // It keeps asking, in case the code is put right on the other side.
    await until(() => states.at(-1)!.attempts >= 2, 'another attempt');
    stranger.close();
  });

  it('says which side is behind when the versions differ', async () => {
    states.length = 0;
    const RealWebSocket = globalThis.WebSocket;
    // A bridge from the future: it answers the hello of this page with a refusal.
    class Newer extends RealWebSocket {
      override send(data: string): void {
        const message = JSON.parse(data);
        super.send(JSON.stringify(message.t === 'hello' ? { ...message, v: LINK_VERSION - 1 } : message));
      }
    }
    vi.stubGlobal('WebSocket', Newer);
    const old = pageLink();
    await until(() => phase() === 'outdated', 'the versions to be compared');
    expect(states.at(-1)).toMatchObject({ phase: 'outdated', behind: 'page' });
    old.close();
    vi.unstubAllGlobals();
  });
});

// ── The browser's say in it ──────────────────────────────────────────────────

describe('a browser that asks before a site may connect to the computer', () => {
  /** The browser's permission, as a page sees it, with the answer set from outside. */
  function permissionOf(initial: string) {
    const listeners = new Set<() => void>();
    return {
      state: initial,
      addEventListener: (_type: 'change', listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) => void listeners.delete(listener),
      answer(state: string) {
        this.state = state;
        for (const listener of listeners) listener();
      },
      listeners,
    };
  }

  /** A link to a port where nothing listens, which is also what a refusal by the browser looks like. */
  async function deadLink(permission: Parameters<typeof openLink>[0]['permission']) {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    const states: LinkState[] = [];
    const link = openLink({ port, token: newToken(), tools: TOOLS, call: async () => ({ content: [] }), onChange: (state) => states.push(state), retryDelays: [15], permission });
    const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
    const last = () => states.at(-1)!;
    /** Waits for the link to have tried this many times in a row. */
    const attempts = async (count: number) => {
      for (let waited = 0; last().attempts < count; waited += 5) {
        if (waited > 3000) throw new Error(`The link stopped at ${last().attempts} attempts, ${last().phase}`);
        await settle(5);
      }
    };
    return { link, states, settle, last, attempts };
  }

  it('is not asked over and over while there is no answer', async () => {
    const permission = permissionOf('prompt');
    const { link, last, settle, attempts } = await deadLink(async () => permission);
    await attempts(1);
    await settle();
    expect(last()).toMatchObject({ phase: 'unanswered', attempts: 1, unsure: false });

    // Asking again is for the person at the screen to decide.
    link.retry();
    await attempts(2);
    await settle();
    expect(last()).toMatchObject({ phase: 'unanswered', attempts: 2 });

    // Once the answer is yes, the page looks for the bridge like anywhere else.
    permission.answer('granted');
    await attempts(5);
    expect(last().phase).toBe('waiting');
    link.close();
    expect(permission.listeners.size).toBe(0);
  });

  it('is taken at its word when the answer is no', async () => {
    const permission = permissionOf('denied');
    const { link, last, settle, attempts } = await deadLink(async () => permission);
    await attempts(1);
    await settle();
    expect(last()).toMatchObject({ phase: 'forbidden', attempts: 1 });
    link.close();
  });

  it('may be the reason nothing answers, when it does not say', async () => {
    const silent = await deadLink(async () => null);
    await silent.attempts(3);
    expect(silent.last()).toMatchObject({ phase: 'waiting', unsure: true });
    silent.link.close();

    // A page served from the computer itself is not asked about.
    const local = await deadLink(async () => 'unneeded');
    await local.attempts(3);
    expect(local.last()).toMatchObject({ phase: 'waiting', unsure: false });
    local.link.close();
  });
});
