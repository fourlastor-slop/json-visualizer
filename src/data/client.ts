/** The page's side of the data worker: typed calls, and a cache of query results. */
import { QueryError, type QueryResult } from './query';
import type { DataFile } from './types';
import type { DataApi, WorkerRequest, WorkerResponse } from './worker';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function start(): Worker {
  const instance = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  instance.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const call = pending.get(response.id);
    if (!call) return;
    pending.delete(response.id);
    if (response.ok) {
      call.resolve(response.result);
    } else {
      const { name, message, code, position } = response.error;
      call.reject(name === 'QueryError' ? new QueryError(message, code, position) : new Error(message));
    }
  });
  instance.addEventListener('error', (event) => {
    // The worker itself broke. Fail what was in flight and start afresh on the next call.
    const error = new Error(event.message || 'The data worker stopped unexpectedly.');
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    instance.terminate();
    if (worker === instance) worker = null;
  });
  return instance;
}

function call<M extends keyof DataApi>(method: M, ...args: Parameters<DataApi[M]>): ReturnType<DataApi[M]> {
  worker ??= start();
  const id = nextId++;
  const request: WorkerRequest = { id, method, args };
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  worker.postMessage(request);
  return result as ReturnType<DataApi[M]>;
}

export const ingestFile: DataApi['ingest'] = (request) => call('ingest', request);
export const previewFile: DataApi['preview'] = (fileId, rev, offset, limit) => call('preview', fileId, rev, offset, limit);
export const forgetFiles: DataApi['forget'] = (fileIds) => call('forget', fileIds);

const RESULT_CACHE_SIZE = 40;
const results = new Map<string, Promise<QueryResult>>();

/**
 * Runs a query on a file. Results are cached per file revision, so a dashboard showing
 * the same query in several places computes it once. With `maxRows` only that many rows
 * leave the worker, for callers that want a sample and the total.
 */
export function runFileQuery(file: Pick<DataFile, 'id' | 'rev'>, query: string, maxRows?: number): Promise<QueryResult> {
  const key = `${file.id}\n${file.rev}\n${maxRows ?? ''}\n${query}`;
  const cached = results.get(key);
  if (cached) {
    results.delete(key);
    results.set(key, cached);
    return cached;
  }
  const result = call('run', file.id, file.rev, query, maxRows);
  results.set(key, result);
  // A failure may be transient (the worker restarting), so it is not kept.
  result.catch(() => {
    if (results.get(key) === result) results.delete(key);
  });
  while (results.size > RESULT_CACHE_SIZE) results.delete(results.keys().next().value!);
  return result;
}
