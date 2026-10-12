/** Queries saved for reuse, across all projects. */
import { useState } from 'react';
import { deleteTemplate, renameTemplate, useAppState } from '../data/store';
import type { Template } from '../data/types';
import { formatAgo } from '../lib/format';
import { hrefFor } from '../lib/router';
import { EmptyState } from '../ui/controls';
import { confirm, toastError } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { NameDialog } from './NameDialog';
import { NewVizDialog } from './project/NewVizDialog';
import { Shell } from './Shell';

export function TemplatesPage() {
  const state = useAppState();
  const [using, setUsing] = useState<Template | null>(null);
  const [renaming, setRenaming] = useState<Template | null>(null);
  const templates = [...state.templates].sort((a, b) => b.updatedAt - a.updatedAt);
  // Only projects with files can host a new visualization.
  const projects = state.projects.filter((project) => state.files.some((file) => file.projectId === project.id));

  const remove = async (template: Template) => {
    const source = state.visualizations.find((viz) => viz.templateId === template.id);
    const confirmed = await confirm({
      title: `Delete the template “${template.name}”?`,
      message: source ? 'The visualization it was made from is kept, as are the visualizations already created from it.' : 'Visualizations already created from it are kept.',
      confirmLabel: 'Delete template',
      danger: true,
    });
    if (confirmed) await deleteTemplate(template.id).catch((error) => toastError(error));
  };

  return (
    <Shell crumbs={[{ label: 'Templates' }]}>
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <p className="page-sub">
            A template is a query, with its chart or table settings, that you can run on other files. Mark any visualization as a template from its editor or its card. A template fits a file when the file has the fields
            the query reads.
          </p>
        </div>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon="layers"
          title="No templates yet"
          action={
            <a className="button" href={hrefFor({ page: 'projects' })}>
              Go to projects
            </a>
          }
        >
          Open a visualization and choose “Mark as template” to keep its query for other files and projects.
        </EmptyState>
      ) : (
        <ul className="template-cards">
          {templates.map((template) => {
            const source = state.visualizations.find((viz) => viz.templateId === template.id);
            const sourceProject = source && state.projects.find((project) => project.id === source.projectId);
            return (
              <li key={template.id} className="template-card">
                <div className="template-card-head">
                  <Icon name={template.kind === 'chart' ? template.chart.type : 'table'} size={18} />
                  <h2>{template.name}</h2>
                  <button type="button" className="button is-small" onClick={() => setUsing(template)} disabled={projects.length === 0} title={projects.length === 0 ? 'Create a project and upload a file first' : undefined}>
                    Use…
                  </button>
                  <Menu
                    label={`Actions for ${template.name}`}
                    items={[
                      { label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(template) },
                      { label: 'Delete', icon: 'trash', danger: true, separated: true, onSelect: () => void remove(template) },
                    ]}
                  />
                </div>
                <p className="template-fields">
                  {template.fields.length === 0 ? (
                    'Reads no particular field: fits any file.'
                  ) : (
                    <>
                      Reads{' '}
                      {template.fields.map((field) => (
                        <code key={field}>{field}</code>
                      ))}
                    </>
                  )}
                </p>
                <p className="project-meta">
                  {source && sourceProject ? (
                    <>
                      Follows <a href={hrefFor({ page: 'editor', projectId: source.projectId, vizId: source.id })}>{source.name}</a> in {sourceProject.name}
                    </>
                  ) : (
                    'Standalone'
                  )}{' '}
                  · updated {formatAgo(template.updatedAt)}
                </p>
                <pre className="code is-compact">
                  <code>{template.query}</code>
                </pre>
              </li>
            );
          })}
        </ul>
      )}

      {using && projects[0] && <NewVizDialog projects={projects} files={state.files} templates={state.templates} projectId={projects[0].id} templateId={using.id} onClose={() => setUsing(null)} />}
      {renaming && (
        <NameDialog
          title="Rename template"
          label="Name"
          initial={renaming.name}
          submitLabel="Rename"
          onSubmit={(name) => {
            void renameTemplate(renaming.id, name).catch((error) => toastError(error));
            setRenaming(null);
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </Shell>
  );
}
