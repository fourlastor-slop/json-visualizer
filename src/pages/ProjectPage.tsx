/** A project: its files on the left, its visualizations on the right. */
import { useState } from 'react';
import { renameProject, useAppState } from '../data/store';
import type { DataFile } from '../data/types';
import { hrefFor } from '../lib/router';
import { EditableText, EmptyState } from '../ui/controls';
import { toastError } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { FileInspector } from './project/FileInspector';
import { FilesPanel } from './project/FilesPanel';
import { NewVizDialog } from './project/NewVizDialog';
import { VizCard } from './project/VizCard';
import { Shell } from './Shell';

export function ProjectPage({ projectId }: { projectId: string }) {
  const state = useAppState();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return (
      <Shell crumbs={[{ label: 'Not found' }]}>
        <EmptyState
          icon="folder"
          title="This project does not exist"
          action={
            <a className="button" href={hrefFor({ page: 'projects' })}>
              All projects
            </a>
          }
        >
          It may have been deleted, or the link belongs to another browser: projects are stored in the browser they were made in.
        </EmptyState>
      </Shell>
    );
  }

  const files = state.files.filter((file) => file.projectId === projectId);
  const visualizations = state.visualizations.filter((viz) => viz.projectId === projectId);
  const inspected: DataFile | undefined = files.find((file) => file.id === inspecting);

  const newButton = (
    <button type="button" className="button is-primary" onClick={() => setCreating(true)} disabled={files.length === 0} title={files.length === 0 ? 'Upload a file first' : undefined}>
      <Icon name="plus" />
      New visualization
    </button>
  );

  return (
    <Shell crumbs={[{ label: <EditableText value={project.name} label="Project name" onChange={(name) => void renameProject(project.id, name).catch((error) => toastError(error))} /> }]}>
      <div className="project-layout">
        <FilesPanel project={project} files={files} visualizations={visualizations} onInspect={(file) => setInspecting(file.id)} />

        <section className="visualizations" aria-label="Visualizations">
          <div className="section-head">
            <h2>Visualizations</h2>
            {visualizations.length > 0 && <div className="section-actions">{newButton}</div>}
          </div>
          {visualizations.length === 0 ? (
            <EmptyState icon="line" title={files.length === 0 ? 'Start by adding a file' : 'No visualizations yet'} action={newButton}>
              {files.length === 0
                ? 'Upload a .json or .jsonl file on the left. Then build a query with blocks and show the result as a chart or a table.'
                : 'Build a query with blocks and show the result as a chart or a table. Select several files to compare them in one picture.'}
            </EmptyState>
          ) : (
            <div className="viz-grid">
              {visualizations.map((viz) => (
                <VizCard key={viz.id} viz={viz} files={files} />
              ))}
            </div>
          )}
        </section>
      </div>

      {inspected && <FileInspector file={inspected} onClose={() => setInspecting(null)} />}
      {creating && <NewVizDialog projects={[project]} files={state.files} templates={state.templates} projectId={project.id} onClose={() => setCreating(false)} />}
    </Shell>
  );
}
