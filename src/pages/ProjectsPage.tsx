/** The list of projects. */
import { useEffect, useState } from 'react';
import { createProject, deleteProject, renameProject, useAppState } from '../data/store';
import type { Project } from '../data/types';
import { formatAgo, formatBytes, plural } from '../lib/format';
import { hrefFor, navigate } from '../lib/router';
import { EmptyState } from '../ui/controls';
import { confirm, toastError } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { NameDialog } from './NameDialog';
import { Shell } from './Shell';

function useStorageUsage(dependency: unknown): number | null {
  const [usage, setUsage] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void navigator.storage
      ?.estimate?.()
      .then((estimate) => {
        if (current) setUsage(estimate.usage ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [dependency]);
  return usage;
}

export function ProjectsPage() {
  const state = useAppState();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const usage = useStorageUsage(state.files);
  const projects = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);

  const create = async (name: string) => {
    setCreating(false);
    try {
      navigate({ page: 'project', projectId: (await createProject(name)).id });
    } catch (error) {
      toastError(error, 'Could not create the project');
    }
  };

  const remove = async (project: Project) => {
    const files = state.files.filter((file) => file.projectId === project.id).length;
    const visualizations = state.visualizations.filter((viz) => viz.projectId === project.id).length;
    const confirmed = await confirm({
      title: `Delete “${project.name}”?`,
      message: `This permanently deletes the project with its ${plural(files, 'file')} and ${plural(visualizations, 'visualization')}. Templates made from its visualizations are kept.`,
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (confirmed) await deleteProject(project.id).catch((error) => toastError(error, 'Could not delete the project'));
  };

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="page-sub">A project holds JSON and JSON Lines files and the charts and tables you build on them. Everything stays in this browser.</p>
        </div>
        {projects.length > 0 && (
          <button type="button" className="button is-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New project
          </button>
        )}
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No projects yet"
          action={
            <button type="button" className="button is-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New project
            </button>
          }
        >
          Create a project, drop in a few .json or .jsonl files, and build queries with blocks to chart and compare them.
        </EmptyState>
      ) : (
        <ul className="project-grid">
          {projects.map((project) => {
            const files = state.files.filter((file) => file.projectId === project.id);
            const visualizations = state.visualizations.filter((viz) => viz.projectId === project.id);
            return (
              <li key={project.id} className="project-card">
                <a className="project-link" href={hrefFor({ page: 'project', projectId: project.id })}>
                  <h2>{project.name}</h2>
                  <p>
                    {plural(files.length, 'file')} · {plural(visualizations.length, 'visualization')}
                  </p>
                  <p className="project-meta">
                    {formatBytes(files.reduce((total, file) => total + file.size, 0))} · updated {formatAgo(project.updatedAt)}
                  </p>
                </a>
                <Menu
                  label={`Actions for ${project.name}`}
                  items={[
                    { label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(project) },
                    { label: 'Delete', icon: 'trash', danger: true, separated: true, onSelect: () => void remove(project) },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}

      {usage !== null && usage > 0 && <p className="page-foot">Using about {formatBytes(usage)} of this browser’s storage.</p>}

      {creating && <NameDialog title="New project" label="Name" submitLabel="Create project" onSubmit={(name) => void create(name)} onClose={() => setCreating(false)} />}
      {renaming && (
        <NameDialog
          title="Rename project"
          label="Name"
          initial={renaming.name}
          submitLabel="Rename"
          onSubmit={(name) => {
            void renameProject(renaming.id, name).catch((error) => toastError(error));
            setRenaming(null);
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </Shell>
  );
}
