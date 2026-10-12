/** Running JSONata queries over records and shaping the result into table rows. */
import jsonata from 'jsonata';
import { QueryError, type QueryResult, type Row } from './query';

export interface QueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STACK_DEPTH = 500;
const COMPILE_CACHE_SIZE = 64;

const compiled = new Map<string, jsonata.Expression>();

function toQueryError(error: unknown): QueryError {
  if (error instanceof QueryError) return error;
  // JSONata throws plain objects carrying a code, a message and often a position.
  const info = (error ?? {}) as { message?: unknown; code?: unknown; position?: unknown };
  const message = typeof info.message === 'string' && info.message !== '' ? info.message : String(error);
  return new QueryError(
    message,
    typeof info.code === 'string' ? info.code : undefined,
    typeof info.position === 'number' ? info.position : undefined,
  );
}

function compile(query: string, timeoutMs: number): jsonata.Expression {
  const key = `${timeoutMs}\n${query}`;
  let expression = compiled.get(key);
  if (!expression) {
    expression = jsonata(query, { timeout: timeoutMs, stack: MAX_STACK_DEPTH });
    if (compiled.size >= COMPILE_CACHE_SIZE) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, expression);
  }
  return expression;
}

/** Deep copy into plain JSON values: drops functions and JSONata's sequence bookkeeping. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'string':
    case 'boolean':
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map(plain);
      const out: Row = {};
      for (const key of Object.keys(value)) {
        const field = (value as Row)[key];
        if (field !== undefined && typeof field !== 'function') out[key] = plain(field);
      }
      return out;
    }
    default:
      return null;
  }
}

function toRow(value: unknown): Row {
  const clean = plain(value);
  if (clean !== null && typeof clean === 'object' && !Array.isArray(clean)) return clean as Row;
  return { value: clean };
}

/** A query result is a table: a list becomes rows, a single value one row. */
export function toRows(result: unknown, maxRows = Infinity): { rows: Row[]; total: number } {
  if (result === undefined) return { rows: [], total: 0 };
  const list = Array.isArray(result) ? result : [result];
  const kept = list.length > maxRows ? list.slice(0, maxRows) : list;
  return { rows: kept.map(toRow), total: list.length };
}

export async function runQuery(query: string, records: readonly unknown[], options: QueryOptions = {}): Promise<QueryResult> {
  const started = performance.now();
  let result: unknown;
  try {
    result = await compile(query, options.timeoutMs ?? DEFAULT_TIMEOUT_MS).evaluate(records);
  } catch (error) {
    throw toQueryError(error);
  }
  const { rows, total } = toRows(result, options.maxRows ?? DEFAULT_MAX_ROWS);
  return { rows, total, ms: performance.now() - started };
}
