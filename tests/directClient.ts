/**
 * Stands in for src/data/client.ts in tests. There are no workers here, so the calls the
 * page would send to the data worker go straight to the code the worker runs.
 *
 *   vi.mock('../src/data/client', () => import('./directClient'));
 */
import * as engine from '../src/data/engine';
import * as files from '../src/data/files';

export const ingestFile = files.ingest;

export async function forgetFiles(ids: string[]): Promise<void> {
  files.forget(ids);
}

export async function previewFile(fileId: string, rev: number, offset: number, limit: number) {
  const records = await files.loadRecords(fileId, rev);
  return { rows: engine.toRows(records.slice(offset, offset + limit)).rows, total: records.length };
}

export async function runFileQuery(file: { id: string; rev: number }, query: string, maxRows?: number) {
  return engine.runQuery(query, await files.loadRecords(file.id, file.rev), maxRows === undefined ? {} : { maxRows });
}
