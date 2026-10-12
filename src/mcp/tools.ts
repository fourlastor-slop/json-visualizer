/**
 * The tools an MCP client can call. They run here in the page, on the same store, files
 * and query engine as the interface; the bridge only carries the calls. What each tool is
 * called and takes is defined in mcp-bridge/tools.json, which the bridge reads too.
 */
import definitions from '../../mcp-bridge/tools.json';
import { pathToJsonata } from '../blocks/path';
import { runFileQuery } from '../data/client';
import { QueryError, type QueryResult, type Row } from '../data/query';
import { type JsonType, type Path, type SchemaNode, childSchema, isSequenceLike, keysOf, mergeAll, observedTypes, resolvePath } from '../data/schema';
import { type AppState, createVisualization, getState } from '../data/store';
import { type ChartConfig, DEFAULT_CHART, DEFAULT_TABLE, type DataFile, type Visualization } from '../data/types';
import { plural } from '../lib/format';
import { hrefFor } from '../lib/router';
import { resolveColumns } from '../viz/chartModel';
import { describeColumns } from '../viz/columns';
import type { ToolDefinition, ToolResult } from './protocol';
import { ArgumentError, checkArguments } from './validate';

// TypeScript reads a JSON file as the exact shape of its contents, which is no schema.
export const TOOLS = definitions as unknown as ToolDefinition[];

export interface ToolContext {
  /** Address of the app; a route's hash is appended to it to make a link. */
  baseUrl: string;
  /** Name of the MCP client that is calling, when it gave one. */
  client: string | null;
  /** Tells the person at the screen what was just done on their behalf. */
  announce(message: string): void;
}

/** A call that cannot be carried out. The message goes back to the model as the answer. */
export class ToolFailure extends Error {}

/** Characters of JSON a result may take: about ten thousand tokens of the model's context. */
const RESULT_BUDGET = 40_000;
/** Characters a single value may take once a result has to be cut down. */
const MAX_VALUE_LENGTH = 400;
const MAX_LISTED_FIELDS = 40;
/** Lines a description of a file may take. The fields asked about come first. */
const MAX_DESCRIBED_LINES = 300;
/** Keys listed for an object that is shown as part of another. */
const MAX_NESTED_KEYS = 40;
/** Characters of key names given when an object has more keys than can be described. */
const MAX_NAMES_LENGTH = 3000;
/** Rows looked at to learn the columns of a query before a visualization is made of it. */
const COLUMN_SAMPLE = 500;

const quote = (text: string) => JSON.stringify(text);

function loaded(): AppState {
  const state = getState();
  if (!state.ready) throw new ToolFailure('JSON Explorer is still loading. Try again in a moment.');
  if (state.failure) throw new ToolFailure(`JSON Explorer could not open the browser's storage: ${state.failure}`);
  return state;
}

/** A file by id. Its name is accepted too where only one file has it: models mix them up. */
function fileOf(state: AppState, id: string): DataFile {
  const file = state.files.find((candidate) => candidate.id === id);
  if (file) return file;
  const named = state.files.filter((candidate) => candidate.name === id);
  if (named.length === 1) return named[0]!;
  throw new ToolFailure(`There is no file with the id ${quote(id)}. list_projects gives the ids.`);
}

function filesOf(state: AppState, ids: string[]): DataFile[] {
  return [...new Set(ids)].map((id) => fileOf(state, id));
}

function vizOf(state: AppState, id: string): Visualization {
  const viz = state.visualizations.find((candidate) => candidate.id === id);
  if (!viz) throw new ToolFailure(`There is no visualization with the id ${quote(id)}. list_projects gives the ids.`);
  return viz;
}

function linkTo(context: ToolContext, viz: Visualization): string {
  return context.baseUrl + hrefFor({ page: 'view', projectId: viz.projectId, vizId: viz.id, table: false });
}

// ── Query results ────────────────────────────────────────────────────────────

function describeError(error: unknown): string {
  if (error instanceof QueryError && error.position !== undefined) return `${error.message} (at character ${error.position} of the query)`;
  return error instanceof Error ? error.message : String(error);
}

interface Outcome {
  file: DataFile;
  result?: QueryResult;
  error?: string;
}

function runOn(files: DataFile[], query: string, maxRows: number): Promise<Outcome[]> {
  return Promise.all(
    files.map((file) =>
      runFileQuery(file, query, maxRows).then(
        (result): Outcome => ({ file, result }),
        (error: unknown): Outcome => ({ file, error: describeError(error) }),
      ),
    ),
  );
}

/**
 * Rows as a table: the column names once, then one list of values per row. Result rows
 * repeat their keys, and each repetition would be paid for in the model's context.
 */
function tabulate(rows: Row[]): { columns: string[]; rows: unknown[][] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name in row) {
      if (!seen.has(name)) {
        seen.add(name);
        columns.push(name);
      }
    }
  }
  return { columns, rows: rows.map((row) => columns.map((name) => row[name] ?? null)) };
}

/** As many rows as fit in `budget` characters, long values shortened first. */
function fit(rows: unknown[][], budget: number): { rows: unknown[][]; shortened: boolean } {
  if (JSON.stringify(rows).length <= budget) return { rows, shortened: false };
  let shortened = false;
  const clipped = rows.map((row) =>
    row.map((value) => {
      const json = JSON.stringify(value);
      if (json.length <= MAX_VALUE_LENGTH) return value;
      shortened = true;
      return `${(typeof value === 'string' ? value : json).slice(0, MAX_VALUE_LENGTH)}…`;
    }),
  );
  let used = 0;
  let kept = 0;
  for (const row of clipped) {
    used += JSON.stringify(row).length + 1;
    if (used > budget && kept > 0) break;
    kept++;
  }
  return { rows: clipped.slice(0, kept), shortened };
}

function report(outcomes: Outcome[], budget: number): unknown[] {
  return outcomes.map(({ file, result, error }) => {
    const id = { file_id: file.id, file: file.name };
    if (!result) return { ...id, error };
    const table = tabulate(result.rows);
    // The column names are part of the answer too, and a wide table has many.
    const { rows, shortened } = fit(table.rows, Math.floor(budget / outcomes.length) - JSON.stringify(table.columns).length);
    const notes: string[] = [];
    if (rows.length < result.total) notes.push(`These are the first ${rows.length} of ${result.total} rows.`);
    if (rows.length < table.rows.length) notes.push('Fewer rows than asked for are shown, to keep the answer short: select fewer columns or aggregate.');
    if (shortened) notes.push('Long values are cut short, ending in "…".');
    return { ...id, total_rows: result.total, columns: table.columns, rows, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  });
}

// ── Describing a file ────────────────────────────────────────────────────────

const TYPE_NAMES: Record<JsonType, string> = { null: 'null', boolean: 'boolean', number: 'number', string: 'string', object: 'object', array: 'list' };

const compact = (n: number) => String(Number.isInteger(n) ? n : Number(n.toPrecision(6)));

/** How many objects were seen at a position, looking through lists like a path does. */
function holders(node: SchemaNode): number {
  return (node.types.object ?? 0) + (node.items ? holders(node.items) : 0);
}

/** A field in a few words: its type, then its range, examples or size, and how common it is. */
function summarize(node: SchemaNode, parents: number): string {
  const types = observedTypes(node);
  const parts = [types.map((type) => TYPE_NAMES[type]).join(' or ') || 'never seen'];
  if (types.length === 1) {
    const [type] = types;
    if (type === 'number' && node.min !== undefined && node.max !== undefined) {
      parts.push(node.min === node.max ? `always ${compact(node.min)}` : `${compact(node.min)} to ${compact(node.max)}`);
      if (isSequenceLike(node)) parts.push('increasing from one record to the next');
    } else if (type === 'string' && node.examples?.length) {
      parts.push(`e.g. ${node.examples.map((example) => JSON.stringify(example)).join(', ')}`);
    } else if (type === 'object') {
      const keys = keysOf(node).length;
      parts.push(`${keys}${node.overflow ? ' or more' : ''} ${keys === 1 ? 'key' : 'keys'}`);
    } else if (type === 'array' && node.items) {
      const inner = observedTypes(node.items);
      if (inner.length > 0) parts.push(`of ${inner.map((item) => (item === 'object' ? `objects with ${plural(keysOf(node.items).length, 'key')}` : `${TYPE_NAMES[item]}s`)).join(' or ')}`);
    }
  }
  if ((node.types.null ?? 0) > 0 && types[0] !== 'null') parts.push('sometimes null');
  if (node.count < parents) parts.push(`in ${node.count} of ${parents}`);
  return parts.join(', ');
}

function describeFile(file: DataFile, path: string[], depth: number): string {
  const segments: Path = path.map((segment) => (segment === '*' ? null : segment));
  const start = resolvePath(file.schema, segments);
  if (!start) {
    // Say how far the path does lead, and what is there.
    let known = 0;
    while (known < segments.length && resolvePath(file.schema, segments.slice(0, known + 1))) known++;
    const reached = resolvePath(file.schema, segments.slice(0, known));
    const keys = keysOf(reached);
    const where = known === 0 ? 'A record' : pathToJsonata(null, segments.slice(0, known));
    throw new ToolFailure(
      `${file.name} has no ${pathToJsonata(null, segments.slice(0, known + 1))}. ${where} has ${keys.length > 0 ? `the keys: ${keys.slice(0, MAX_LISTED_FIELDS).join(', ')}${keys.length > MAX_LISTED_FIELDS ? ', …' : ''}` : 'no keys'}.`,
    );
  }

  // The fields asked about are all described before any of them is opened up: a record
  // with a hundred fields should not lose the last sixty to the insides of the first.
  const lines: string[] = [];
  let room = MAX_DESCRIBED_LINES - Math.min(keysOf(start).length, MAX_DESCRIBED_LINES);
  let unopened = false;
  const walk = (node: SchemaNode, at: Path, level: number): void => {
    const keys = keysOf(node);
    const shown = keys.slice(0, level === 0 ? MAX_DESCRIBED_LINES : MAX_NESTED_KEYS);
    const parents = holders(node);
    const indent = '  '.repeat(level);
    for (const key of shown) {
      const child = childSchema(node, key);
      if (!child) continue;
      const path = [...at, key];
      const own = pathToJsonata(null, [key]);
      // Under another field, only the step that continues its path is written out.
      const name = level === 0 || own.startsWith('$') ? pathToJsonata(null, path) : `.${own}`;
      lines.push(`${indent}${name}: ${summarize(child, parents)}`);
      const inside = Math.min(keysOf(child).length, MAX_NESTED_KEYS);
      if (level + 1 >= depth || inside === 0) continue;
      if (inside > room) {
        unopened = true;
        continue;
      }
      room -= inside;
      walk(child, path, level + 1);
    }
    if (keys.length > shown.length || node.overflow) {
      const rest = keys.slice(shown.length);
      let names = rest.join(', ');
      if (names.length > MAX_NAMES_LENGTH) names = `${names.slice(0, names.lastIndexOf(', ', MAX_NAMES_LENGTH))}, …`;
      const count = node.overflow ? 'many' : String(rest.length);
      lines.push(`${indent}… and ${count} more keys${rest.length > 0 ? `: ${names}` : ''}. Describe one by adding it to \`path\`, or all at once with "*" in their place if they hold the same kind of value.`);
    }
  };
  walk(start, segments, 0);

  const subject = segments.length === 0 ? `${file.name} has ${plural(file.records, 'record')}.` : `${file.name}, ${pathToJsonata(null, segments)}: ${summarize(start, 0)}.`;
  if (lines.length === 0) return `${subject} ${segments.length === 0 ? `A record is ${summarize(start, 0)}, with no fields.` : 'It has no fields of its own.'}`;
  const legend = 'Each line is a field: its JSONata path from a record, its type, and what was seen in it. An indented line continues the path of the line it is under. Paths look through lists.';
  const ending = unopened ? '\nSome objects are not opened up here, to keep this short. Describe them on their own with `path`.' : '';
  return `${subject} ${legend}\n${lines.join('\n')}${ending}`;
}

// ── Creating a visualization ─────────────────────────────────────────────────

/**
 * The blocks for a query written as text: the "set rows to JSONata" step under the root.
 * A visualization is its blocks, so this is what the editor opens on.
 */
function rawWorkspace(query: string): unknown {
  return { blocks: { languageVersion: 0, blocks: [{ type: 'jx_query', x: 24, y: 24, deletable: false, next: { block: { type: 'jx_raw_step', fields: { CODE: query } } } }] } };
}

interface CreateArguments {
  file_ids: string[];
  name: string;
  query: string;
  kind: 'chart' | 'table';
  chart_type: ChartConfig['type'];
  x?: string;
  y?: string[];
  split_by?: string;
}

async function createFromQuery(args: CreateArguments, context: ToolContext): Promise<unknown> {
  const state = loaded();
  const files = filesOf(state, args.file_ids);
  const project = state.projects.find((candidate) => candidate.id === files[0]!.projectId);
  if (!project || files.some((file) => file.projectId !== project.id)) {
    throw new ToolFailure('Nothing was created: the files are in different projects. A visualization belongs to one project and runs on files of that project.');
  }

  // The query is stored the way the blocks generate it, so that the editor shows the same.
  const workspace = rawWorkspace(args.query);
  const { compileState } = await import('../blocks/headless');
  const compiled = compileState(
    workspace,
    mergeAll(files.map((file) => file.schema)),
    files.map((file) => ({ name: file.name, schema: file.schema })),
  );

  const outcomes = await runOn(files, compiled.query, COLUMN_SAMPLE);
  const failed = outcomes.filter((outcome) => !outcome.result);
  if (failed.length > 0) throw new ToolFailure(`Nothing was created: the query fails on ${failed.map((outcome) => `${outcome.file.name} (${outcome.error})`).join(' and on ')}.`);
  const columns = describeColumns(outcomes.map((outcome) => outcome.result!.rows));
  const names = columns.map((column) => column.name);
  if (columns.length === 0) throw new ToolFailure('Nothing was created: the query gives no rows on these files.');

  let chart = DEFAULT_CHART;
  let drawn: unknown;
  if (args.kind === 'chart') {
    const asked = [args.x, ...(args.y ?? []), args.split_by].filter((name): name is string => name !== undefined);
    const missing = asked.filter((name) => !names.includes(name));
    if (missing.length > 0) throw new ToolFailure(`Nothing was created: the query has no column ${missing.map(quote).join(' or ')}. Its columns are: ${names.join(', ')}.`);
    const notNumbers = (args.y ?? []).filter((name) => columns.find((column) => column.name === name)?.type !== 'number');
    if (notNumbers.length > 0) throw new ToolFailure(`Nothing was created: \`y\` takes columns of numbers, and ${notNumbers.map(quote).join(' and ')} ${notNumbers.length === 1 ? 'is' : 'are'} not.`);

    chart = { ...DEFAULT_CHART, type: args.chart_type, x: args.x ?? null, y: args.y ?? null, splitBy: args.split_by ?? null };
    const resolved = resolveColumns(columns, chart);
    if (!resolved.x || resolved.y.length === 0) {
      throw new ToolFailure(`Nothing was created: a chart needs a column for the X axis and at least one column of numbers to plot. The query's columns are: ${columns.map((column) => `${column.name} (${column.type})`).join(', ')}. Use kind "table" for rows without numbers.`);
    }
    drawn = { type: chart.type, x: resolved.x.name, y: resolved.y.map((column) => column.name), ...(resolved.splitBy ? { split_by: resolved.splitBy.name } : {}) };
  }

  const viz = await createVisualization(
    project.id,
    files.map((file) => file.id),
    { name: args.name.trim() || 'Untitled', kind: args.kind, workspace, query: compiled.query, fields: compiled.fields, chart, table: DEFAULT_TABLE },
  );
  context.announce(`${context.client ?? 'An MCP client'} added “${viz.name}” to ${project.name}.`);
  return {
    id: viz.id,
    name: viz.name,
    kind: viz.kind,
    project: project.name,
    link: linkTo(context, viz),
    ...(drawn ? { chart: drawn } : {}),
    columns: names,
    files: outcomes.map((outcome) => ({ file: outcome.file.name, rows: outcome.result!.total })),
  };
}

// ── The tools ────────────────────────────────────────────────────────────────

/**
 * Arguments reach a handler checked against the tool's schema, with defaults filled in:
 * each handler states the shape its schema guarantees.
 */
type Handler = (args: never, context: ToolContext) => unknown;

const HANDLERS: Record<string, Handler> = {
  list_projects() {
    const state = loaded();
    const projects = state.projects.map((project) => ({
      id: project.id,
      name: project.name,
      files: state.files
        .filter((file) => file.projectId === project.id)
        .map((file) => {
          const fields = keysOf(file.schema);
          return {
            id: file.id,
            name: file.name,
            records: file.records,
            fields: fields.slice(0, MAX_LISTED_FIELDS),
            ...(fields.length > MAX_LISTED_FIELDS ? { more_fields: fields.length - MAX_LISTED_FIELDS } : {}),
          };
        }),
      visualizations: state.visualizations
        .filter((viz) => viz.projectId === project.id)
        .map((viz) => ({ id: viz.id, name: viz.name, kind: viz.kind === 'chart' ? `${viz.chart.type} chart` : 'table', file_ids: viz.fileIds })),
    }));
    return projects.length > 0 ? { projects } : { projects, note: 'There are no projects yet. The user creates projects and uploads files in the app.' };
  },

  describe_file(args: { file_id: string; path?: string[]; depth: number }) {
    return describeFile(fileOf(loaded(), args.file_id), args.path ?? [], args.depth);
  },

  async run_query(args: { file_ids: string[]; query: string; limit: number }) {
    const outcomes = await runOn(filesOf(loaded(), args.file_ids), args.query, args.limit);
    if (outcomes.every((outcome) => !outcome.result)) {
      throw new ToolFailure(`The query failed: ${[...new Set(outcomes.map((outcome) => outcome.error))].join('; ')}`);
    }
    return { results: report(outcomes, RESULT_BUDGET) };
  },

  async get_visualization(args: { visualization_id: string; limit: number }, context) {
    const state = loaded();
    const viz = vizOf(state, args.visualization_id);
    const files = viz.fileIds.map((id) => state.files.find((file) => file.id === id)).filter((file): file is DataFile => file !== undefined);
    const { type, x, y, splitBy } = viz.chart;
    return {
      id: viz.id,
      name: viz.name,
      project: state.projects.find((project) => project.id === viz.projectId)?.name,
      kind: viz.kind,
      ...(viz.kind === 'chart' ? { chart: { type, x: x ?? 'the first column', y: y ?? 'the numeric columns', ...(splitBy ? { split_by: splitBy } : {}) } } : {}),
      files: files.map((file) => ({ id: file.id, name: file.name })),
      query: viz.query,
      link: linkTo(context, viz),
      ...(args.limit > 0 && files.length > 0 ? { results: report(await runOn(files, viz.query, args.limit), RESULT_BUDGET) } : {}),
    };
  },

  create_visualization: createFromQuery,
};

/** A few words on what a call is about, for the list of recent calls shown to the user. */
export function describeCall(name: string, args: unknown): string {
  const given = (args ?? {}) as Record<string, unknown>;
  const state = getState();
  const fileNames = (ids: unknown) =>
    (Array.isArray(ids) ? ids : [ids])
      .map((id) => state.files.find((file) => file.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  switch (name) {
    case 'describe_file':
      return [fileNames(given.file_id), Array.isArray(given.path) ? given.path.join('.') : ''].filter(Boolean).join(' ▸ ');
    case 'run_query':
      return typeof given.query === 'string' ? given.query : '';
    case 'get_visualization':
      return state.visualizations.find((viz) => viz.id === given.visualization_id)?.name ?? '';
    case 'create_visualization':
      return typeof given.name === 'string' ? given.name : '';
    default:
      return '';
  }
}

/** Runs a tool. Never throws: what goes wrong becomes an answer that says so. */
export async function callTool(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
  const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
  const definition = TOOLS.find((tool) => tool.name === name);
  const handler = HANDLERS[name];
  if (!definition || !handler) return failure(`JSON Explorer has no tool called ${quote(name)}.`);
  try {
    const value = await handler(checkArguments(definition.inputSchema, args) as never, context);
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
  } catch (error) {
    if (error instanceof ToolFailure || error instanceof ArgumentError) return failure(error.message);
    return failure(`JSON Explorer could not do this: ${error instanceof Error ? error.message : String(error)}`);
  }
}
