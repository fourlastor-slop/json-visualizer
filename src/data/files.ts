/**
 * File contents: storing uploads and reading them back as records. Runs in the data
 * worker, which is the only place that ever holds a whole file in memory.
 */
import { timestamp } from '../lib/clock';
import { chunksOf, done, transact } from './db';
import { formatFromName, parseSource, parseStored } from './parse';
import { inferSchema, mergeSchemas } from './schema';
import type { DataFile, FileChunk } from './types';

export type IngestRequest =
  | { mode: 'create'; file: Pick<DataFile, 'id' | 'projectId' | 'name' | 'color'>; source: Blob | string; sourceName: string }
  | { mode: 'append' | 'replace'; fileId: string; source: Blob | string; sourceName: string };

interface Parsed {
  rev: number;
  records: unknown[];
  size: number;
}

/** Parsed files, least recently used first. */
const cache = new Map<string, Parsed>();
const loading = new Map<string, Promise<unknown[]>>();
const CACHE_BUDGET = 512 * 1024 * 1024;

function remember(fileId: string, entry: Parsed): void {
  cache.delete(fileId);
  cache.set(fileId, entry);
  let total = 0;
  for (const cached of cache.values()) total += cached.size;
  for (const [id, cached] of cache) {
    if (total <= CACHE_BUDGET || id === fileId) break;
    cache.delete(id);
    total -= cached.size;
  }
}

export function forget(fileIds: readonly string[]): void {
  for (const fileId of fileIds) cache.delete(fileId);
}

/**
 * Validates an upload and stores it: as a new file, appended to an existing one, or in
 * place of its contents. Nothing is written unless the whole upload parses.
 */
export async function ingest(request: IngestRequest): Promise<DataFile> {
  const text = typeof request.source === 'string' ? request.source : await request.source.text();
  const { format, records } = parseSource(text, formatFromName(request.sourceName));
  if (records.length === 0) throw new Error('The file contains no records.');
  const schema = inferSchema(records);
  const size = typeof request.source === 'string' ? new Blob([text]).size : request.source.size;
  const now = timestamp();

  const saved = await transact(['files', 'chunks'], 'readwrite', async (tx) => {
    const files = tx.objectStore('files');
    const chunks = tx.objectStore('chunks');
    let file: DataFile;
    if (request.mode === 'create') {
      file = { ...request.file, size, records: records.length, chunks: 1, rev: 1, schema, createdAt: now, updatedAt: now };
      chunks.put({ fileId: file.id, seq: 0, format, text } satisfies FileChunk);
    } else {
      const current = await done(files.get(request.fileId) as IDBRequest<DataFile | undefined>);
      if (!current) throw new Error('This file no longer exists.');
      if (request.mode === 'append') {
        file = {
          ...current,
          size: current.size + size,
          records: current.records + records.length,
          chunks: current.chunks + 1,
          rev: current.rev + 1,
          schema: mergeSchemas(current.schema, schema, true),
          updatedAt: now,
        };
        chunks.put({ fileId: current.id, seq: current.chunks, format, text } satisfies FileChunk);
      } else {
        chunks.delete(chunksOf(current.id));
        file = { ...current, size, records: records.length, chunks: 1, rev: current.rev + 1, schema, updatedAt: now };
        chunks.put({ fileId: current.id, seq: 0, format, text } satisfies FileChunk);
      }
    }
    files.put(file);
    return file;
  });

  // The records are parsed already: keep them for the queries that are about to run.
  const previous = cache.get(saved.id);
  if (request.mode !== 'append') {
    remember(saved.id, { rev: saved.rev, records, size: saved.size });
  } else if (previous && previous.rev === saved.rev - 1) {
    remember(saved.id, { rev: saved.rev, records: previous.records.concat(records), size: saved.size });
  } else {
    cache.delete(saved.id);
  }
  return saved;
}

async function read(fileId: string, rev: number): Promise<unknown[]> {
  const chunks = await transact(['chunks'], 'readonly', (tx) => done(tx.objectStore('chunks').getAll(chunksOf(fileId)) as IDBRequest<FileChunk[]>));
  if (chunks.length === 0) throw new Error('The contents of this file are missing from browser storage.');
  let records: unknown[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const part = parseStored(chunk.text, chunk.format);
    records = records.length === 0 ? part : records.concat(part);
    size += chunk.text.length;
  }
  remember(fileId, { rev, records, size });
  return records;
}

/** All records of a file, in upload order. */
export function loadRecords(fileId: string, rev: number): Promise<unknown[]> {
  const cached = cache.get(fileId);
  if (cached && cached.rev === rev) {
    remember(fileId, cached);
    return Promise.resolve(cached.records);
  }
  const key = `${fileId}:${rev}`;
  let pending = loading.get(key);
  if (!pending) {
    pending = read(fileId, rev).finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}
