/**
 * What a query gives back, and how it fails. Kept apart from engine.ts so that the page,
 * which only ever talks to the data worker, does not bundle the JSONata engine itself.
 */

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  /** Rows produced by the query; larger than `rows.length` when the result was capped. */
  total: number;
  ms: number;
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}
