/** A visualization on the project page: live, with its actions. */
import { useState } from 'react';
import { deleteVisualization, duplicateVisualization, setTemplate } from '../../data/store';
import type { DataFile, Visualization } from '../../data/types';
import { downloadText, fileNameFor } from '../../lib/download';
import { hrefFor, navigate } from '../../lib/router';
import { FileDot } from '../../ui/controls';
import { confirm, toast, toastError } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { VizView, fileRows } from '../../viz/VizView';
import { buildTable, toCsv } from '../../viz/tableModel';
import { useResults } from '../../viz/useResults';

const BODY_HEIGHT = 260;

export function VizCard({ viz, files }: { viz: Visualization; files: DataFile[] }) {
  // Every chart has a table twin: the same rows, readable without hovering.
  const [asTable, setAsTable] = useState(false);
  const used = viz.fileIds.map((id) => files.find((file) => file.id === id)).filter((file): file is DataFile => file !== undefined);
  const results = useResults(used, viz.query);
  const editHref = hrefFor({ page: 'editor', projectId: viz.projectId, vizId: viz.id });
  // Opens on what the card is showing: the chart, or its rows if the card was switched to them.
  const viewHref = hrefFor({ page: 'view', projectId: viz.projectId, vizId: viz.id, table: asTable && viz.kind === 'chart' });
  const isTemplate = viz.templateId !== null;

  const remove = async () => {
    const confirmed = await confirm({
      title: `Delete “${viz.name}”?`,
      message: isTemplate ? 'The visualization is deleted. Its template stays available for other files.' : 'The visualization is deleted. The files it reads are not affected.',
      confirmLabel: 'Delete visualization',
      danger: true,
    });
    if (confirmed) await deleteVisualization(viz.id).catch((error) => toastError(error));
  };

  const exportCsv = () => downloadText(fileNameFor(viz.name, 'csv'), toCsv(buildTable(fileRows(used, results), viz.table)), 'text/csv');

  return (
    <article className="viz-card">
      <header className="viz-card-head">
        <a className="viz-card-title" href={editHref} title="Edit">
          {viz.name}
        </a>
        {isTemplate && (
          <span className="badge" title="This query is saved as a template">
            <Icon name="star" size={12} />
            Template
          </span>
        )}
        <span className="viz-card-files">
          {used.map((file) => (
            <span key={file.id} title={file.name}>
              <FileDot color={file.color} />
            </span>
          ))}
        </span>
        {viz.kind === 'chart' && (
          <button type="button" className={asTable ? 'icon-button is-on' : 'icon-button'} onClick={() => setAsTable((value) => !value)} aria-pressed={asTable} title={asTable ? 'Show the chart' : 'Show the data as a table'} aria-label="Show the data as a table">
            <Icon name="table" />
          </button>
        )}
        <a className="icon-button" href={viewHref} title="View full screen" aria-label={`View ${viz.name} full screen`}>
          <Icon name="expand" />
        </a>
        <Menu
          label={`Actions for ${viz.name}`}
          items={[
            { label: 'View full screen', icon: 'expand', onSelect: () => navigate({ page: 'view', projectId: viz.projectId, vizId: viz.id, table: asTable && viz.kind === 'chart' }) },
            { label: 'Edit', icon: 'pencil', onSelect: () => navigate({ page: 'editor', projectId: viz.projectId, vizId: viz.id }) },
            { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicateVisualization(viz.id).catch((error) => toastError(error)) },
            {
              label: isTemplate ? 'Remove from templates' : 'Mark as template',
              icon: 'star',
              onSelect: () =>
                void setTemplate(viz.id, !isTemplate).then(
                  () => toast(isTemplate ? `“${viz.name}” is no longer a template.` : `“${viz.name}” is now a template: reuse it from “New visualization”.`),
                  (error) => toastError(error),
                ),
            },
            { label: 'Download CSV', icon: 'download', disabled: results.first, onSelect: exportCsv },
            { label: 'Delete', icon: 'trash', danger: true, separated: true, onSelect: () => void remove() },
          ]}
        />
      </header>
      <div className="viz-card-body">
        <VizView kind={asTable ? 'table' : viz.kind} chart={viz.chart} table={viz.table} files={used} results={results} height={BODY_HEIGHT} />
      </div>
    </article>
  );
}
