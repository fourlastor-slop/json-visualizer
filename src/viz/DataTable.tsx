/** A sortable table that stays fast with many rows by drawing only the ones in view. */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, formatValue } from '../lib/format';
import type { TableModel } from './tableModel';

interface Props {
  table: TableModel;
  /** Height of the scrolling area; `null` lets the table take the height it needs. */
  height: number | null;
}

const ROW_HEIGHT = 28;
const OVERSCAN = 10;
/** Below this many rows, everything is rendered and nothing is virtualized. */
const VIRTUALIZE_FROM = 120;

function compare(a: unknown, b: unknown): number {
  const missingA = a === null || a === undefined;
  const missingB = b === null || b === undefined;
  if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  const [left, right] = [typeof a === 'object' ? JSON.stringify(a) : String(a), typeof b === 'object' ? JSON.stringify(b) : String(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

function cell(value: unknown): { text: string; className: string; title?: string } {
  if (value === undefined) return { text: '', className: '' };
  if (value === null) return { text: 'null', className: 'is-muted' };
  if (typeof value === 'number') return { text: formatNumber(value), className: 'is-number' };
  if (typeof value === 'boolean') return { text: String(value), className: '' };
  if (typeof value === 'string') return { text: value, className: '', title: value.length > 40 ? value : undefined };
  const json = JSON.stringify(value);
  return { text: formatValue(value, 120), className: 'is-muted', title: json.length > 600 ? json.slice(0, 600) + '…' : json };
}

export function DataTable({ table, height }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(height ?? 400);
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);

  // Sorting refers to a column position, which a new table shape invalidates.
  const shape = table.columns.map((column) => column.id).join('\u0001');
  useEffect(() => setSort(null), [shape]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const order = useMemo(() => {
    const indexes = table.rows.map((_, i) => i);
    if (sort) {
      const direction = sort.descending ? -1 : 1;
      indexes.sort((a, b) => direction * compare(table.rows[a]![sort.column], table.rows[b]![sort.column]) || a - b);
    }
    return indexes;
  }, [table.rows, sort]);

  const widths = useMemo(
    () =>
      table.columns.map((column, c) => {
        let longest = column.label.length + 3;
        for (let r = 0; r < Math.min(40, table.rows.length); r++) longest = Math.max(longest, cell(table.rows[r]![c]).text.length);
        return Math.round(Math.min(320, Math.max(64, longest * 7.1 + 26)));
      }),
    [table],
  );

  const virtual = order.length > VIRTUALIZE_FROM;
  const first = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtual ? Math.min(order.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN) : order.length;

  const grouped = table.columns.some((column) => column.group !== undefined);
  const groupCells: ReactNode[] = [];
  if (grouped) {
    for (let c = 0; c < table.columns.length; ) {
      const group = table.columns[c]!.group;
      let span = 1;
      while (group !== undefined && c + span < table.columns.length && table.columns[c + span]!.group === group) span++;
      groupCells.push(
        <th key={c} colSpan={span} scope="colgroup" className={group === undefined ? 'is-blank' : 'is-group'}>
          {group}
        </th>,
      );
      c += span;
    }
  }

  const toggleSort = (column: number) => setSort((current) => (current?.column !== column ? { column, descending: false } : current.descending ? null : { column, descending: true }));

  const body: ReactNode[] = [];
  for (let position = first; position < last; position++) {
    const rowIndex = order[position]!;
    const row = table.rows[rowIndex]!;
    body.push(
      <tr key={rowIndex}>
        {row.map((value, c) => {
          const { text, className, title } = cell(value);
          return (
            <td key={c} className={className} title={title}>
              {c === 0 && table.rowDots && <span className="table-dot" style={{ background: table.rowDots[rowIndex] }} aria-hidden="true" />}
              {text}
            </td>
          );
        })}
      </tr>,
    );
  }

  return (
    <div className="table-scroll" ref={scroller} style={height === null ? undefined : { maxHeight: height }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <table className="table" style={{ width: widths.reduce((total, width) => total + width, 0) }}>
        <colgroup>
          {widths.map((width, c) => (
            <col key={c} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          {grouped && <tr>{groupCells}</tr>}
          <tr>
            {table.columns.map((column, c) => (
              <th key={column.id} scope="col" aria-sort={sort?.column === c ? (sort.descending ? 'descending' : 'ascending') : undefined}>
                <button type="button" className="table-sort" onClick={() => toggleSort(c)} title={column.label}>
                  {column.dot && <span className="table-dot" style={{ background: column.dot }} aria-hidden="true" />}
                  <span className="table-sort-label">{column.label}</span>
                  <span className="table-sort-arrow" aria-hidden="true">
                    {sort?.column === c ? (sort.descending ? '↓' : '↑') : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr aria-hidden="true" className="table-spacer">
              <td colSpan={table.columns.length} style={{ height: first * ROW_HEIGHT }} />
            </tr>
          )}
          {body}
          {last < order.length && (
            <tr aria-hidden="true" className="table-spacer">
              <td colSpan={table.columns.length} style={{ height: (order.length - last) * ROW_HEIGHT }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
