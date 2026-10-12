/** Creates a visualization: from scratch, or from a template if the files' fields allow it. */
import { useEffect, useMemo, useState } from 'react';
import { starterWorkspace } from '../../blocks/starter';
import { mergeAll } from '../../data/schema';
import { createVisualization } from '../../data/store';
import { DEFAULT_CHART, DEFAULT_TABLE, type DataFile, type Project, type Template, type VizKind } from '../../data/types';
import { plural } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Field, FileDot } from '../../ui/controls';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';

interface Props {
  /** Projects the visualization can be created in. */
  projects: Project[];
  files: DataFile[];
  templates: Template[];
  projectId: string;
  /** Template to start from, when the dialog is opened from the templates page. */
  templateId?: string;
  onClose(): void;
}

type Start = { kind: VizKind } | { templateId: string };

/** Per template: for each selected file that lacks fields, the fields it lacks. */
type Fit = Map<string, Array<{ file: DataFile; missing: string[] }>>;

/** Files selected by default: all of them, unless there are a great many. */
const AUTO_SELECT_LIMIT = 8;

export function NewVizDialog({ projects, files, templates, projectId: initialProjectId, templateId, onClose }: Props) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const projectFiles = useMemo(() => files.filter((file) => file.projectId === projectId), [files, projectId]);
  const [selected, setSelected] = useState<string[]>(() => (projectFiles.length <= AUTO_SELECT_LIMIT ? projectFiles.map((file) => file.id) : projectFiles.slice(0, 1).map((file) => file.id)));
  const [start, setStart] = useState<Start>(templateId ? { templateId } : { kind: 'chart' });
  const [name, setName] = useState<string | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenFiles = useMemo(() => projectFiles.filter((file) => selected.includes(file.id)), [projectFiles, selected]);
  const template = 'templateId' in start ? templates.find((t) => t.id === start.templateId) : undefined;
  const defaultName = template ? template.name : 'kind' in start && start.kind === 'table' ? 'Untitled table' : 'Untitled chart';

  // Does each template's query find its fields in each selected file?
  useEffect(() => {
    if (templates.length === 0) return;
    let current = true;
    setFit(null);
    void import('../../blocks/headless').then(({ compileState }) => {
      if (!current) return;
      const next: Fit = new Map();
      for (const candidate of templates) {
        const gaps: Array<{ file: DataFile; missing: string[] }> = [];
        for (const file of chosenFiles) {
          const missing = compileState(candidate.workspace, file.schema)
            .issues.filter((issue) => issue.kind === 'missing-field')
            .map((issue) => issue.field!);
          if (missing.length > 0) gaps.push({ file, missing: [...new Set(missing)] });
        }
        next.set(candidate.id, gaps);
      }
      setFit(next);
    });
    return () => {
      current = false;
    };
  }, [templates, chosenFiles]);

  const changeProject = (id: string) => {
    setProjectId(id);
    const next = files.filter((file) => file.projectId === id);
    setSelected(next.length <= AUTO_SELECT_LIMIT ? next.map((file) => file.id) : next.slice(0, 1).map((file) => file.id));
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const { compileState } = await import('../../blocks/headless');
      const schema = mergeAll(chosenFiles.map((file) => file.schema));
      const kind = template ? template.kind : (start as { kind: VizKind }).kind;
      const workspace = template ? template.workspace : starterWorkspace(schema, kind);
      const compiled = compileState(workspace, schema);
      const viz = await createVisualization(projectId, chosenFiles.map((file) => file.id), {
        name: (name ?? defaultName).trim() || defaultName,
        kind,
        workspace,
        query: compiled.query,
        fields: compiled.fields,
        chart: template ? template.chart : DEFAULT_CHART,
        table: template ? template.table : DEFAULT_TABLE,
      });
      navigate({ page: 'editor', projectId, vizId: viz.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setCreating(false);
    }
  };

  const gaps = template ? fit?.get(template.id) : undefined;

  return (
    <Dialog
      title="New visualization"
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error">{error}</span>}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button is-primary" disabled={creating || chosenFiles.length === 0} onClick={() => void create()}>
            {gaps && gaps.length > 0 ? 'Create anyway' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form">
        {projects.length > 1 && (
          <Field label="Project">
            <select className="input" value={projectId} onChange={(event) => changeProject(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Name">
          <input className="input" value={name ?? defaultName} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.target.select()} />
        </Field>

        <fieldset className="fieldset">
          <legend>Files</legend>
          {projectFiles.length === 0 ? (
            <p className="field-hint">This project has no files yet. Upload one first.</p>
          ) : (
            <>
              <ul className="check-list">
                {projectFiles.map((file) => (
                  <li key={file.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={selected.includes(file.id)}
                        onChange={(event) => setSelected((current) => (event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id)))}
                      />
                      <FileDot color={file.color} />
                      <span className="check-label">{file.name}</span>
                      <span className="check-meta">{plural(file.records, 'record')}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="field-hint">The same query runs on each file. In charts, every file gets its own color.</p>
            </>
          )}
        </fieldset>

        <fieldset className="fieldset">
          <legend>Start from</legend>
          <div className="start-grid">
            {(['chart', 'table'] as const).map((kind) => (
              <label key={kind} className="start-card">
                <input type="radio" name="start" checked={'kind' in start && start.kind === kind} onChange={() => setStart({ kind })} />
                <Icon name={kind === 'chart' ? 'line' : 'table'} size={18} />
                <span>
                  <strong>{kind === 'chart' ? 'A new chart' : 'A new table'}</strong>
                  <small>{kind === 'chart' ? 'Lines, areas, bars or points' : 'Rows and columns'}</small>
                </span>
              </label>
            ))}
          </div>
          {templates.length > 0 && (
            <ul className="template-list">
              {templates.map((candidate) => {
                const missing = fit?.get(candidate.id);
                return (
                  <li key={candidate.id}>
                    <label className="template-row">
                      <input type="radio" name="start" checked={'templateId' in start && start.templateId === candidate.id} onChange={() => setStart({ templateId: candidate.id })} />
                      <Icon name="star" />
                      <span className="template-name">{candidate.name}</span>
                      <span className="template-kind">{candidate.kind}</span>
                      {chosenFiles.length > 0 &&
                        (missing === undefined ? (
                          <span className="chip">checking…</span>
                        ) : missing.length === 0 ? (
                          <span className="chip is-ok">
                            <Icon name="check" size={12} />
                            fits
                          </span>
                        ) : (
                          <span className="chip is-warn">
                            <Icon name="alert" size={12} />
                            fields missing
                          </span>
                        ))}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {gaps && gaps.length > 0 && (
            <div className="notice is-warn" role="status">
              <strong>This template reads fields that are not in every selected file.</strong>
              <ul>
                {gaps.map(({ file, missing }) => (
                  <li key={file.id}>
                    {file.name}: {missing.join(', ')}
                  </li>
                ))}
              </ul>
              <span>You can still create it and adjust the blocks: the ones reading missing fields are flagged.</span>
            </div>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}
