/** From rows to a table: one file's rows, several files stacked, or files side by side. */
import { seriesColor } from '../data/colors';
import type { TableConfig } from '../data/types';
import type { FileRows } from './chartModel';
import { describeColumns, toTime } from './columns';

export interface TableColumn {
  id: string;
  label: string;
  /** Heading spanning the columns that share it (side-by-side layout). */
  group?: string;
  /** Color of the file this column or cell belongs to. */
  dot?: string;
}

export interface TableModel {
  columns: TableColumn[];
  /** Cell values, row by row, aligned with `columns`. */
  rows: unknown[][];
  /** Per row: the color of its file, when the first column names the file. */
  rowDots: string[] | null;
  notes: string[];
}

function keyLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function buildTable(files: readonly FileRows[], config: TableConfig): TableModel {
  const columns = describeColumns(files.map((file) => file.rows));
  const multiFile = files.length > 1;

  if (!multiFile || config.layout === 'stacked' || columns.length === 0) {
    const rows: unknown[][] = [];
    const rowDots: string[] = [];
    for (const file of files) {
      for (const row of file.rows) {
        const cells = columns.map((column) => row[column.name]);
        rows.push(multiFile ? [file.label, ...cells] : cells);
        if (multiFile) rowDots.push(seriesColor(file.color));
      }
    }
    const dataColumns = columns.map((column) => ({ id: column.name, label: column.name }));
    return { columns: multiFile ? [{ id: '\u0000file', label: 'file' }, ...dataColumns] : dataColumns, rows, rowDots: multiFile ? rowDots : null, notes: [] };
  }

  // Side by side: one row per key value, one column per file for every other column.
  const key = columns.find((column) => column.name === config.key) ?? columns[0]!;
  const others = columns.filter((column) => column !== key);
  const byKey = new Map<string, { value: unknown; cells: unknown[] }>();
  let repeated = 0;
  files.forEach((file, fileIndex) => {
    const seen = new Set<string>();
    for (const row of file.rows) {
      const label = keyLabel(row[key.name]);
      if (label === null) continue;
      if (seen.has(label)) {
        repeated++;
        continue;
      }
      seen.add(label);
      let entry = byKey.get(label);
      if (!entry) byKey.set(label, (entry = { value: row[key.name], cells: new Array(others.length * files.length).fill(undefined) }));
      others.forEach((column, columnIndex) => {
        entry.cells[columnIndex * files.length + fileIndex] = row[column.name];
      });
    }
  });

  const entries = Array.from(byKey.values());
  if (key.type === 'number') entries.sort((a, b) => (a.value as number) - (b.value as number));
  else if (key.type === 'date') entries.sort((a, b) => toTime(a.value) - toTime(b.value));

  return {
    columns: [
      { id: key.name, label: key.name },
      ...others.flatMap((column) => files.map((file) => ({ id: `${column.name}\u0000${file.id}`, label: file.label, group: column.name, dot: seriesColor(file.color) }))),
    ],
    rows: entries.map((entry) => [entry.value, ...entry.cells]),
    rowDots: null,
    notes: repeated > 0 ? [`${repeated} ${repeated === 1 ? 'row repeats' : 'rows repeat'} a “${key.name}” value within a file; only the first row for each value is shown.`] : [],
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(table: TableModel): string {
  const header = table.columns.map((column) => csvCell(column.group ? `${column.group} (${column.label})` : column.label));
  return [header, ...table.rows.map((row) => row.map(csvCell))].map((line) => line.join(',')).join('\r\n');
}
