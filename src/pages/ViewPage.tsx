/** A visualization on its own, filling the window: its result, without the editor beside it. */
import { useMemo } from 'react';
import { useAppState } from '../data/store';
import type { DataFile } from '../data/types';
import { downloadText, fileNameFor } from '../lib/download';
import { hrefFor, navigate } from '../lib/router';
import { useDocumentTitle } from '../lib/title';
import { Segmented } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { VizView, fileRows } from '../viz/VizView';
import { buildTable, toCsv } from '../viz/tableModel';
import { useResults } from '../viz/useResults';
import { Shell } from './Shell';
import { VizNotFound } from './VizNotFound';

interface Props {
  projectId: string;
  vizId: string;
  /** Show a chart's rows as a table instead of the chart. */
  table: boolean;
}

export function ViewPage({ projectId, vizId, table }: Props) {
  const state = useAppState();
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const viz = state.visualizations.find((candidate) => candidate.id === vizId && candidate.projectId === projectId);
  const files = useMemo(
    () => (viz ? viz.fileIds.map((id) => state.files.find((file) => file.id === id)).filter((file): file is DataFile => file !== undefined) : []),
    [viz, state.files],
  );
  const results = useResults(files, viz?.query ?? '$');
  useDocumentTitle(viz?.name);

  if (!project || !viz) return <VizNotFound project={project} />;

  // A table is already its own data. A chart can be swapped for the rows it draws.
  const showTable = viz.kind === 'table' || table;

  return (
    <Shell
      fill
      crumbs={[{ label: project.name, href: hrefFor({ page: 'project', projectId }) }, { label: viz.name }]}
      actions={
        <>
          {viz.kind === 'chart' && (
            <Segmented
              label="Show as"
              value={table ? 'table' : 'chart'}
              // Swaps the history entry: Back leaves the view rather than undoing each switch.
              onChange={(as) => navigate({ page: 'view', projectId, vizId, table: as === 'table' }, { replace: true })}
              options={[
                { value: 'chart', label: 'Chart', icon: 'line' },
                { value: 'table', label: 'Table', icon: 'table' },
              ]}
            />
          )}
          <button
            type="button"
            className="icon-button"
            disabled={results.first || files.length === 0}
            onClick={() => downloadText(fileNameFor(viz.name, 'csv'), toCsv(buildTable(fileRows(files, results), viz.table)), 'text/csv')}
            title="Download the result as CSV"
            aria-label="Download the result as CSV"
          >
            <Icon name="download" />
          </button>
          <a className="button" href={hrefFor({ page: 'editor', projectId, vizId })}>
            <Icon name="pencil" />
            Edit
          </a>
        </>
      }
    >
      <div className="view">
        <VizView kind={showTable ? 'table' : 'chart'} chart={viz.chart} table={viz.table} files={files} results={results} height="fill" />
      </div>
    </Shell>
  );
}
