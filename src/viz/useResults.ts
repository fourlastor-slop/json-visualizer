/** Running a visualization's query on each of its files. */
import { useEffect, useRef, useState } from 'react';
import { runFileQuery } from '../data/client';
import type { Row } from '../data/query';
import type { DataFile } from '../data/types';

export interface FileResult {
  fileId: string;
  rows: Row[];
  /** Rows the query produced; more than `rows.length` when the result was capped. */
  total: number;
  ms: number;
  error: string | null;
}

export interface Results {
  /** One result per file, for the most recent query that finished. */
  results: FileResult[];
  /** A newer query is running; `results` still show the previous one. */
  pending: boolean;
  /** No query has finished yet. */
  first: boolean;
}

/**
 * The same query runs on every file, each on its own. Results are swapped in together
 * once all are in, so a chart never mixes rows from two different queries.
 */
export function useResults(files: readonly DataFile[], query: string): Results {
  const key = `${files.map((file) => `${file.id}:${file.rev}`).join(',')}\n${query}`;
  const [settled, setSettled] = useState<{ key: string; results: FileResult[] } | null>(null);
  const latest = useRef(files);
  latest.current = files;

  useEffect(() => {
    let stale = false;
    const runs = latest.current.map((file) =>
      runFileQuery(file, query).then(
        (result): FileResult => ({ fileId: file.id, rows: result.rows, total: result.total, ms: result.ms, error: null }),
        (error: unknown): FileResult => ({ fileId: file.id, rows: [], total: 0, ms: 0, error: error instanceof Error ? error.message : String(error) }),
      ),
    );
    void Promise.all(runs).then((results) => {
      if (!stale) setSettled({ key, results });
    });
    return () => {
      stale = true;
    };
    // `key` stands for the files' identities and revisions plus the query: the files
    // array itself is new on every render and would restart the query each time.
  }, [key]);

  return { results: settled?.results ?? [], pending: settled?.key !== key, first: settled === null };
}
