/** Looking at result rows as a table: which columns there are and what they hold. */
import type { Row } from '../data/query';

export type ColumnType = 'number' | 'date' | 'text' | 'boolean' | 'other' | 'empty';

export interface ColumnInfo {
  name: string;
  type: ColumnType;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value);
}

/** Milliseconds since the epoch for an ISO date or a Unix timestamp; NaN otherwise. */
export function toTime(value: unknown): number {
  if (typeof value === 'number') {
    // Timestamps in seconds are still ten digits long; in milliseconds, thirteen.
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && ISO_DATE.test(value)) return Date.parse(value.replace(' ', 'T'));
  return Number.NaN;
}

/** Rows scanned per file to decide a column's type. Keys are collected from all rows. */
const TYPE_SAMPLE = 20_000;

/** The columns of one or more row sets, in order of first appearance. */
export function describeColumns(rowSets: readonly Row[][]): ColumnInfo[] {
  const seen = new Map<string, Record<Exclude<ColumnType, 'empty'>, number>>();
  for (const rows of rowSets) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      for (const name in row) {
        let counts = seen.get(name);
        if (!counts) seen.set(name, (counts = { number: 0, date: 0, text: 0, boolean: 0, other: 0 }));
        if (i >= TYPE_SAMPLE) continue;
        const value = row[name];
        if (value === null || value === undefined) continue;
        if (typeof value === 'number') counts.number++;
        else if (typeof value === 'boolean') counts.boolean++;
        else if (typeof value === 'string') counts[ISO_DATE.test(value) ? 'date' : 'text']++;
        else counts.other++;
      }
    }
  }
  return Array.from(seen, ([name, counts]) => {
    const present = (Object.entries(counts) as Array<[Exclude<ColumnType, 'empty'>, number]>).filter(([, n]) => n > 0);
    if (present.length === 0) return { name, type: 'empty' };
    if (present.length === 1) return { name, type: present[0]![0] };
    // Dates mixed with other text are just text; anything else mixed is text if it has no
    // objects or lists in it.
    return { name, type: counts.other > 0 ? 'other' : 'text' };
  });
}
