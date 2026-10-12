/** A visualization, drawn: its query run on its files and shown as a chart or a table. */
import { useMemo } from 'react';
import type { ChartConfig, DataFile, TableConfig, VizKind } from '../data/types';
import { baseName, formatCount } from '../lib/format';
import { Chart } from './Chart';
import { DataTable } from './DataTable';
import { type FileRows, buildChart } from './chartModel';
import { buildTable } from './tableModel';
import type { Results } from './useResults';

interface Props {
  kind: VizKind;
  chart: ChartConfig;
  table: TableConfig;
  files: readonly DataFile[];
  results: Results;
  /** Height for the chart's plots or the table's scrolling area, or 'fill' to take all the container has. */
  height: number | 'fill';
}

/** Pairs each file with its rows, under the name and color it currently has. */
export function fileRows(files: readonly DataFile[], results: Results): FileRows[] {
  const out: FileRows[] = [];
  for (const file of files) {
    const result = results.results.find((r) => r.fileId === file.id);
    if (result && !result.error) out.push({ id: file.id, label: baseName(file.name), color: file.color, rows: result.rows });
  }
  return out;
}

export function VizView({ kind, chart, table, files, results, height }: Props) {
  const data = useMemo(() => fileRows(files, results), [files, results]);
  const chartModel = useMemo(() => (kind === 'chart' ? buildChart(data, chart) : null), [kind, data, chart]);
  const tableModel = useMemo(() => (kind === 'table' ? buildTable(data, table) : null), [kind, data, table]);

  if (files.length === 0) return <div className="viz-message">No file selected. Choose the files this visualization reads.</div>;
  if (results.first) return <div className="viz-message is-quiet">Running…</div>;

  const failures = results.results.filter((result) => result.error !== null && files.some((file) => file.id === result.fileId));
  const capped = results.results.filter((result) => result.total > result.rows.length);

  return (
    // While a newer query runs, the previous picture stays, dimmed: no flash, no jump.
    <div className={`viz${results.pending ? ' is-pending' : ''}${height === 'fill' ? ' is-fill' : ''}`}>
      {failures.map((failure) => (
        <div key={failure.fileId} className="viz-error" role="alert">
          <strong>{files.find((file) => file.id === failure.fileId)?.name}</strong>
          <span>{failure.error}</span>
        </div>
      ))}
      {capped.length > 0 && (
        <p className="chart-note">
          Showing the first {formatCount(capped[0]!.rows.length)} of {formatCount(capped[0]!.total)} rows{capped.length > 1 ? ' per file' : ''}.
        </p>
      )}
      {data.length > 0 && chartModel && (chartModel.empty ? <div className="viz-message">{chartModel.empty}</div> : <Chart model={chartModel} height={height} zeroBased={chart.zeroBased} />)}
      {data.length > 0 &&
        tableModel &&
        (tableModel.rows.length === 0 ? (
          <div className="viz-message">The query returned no rows.</div>
        ) : (
          <>
            <DataTable table={tableModel} height={height} />
            {tableModel.notes.map((note) => (
              <p key={note} className="chart-note">
                {note}
              </p>
            ))}
          </>
        ))}
    </div>
  );
}
