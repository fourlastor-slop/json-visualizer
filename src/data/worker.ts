/**
 * The data worker. Parsing uploads, inferring schemas and running queries all happen here,
 * so a large file or a slow query never freezes the page.
 */
import { runQuery, toRows } from './engine';
import { forget, ingest, loadRecords } from './files';
import type { QueryResult, Row } from './query';

const api = {
  ingest,

  /** Runs a query on a file. `maxRows` caps the rows sent back; the total is still counted. */
  async run(fileId: string, rev: number, query: string, maxRows?: number): Promise<QueryResult> {
    return runQuery(query, await loadRecords(fileId, rev), maxRows === undefined ? {} : { maxRows });
  },

  /** A page of a file's raw records. */
  async preview(fileId: string, rev: number, offset: number, limit: number): Promise<{ rows: Row[]; total: number }> {
    const records = await loadRecords(fileId, rev);
    return { rows: toRows(records.slice(offset, offset + limit)).rows, total: records.length };
  },

  async forget(fileIds: string[]): Promise<void> {
    forget(fileIds);
  },
};

export type DataApi = typeof api;

export interface WorkerRequest {
  id: number;
  method: keyof DataApi;
  args: unknown[];
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; position?: number } };

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  const { id, method, args } = event.data;
  const handler = api[method] as (...args: unknown[]) => Promise<unknown>;
  Promise.resolve()
    .then(() => handler(...args))
    .then(
      (result) => scope.postMessage({ id, ok: true, result }),
      (error: unknown) => {
        const info = (error ?? {}) as { name?: string; message?: string; code?: string; position?: number };
        scope.postMessage({
          id,
          ok: false,
          error: { name: info.name ?? 'Error', message: info.message ?? String(error), code: info.code, position: info.position },
        });
      },
    );
});
