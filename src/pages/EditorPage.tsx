/** The visualization editor: blocks on the left; files, display options and a live preview on the right. */
import { type PointerEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorChange } from '../blocks/BlocklyEditor';
import type { Issue } from '../blocks/context';
import { mergeAll } from '../data/schema';
import { setTemplate, updateVisualization, useAppState } from '../data/store';
import type { ChartConfig, ChartType, DataFile, TableConfig, Visualization } from '../data/types';
import { downloadText, fileNameFor } from '../lib/download';
import { formatNumber, plural } from '../lib/format';
import { hrefFor } from '../lib/router';
import { useTheme } from '../lib/theme';
import { EditableText, EmptyState, FileDot, Segmented } from '../ui/controls';
import { toast, toastError } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { VizView, fileRows } from '../viz/VizView';
import { resolveColumns } from '../viz/chartModel';
import { type ColumnInfo, describeColumns } from '../viz/columns';
import { buildTable, toCsv } from '../viz/tableModel';
import { type Results, useResults } from '../viz/useResults';
import { Shell } from './Shell';

const BlocklyEditor = lazy(() => import('../blocks/BlocklyEditor'));

const SIDE_KEY = 'jx-editor-side';
const SIDE_MIN = 340;
const SIDE_DEFAULT = 460;

const CHART_TYPES: Array<{ value: ChartType; label: string; icon: 'line' | 'area' | 'bar' | 'scatter' }> = [
  { value: 'line', label: 'Line', icon: 'line' },
  { value: 'area', label: 'Area', icon: 'area' },
  { value: 'bar', label: 'Bar', icon: 'bar' },
  { value: 'scatter', label: 'Points', icon: 'scatter' },
];

function storedSide(): number {
  try {
    const stored = Number(localStorage.getItem(SIDE_KEY));
    return stored >= SIDE_MIN ? stored : SIDE_DEFAULT;
  } catch {
    return SIDE_DEFAULT;
  }
}

function ChartOptions({ config, columns, onChange }: { config: ChartConfig; columns: ColumnInfo[]; onChange(patch: Partial<ChartConfig>): void }) {
  const resolved = resolveColumns(columns, config);
  const yCandidates = columns.filter((column) => column !== resolved.x && column !== resolved.splitBy && column.type !== 'other' && column.type !== 'empty');
  const chosenY = new Set(resolved.y.map((column) => column.name));

  const toggleY = (name: string, on: boolean) => {
    // The order of the Y columns is the order of the result's columns, whatever was clicked first.
    const next = yCandidates.map((column) => column.name).filter((candidate) => (candidate === name ? on : chosenY.has(candidate)));
    onChange({ y: next.length > 0 ? next : null });
  };

  return (
    <>
      <div className="option">
        <span className="option-label">Chart</span>
        <Segmented label="Chart type" value={config.type} options={CHART_TYPES} onChange={(type) => onChange({ type })} compact />
      </div>
      <label className="option">
        <span className="option-label">X axis</span>
        <select className="input" value={config.x ?? ''} onChange={(event) => onChange({ x: event.target.value || null })}>
          <option value="">{resolved.x ? `Automatic (${resolved.x.name})` : 'Automatic'}</option>
          {columns.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      <div className="option">
        <span className="option-label">Y axis</span>
        <details className="multi">
          <summary className="input">
            <span>{resolved.y.length === 0 ? 'No numeric column' : `${config.y ? '' : 'Automatic: '}${resolved.y.map((column) => column.name).join(', ')}`}</span>
            <Icon name="chevronDown" size={14} />
          </summary>
          <div className="multi-list">
            {yCandidates.length === 0 && <span className="field-hint">The result has no other columns.</span>}
            {yCandidates.map((column) => (
              <label key={column.name} className="check">
                <input type="checkbox" checked={chosenY.has(column.name)} onChange={(event) => toggleY(column.name, event.target.checked)} />
                <span className="check-label">{column.name}</span>
                <span className="check-meta">{column.type}</span>
              </label>
            ))}
            {config.y && (
              <button type="button" className="button is-small is-quiet" onClick={() => onChange({ y: null })}>
                Back to automatic
              </button>
            )}
          </div>
        </details>
      </div>
      <label className="option">
        <span className="option-label">Split by</span>
        <select className="input" value={config.splitBy ?? ''} onChange={(event) => onChange({ splitBy: event.target.value || null })}>
          <option value="">Nothing: one series per Y column</option>
          {columns
            .filter((column) => column !== resolved.x && column.type !== 'other' && column.type !== 'empty')
            .map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
        </select>
      </label>
      <label className="option">
        <span className="option-label">Layout</span>
        <select className="input" value={config.layout} onChange={(event) => onChange({ layout: event.target.value as ChartConfig['layout'] })}>
          <option value="auto">Automatic</option>
          <option value="overlay">Everything in one plot</option>
          <option value="panels">One plot per measure</option>
        </select>
      </label>
      <label className="option">
        <span className="option-label">X values are</span>
        <select className="input" value={config.xScale} onChange={(event) => onChange({ xScale: event.target.value as ChartConfig['xScale'] })} disabled={config.type === 'bar'}>
          <option value="auto">Automatic</option>
          <option value="number">Numbers</option>
          <option value="time">Dates or timestamps</option>
          <option value="category">Categories</option>
        </select>
      </label>
      <label className="check option-check">
        <input type="checkbox" checked={config.zeroBased || config.type === 'bar' || config.type === 'area'} disabled={config.type === 'bar' || config.type === 'area'} onChange={(event) => onChange({ zeroBased: event.target.checked })} />
        <span className="check-label">Start the Y axis at zero</span>
      </label>
    </>
  );
}

function TableOptions({ config, columns, multiFile, onChange }: { config: TableConfig; columns: ColumnInfo[]; multiFile: boolean; onChange(patch: Partial<TableConfig>): void }) {
  if (!multiFile) return <p className="field-hint">Select several files to compare them side by side.</p>;
  return (
    <>
      <div className="option">
        <span className="option-label">Files</span>
        <Segmented
          label="How files are laid out"
          value={config.layout}
          onChange={(layout) => onChange({ layout })}
          options={[
            { value: 'stacked', label: 'One under the other' },
            { value: 'compare', label: 'Side by side' },
          ]}
        />
      </div>
      {config.layout === 'compare' && (
        <label className="option">
          <span className="option-label">Match rows on</span>
          <select className="input" value={config.key ?? ''} onChange={(event) => onChange({ key: event.target.value || null })}>
            <option value="">{columns[0] ? `Automatic (${columns[0].name})` : 'Automatic'}</option>
            {columns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function summary(results: Results, files: DataFile[]): string {
  const done = results.results.filter((result) => result.error === null && files.some((file) => file.id === result.fileId));
  if (results.first || done.length === 0) return '';
  const rows = done.reduce((total, result) => total + result.total, 0);
  const ms = Math.max(...done.map((result) => result.ms));
  return `${plural(rows, 'row')}${done.length > 1 ? ` from ${done.length} files` : ''} · ${ms < 10 ? formatNumber(Math.round(ms * 10) / 10) : Math.round(ms)} ms`;
}

function Editor({ viz, projectFiles }: { viz: Visualization; projectFiles: DataFile[] }) {
  const dark = useTheme() === 'dark';
  const [issues, setIssues] = useState<Issue[]>([]);
  const [asTable, setAsTable] = useState(false);
  const [side, setSide] = useState(storedSide);
  const dragOrigin = useRef<{ x: number; side: number } | null>(null);

  const files = useMemo(() => viz.fileIds.map((id) => projectFiles.find((file) => file.id === id)).filter((file): file is DataFile => file !== undefined), [viz.fileIds, projectFiles]);
  // Schemas only change with a file's contents, so they are recomputed by revision, not
  // whenever a file is renamed or recolored.
  const schemaKey = files.map((file) => `${file.id}:${file.rev}`).join(',');
  const schema = useMemo(() => mergeAll(files.map((file) => file.schema)), [schemaKey]);
  const fileSchemas = useMemo(() => files.map((file) => ({ name: file.name, schema: file.schema })), [schemaKey]);

  const results = useResults(files, viz.query);
  const data = useMemo(() => fileRows(files, results), [files, results]);
  const columns = useMemo(() => describeColumns(data.map((file) => file.rows)), [data]);

  const current = useRef(viz);
  current.current = viz;
  const onBlocksChange = useCallback((change: EditorChange) => {
    setIssues(change.issues);
    const saved = current.current;
    // Opening the editor reports once without anything having changed.
    if (change.query === saved.query && change.fields.join('\n') === saved.fields.join('\n') && JSON.stringify(change.workspace) === JSON.stringify(saved.workspace)) return;
    void updateVisualization(saved.id, { workspace: change.workspace, query: change.query, fields: change.fields }).catch((error) => toastError(error, 'Could not save'));
  }, []);

  const save = (patch: Parameters<typeof updateVisualization>[1]) => void updateVisualization(viz.id, patch).catch((error) => toastError(error, 'Could not save'));

  const toggleFile = (fileId: string, on: boolean) => {
    // Kept in the project's file order, so colors and legends do not depend on click order.
    save({ fileIds: projectFiles.map((file) => file.id).filter((id) => (id === fileId ? on : viz.fileIds.includes(id))) });
  };

  const copyQuery = () =>
    void navigator.clipboard.writeText(viz.query).then(
      () => toast('Query copied.'),
      () => toast('Could not reach the clipboard. Select the query text and copy it by hand.', 'error'),
    );

  const onDividerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragOrigin.current = { x: event.clientX, side };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDividerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current) return;
    const next = Math.round(Math.min(window.innerWidth - 380, Math.max(SIDE_MIN, dragOrigin.current.side + dragOrigin.current.x - event.clientX)));
    setSide(next);
  };
  const onDividerUp = () => {
    if (!dragOrigin.current) return;
    dragOrigin.current = null;
    try {
      localStorage.setItem(SIDE_KEY, String(side));
    } catch {
      // The width simply is not remembered.
    }
  };

  const showTable = viz.kind === 'table' || asTable;

  // Fields the query reads that some, or all, of the files lack.
  const gaps = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (issue.kind !== 'missing-field' || !issue.field) continue;
    for (const who of issue.files ?? [files.length > 1 ? 'All selected files' : (files[0]?.name ?? 'The file')]) {
      if (!gaps.has(who)) gaps.set(who, new Set());
      gaps.get(who)!.add(issue.field);
    }
  }

  return (
    <div className="editor" style={{ gridTemplateColumns: `minmax(0, 1fr) 7px ${side}px` }}>
      <div className="editor-blocks">
        <Suspense fallback={<div className="viz-message is-quiet">Loading the block editor…</div>}>
          <BlocklyEditor key={viz.id} initialWorkspace={viz.workspace} schema={schema} files={fileSchemas} dark={dark} onChange={onBlocksChange} />
        </Suspense>
      </div>
      <div className="editor-divider" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" onPointerDown={onDividerDown} onPointerMove={onDividerMove} onPointerUp={onDividerUp} onPointerCancel={onDividerUp} />
      <aside className="editor-side">
        <section className="panel">
          <h2>Files</h2>
          {projectFiles.length === 0 ? (
            <p className="field-hint">This project has no files. Add some on the project page.</p>
          ) : (
            <ul className="check-list">
              {projectFiles.map((file) => (
                <li key={file.id}>
                  <label className="check">
                    <input type="checkbox" checked={viz.fileIds.includes(file.id)} onChange={(event) => toggleFile(file.id, event.target.checked)} />
                    <FileDot color={file.color} />
                    <span className="check-label">{file.name}</span>
                    <span className="check-meta">{plural(file.records, 'record')}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Show as</h2>
            <Segmented
              label="Kind of visualization"
              value={viz.kind}
              onChange={(kind) => save({ kind })}
              options={[
                { value: 'chart', label: 'Chart', icon: 'line' },
                { value: 'table', label: 'Table', icon: 'table' },
              ]}
            />
          </div>
          <div className="options">
            {viz.kind === 'chart' ? (
              <ChartOptions config={viz.chart} columns={columns} onChange={(patch) => save({ chart: { ...viz.chart, ...patch } })} />
            ) : (
              <TableOptions config={viz.table} columns={columns} multiFile={files.length > 1} onChange={(patch) => save({ table: { ...viz.table, ...patch } })} />
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Preview</h2>
            <span className="panel-meta">{summary(results, files)}</span>
            {viz.kind === 'chart' && (
              <button type="button" className={asTable ? 'icon-button is-on' : 'icon-button'} onClick={() => setAsTable((value) => !value)} aria-pressed={asTable} title={asTable ? 'Show the chart' : 'Show the data as a table'} aria-label="Show the data as a table">
                <Icon name="table" />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              disabled={results.first || data.length === 0}
              onClick={() => downloadText(fileNameFor(viz.name, 'csv'), toCsv(buildTable(data, viz.table)), 'text/csv')}
              title="Download the result as CSV"
              aria-label="Download the result as CSV"
            >
              <Icon name="download" />
            </button>
          </div>
          <VizView kind={showTable ? 'table' : 'chart'} chart={viz.chart} table={viz.table} files={files} results={results} height={showTable ? 320 : 250} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Query</h2>
            <span className="panel-meta">JSONata</span>
            <button type="button" className="icon-button" onClick={copyQuery} title="Copy the query" aria-label="Copy the query">
              <Icon name="copy" />
            </button>
          </div>
          {gaps.size > 0 && (
            <div className="notice is-warn" role="status">
              <strong>Some blocks read fields that are missing. Their rows will have gaps.</strong>
              <ul>
                {[...gaps].map(([who, fields]) => (
                  <li key={who}>
                    {who}: {[...fields].join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <pre className="code" tabIndex={0}>
            <code>{viz.query}</code>
          </pre>
        </section>
      </aside>
    </div>
  );
}

export function EditorPage({ projectId, vizId }: { projectId: string; vizId: string }) {
  const state = useAppState();
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const viz = state.visualizations.find((candidate) => candidate.id === vizId && candidate.projectId === projectId);
  const projectFiles = useMemo(() => state.files.filter((file) => file.projectId === projectId), [state.files, projectId]);

  // A stale tab title is a small thing that makes several open editors hard to tell apart.
  useEffect(() => {
    if (!viz) return;
    document.title = `${viz.name} · JSON Explorer`;
    return () => {
      document.title = 'JSON Explorer';
    };
  }, [viz?.name, viz]);

  if (!project || !viz) {
    return (
      <Shell crumbs={[{ label: 'Not found' }]}>
        <EmptyState
          icon="line"
          title="This visualization does not exist"
          action={
            <a className="button" href={project ? hrefFor({ page: 'project', projectId }) : hrefFor({ page: 'projects' })}>
              {project ? `Back to ${project.name}` : 'All projects'}
            </a>
          }
        >
          It may have been deleted.
        </EmptyState>
      </Shell>
    );
  }

  const isTemplate = viz.templateId !== null;
  return (
    <Shell
      fill
      crumbs={[
        { label: project.name, href: hrefFor({ page: 'project', projectId }) },
        { label: <EditableText value={viz.name} label="Visualization name" onChange={(name) => void updateVisualization(viz.id, { name }).catch((error) => toastError(error))} /> },
      ]}
      actions={
        <>
          <button
            type="button"
            className={isTemplate ? 'button is-on' : 'button'}
            aria-pressed={isTemplate}
            onClick={() =>
              void setTemplate(viz.id, !isTemplate).then(
                () => toast(isTemplate ? 'Removed from templates.' : 'Marked as a template. It follows your edits, and can be reused on other files from “New visualization”.'),
                (error) => toastError(error),
              )
            }
            title={isTemplate ? 'This query is a template. Click to remove it from templates.' : 'Save this query as a template, to reuse it on other files'}
          >
            <Icon name="star" />
            {isTemplate ? 'Template' : 'Mark as template'}
          </button>
          <a className="button is-primary" href={hrefFor({ page: 'project', projectId })}>
            <Icon name="check" />
            Done
          </a>
        </>
      }
    >
      <Editor key={viz.id} viz={viz} projectFiles={projectFiles} />
    </Shell>
  );
}
