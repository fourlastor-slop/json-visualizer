/**
 * The app's state: projects, file metadata, visualizations and templates, held in memory
 * and written through to IndexedDB. File contents never come here; see files.ts.
 */
import { useSyncExternalStore } from 'react';
import { timestamp } from '../lib/clock';
import { newId } from '../lib/ids';
import { forgetFiles, ingestFile } from './client';
import { pickSeriesSlot, pickSeriesSlots } from './colors';
import { chunksOf, getAll, put, transact } from './db';
import { DEFAULT_CHART, DEFAULT_TABLE, type DataFile, type Project, type Template, type Visualization, type VizDefinition } from './types';

export interface AppState {
  /** False until the stored data has been read. */
  ready: boolean;
  /** Set when browser storage could not be opened at all. */
  failure: string | null;
  projects: Project[];
  files: DataFile[];
  visualizations: Visualization[];
  templates: Template[];
}

let state: AppState = { ready: false, failure: null, projects: [], files: [], visualizations: [], templates: [] };
const listeners = new Set<() => void>();

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState(): AppState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

const byCreation = <T extends { createdAt: number }>(items: T[]): T[] => [...items].sort((a, b) => a.createdAt - b.createdAt);

/** Reads everything but file contents from storage. */
export async function loadAll(): Promise<void> {
  try {
    const [projects, files, visualizations, templates] = await Promise.all([
      getAll<Project>('projects'),
      getAll<DataFile>('files'),
      getAll<Visualization>('visualizations'),
      getAll<Template>('templates'),
    ]);
    setState({
      ready: true,
      failure: null,
      projects: byCreation(projects),
      files: byCreation(files),
      visualizations: byCreation(visualizations),
      templates: byCreation(templates),
    });
  } catch (error) {
    setState({ ready: true, failure: error instanceof Error ? error.message : String(error) });
  }
}

// Other tabs of the app share the same storage: tell them when it changes, and reload
// when they do.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('json-explorer');
channel?.addEventListener('message', () => void loadAll());
// Outside a browser (tests), an open channel must not keep the process alive.
(channel as { unref?: () => void } | null)?.unref?.();

function announce(): void {
  channel?.postMessage('changed');
}

const replace = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((existing) => existing.id === item.id) ? items.map((existing) => (existing.id === item.id ? item : existing)) : [...items, item];

// ── Projects ────────────────────────────────────────────────────────────────

export async function createProject(name: string): Promise<Project> {
  const now = timestamp();
  const project: Project = { id: newId(), name: name.trim() || 'Untitled project', createdAt: now, updatedAt: now };
  await put('projects', project);
  setState({ projects: [...state.projects, project] });
  announce();
  return project;
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  const project = state.projects.find((p) => p.id === projectId);
  const trimmed = name.trim();
  if (!project || trimmed === '' || trimmed === project.name) return;
  const updated = { ...project, name: trimmed, updatedAt: timestamp() };
  await put('projects', updated);
  setState({ projects: replace(state.projects, updated) });
  announce();
}

async function touchProject(projectId: string): Promise<void> {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  const updated = { ...project, updatedAt: timestamp() };
  await put('projects', updated);
  setState({ projects: replace(state.projects, updated) });
}

/** Deletes a project with its files and visualizations. Templates made from it remain. */
export async function deleteProject(projectId: string): Promise<void> {
  const fileIds = state.files.filter((file) => file.projectId === projectId).map((file) => file.id);
  const vizIds = state.visualizations.filter((viz) => viz.projectId === projectId).map((viz) => viz.id);
  await transact(['projects', 'files', 'chunks', 'visualizations'], 'readwrite', (tx) => {
    tx.objectStore('projects').delete(projectId);
    for (const fileId of fileIds) {
      tx.objectStore('files').delete(fileId);
      tx.objectStore('chunks').delete(chunksOf(fileId));
    }
    for (const vizId of vizIds) tx.objectStore('visualizations').delete(vizId);
  });
  setState({
    projects: state.projects.filter((project) => project.id !== projectId),
    files: state.files.filter((file) => file.projectId !== projectId),
    visualizations: state.visualizations.filter((viz) => viz.projectId !== projectId),
  });
  void forgetFiles(fileIds);
  announce();
}

// ── Files ───────────────────────────────────────────────────────────────────

let askedToPersist = false;

/** Asks the browser not to evict the data under storage pressure. Best effort. */
function requestPersistence(): void {
  if (askedToPersist) return;
  askedToPersist = true;
  void navigator.storage?.persist?.().catch(() => false);
}

/** Uploads a new file into a project, giving it a color unlike those of its siblings. */
export async function addFile(projectId: string, source: File, name = source.name): Promise<DataFile> {
  requestPersistence();
  const taken = state.files.filter((file) => file.projectId === projectId).map((file) => file.color);
  const file = await ingestFile({
    mode: 'create',
    file: { id: newId(), projectId, name, color: pickSeriesSlot(taken) },
    source,
    sourceName: source.name,
  });
  setState({ files: replace(state.files, file) });
  await touchProject(projectId);
  announce();
  return file;
}

/** Adds the records of an upload after the existing ones. */
export async function appendToFile(fileId: string, source: File): Promise<DataFile> {
  const file = await ingestFile({ mode: 'append', fileId, source, sourceName: source.name });
  setState({ files: replace(state.files, file) });
  await touchProject(file.projectId);
  announce();
  return file;
}

/** Swaps a file's contents for an upload. Visualizations using the file keep working. */
export async function replaceFile(fileId: string, source: File): Promise<DataFile> {
  const file = await ingestFile({ mode: 'replace', fileId, source, sourceName: source.name });
  setState({ files: replace(state.files, file) });
  await touchProject(file.projectId);
  announce();
  return file;
}

async function patchFile(fileId: string, patch: Partial<Pick<DataFile, 'name' | 'color'>>): Promise<void> {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;
  const updated = { ...file, ...patch };
  await put('files', updated);
  setState({ files: replace(state.files, updated) });
  announce();
}

export async function renameFile(fileId: string, name: string): Promise<void> {
  if (name.trim() !== '') await patchFile(fileId, { name: name.trim() });
}

export async function setFileColor(fileId: string, color: number): Promise<void> {
  await patchFile(fileId, { color });
}

/** Draws a fresh random color for every file of a project. */
export async function shuffleFileColors(projectId: string): Promise<void> {
  const files = state.files.filter((file) => file.projectId === projectId);
  if (files.length === 0) return;
  const current = files.map((file) => file.color).join();
  let slots = pickSeriesSlots(files.length);
  // A shuffle that lands on the same colors looks like a broken button.
  for (let attempt = 0; attempt < 8 && slots.join() === current; attempt++) slots = pickSeriesSlots(files.length);
  const updated = files.map((file, i) => ({ ...file, color: slots[i]! }));
  await transact(['files'], 'readwrite', (tx) => {
    for (const file of updated) tx.objectStore('files').put(file);
  });
  setState({ files: state.files.map((file) => updated.find((u) => u.id === file.id) ?? file) });
  announce();
}

/** Deletes a file and takes it out of the visualizations that used it. */
export async function deleteFile(fileId: string): Promise<void> {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;
  const affected = state.visualizations
    .filter((viz) => viz.fileIds.includes(fileId))
    .map((viz) => ({ ...viz, fileIds: viz.fileIds.filter((id) => id !== fileId) }));
  await transact(['files', 'chunks', 'visualizations'], 'readwrite', (tx) => {
    tx.objectStore('files').delete(fileId);
    tx.objectStore('chunks').delete(chunksOf(fileId));
    for (const viz of affected) tx.objectStore('visualizations').put(viz);
  });
  setState({
    files: state.files.filter((f) => f.id !== fileId),
    visualizations: state.visualizations.map((viz) => affected.find((a) => a.id === viz.id) ?? viz),
  });
  void forgetFiles([fileId]);
  await touchProject(file.projectId);
  announce();
}

// ── Visualizations ──────────────────────────────────────────────────────────

const definitionOf = (source: VizDefinition): VizDefinition => ({
  name: source.name,
  kind: source.kind,
  workspace: source.workspace,
  query: source.query,
  fields: source.fields,
  chart: source.chart,
  table: source.table,
});

export async function createVisualization(projectId: string, fileIds: string[], definition: Partial<VizDefinition> & Pick<VizDefinition, 'workspace' | 'query'>): Promise<Visualization> {
  const now = timestamp();
  const viz: Visualization = {
    name: 'Untitled visualization',
    kind: 'chart',
    fields: [],
    chart: DEFAULT_CHART,
    table: DEFAULT_TABLE,
    ...definition,
    id: newId(),
    projectId,
    fileIds,
    templateId: null,
    createdAt: now,
    updatedAt: now,
  };
  await put('visualizations', viz);
  setState({ visualizations: [...state.visualizations, viz] });
  await touchProject(projectId);
  announce();
  return viz;
}

/** Saves changes to a visualization and, if it is marked as a template, to its template. */
export async function updateVisualization(vizId: string, patch: Partial<VizDefinition> & { fileIds?: string[] }): Promise<void> {
  const viz = state.visualizations.find((v) => v.id === vizId);
  if (!viz) return;
  const now = timestamp();
  const updated: Visualization = { ...viz, ...patch, updatedAt: now };
  const template = state.templates.find((t) => t.id === updated.templateId);
  const syncedTemplate: Template | undefined = template && { ...template, ...definitionOf(updated), updatedAt: now };

  // Shown at once; storage follows. Edits arrive in bursts while blocks are dragged.
  setState({
    visualizations: replace(state.visualizations, updated),
    templates: syncedTemplate ? replace(state.templates, syncedTemplate) : state.templates,
  });
  await transact(['visualizations', 'templates'], 'readwrite', (tx) => {
    tx.objectStore('visualizations').put(updated);
    if (syncedTemplate) tx.objectStore('templates').put(syncedTemplate);
  });
  announce();
}

export async function duplicateVisualization(vizId: string): Promise<Visualization | null> {
  const viz = state.visualizations.find((v) => v.id === vizId);
  if (!viz) return null;
  return createVisualization(viz.projectId, viz.fileIds, { ...definitionOf(viz), name: `${viz.name} (copy)` });
}

export async function deleteVisualization(vizId: string): Promise<void> {
  const viz = state.visualizations.find((v) => v.id === vizId);
  if (!viz) return;
  await transact(['visualizations'], 'readwrite', (tx) => {
    tx.objectStore('visualizations').delete(vizId);
  });
  setState({ visualizations: state.visualizations.filter((v) => v.id !== vizId) });
  await touchProject(viz.projectId);
  announce();
}

// ── Templates ───────────────────────────────────────────────────────────────

/**
 * Marks a visualization's query as a template, or unmarks it. While marked, the template
 * follows the visualization's edits; it stays available if the visualization is deleted.
 */
export async function setTemplate(vizId: string, marked: boolean): Promise<void> {
  const viz = state.visualizations.find((v) => v.id === vizId);
  if (!viz || marked === (viz.templateId !== null && state.templates.some((t) => t.id === viz.templateId))) return;
  const now = timestamp();
  if (marked) {
    const template: Template = { ...definitionOf(viz), id: newId(), createdAt: now, updatedAt: now };
    const updated = { ...viz, templateId: template.id };
    await transact(['visualizations', 'templates'], 'readwrite', (tx) => {
      tx.objectStore('templates').put(template);
      tx.objectStore('visualizations').put(updated);
    });
    setState({ templates: [...state.templates, template], visualizations: replace(state.visualizations, updated) });
  } else {
    const templateId = viz.templateId!;
    const updated = { ...viz, templateId: null };
    await transact(['visualizations', 'templates'], 'readwrite', (tx) => {
      tx.objectStore('templates').delete(templateId);
      tx.objectStore('visualizations').put(updated);
    });
    setState({ templates: state.templates.filter((t) => t.id !== templateId), visualizations: replace(state.visualizations, updated) });
  }
  announce();
}

export async function renameTemplate(templateId: string, name: string): Promise<void> {
  const template = state.templates.find((t) => t.id === templateId);
  const trimmed = name.trim();
  if (!template || trimmed === '' || trimmed === template.name) return;
  // A template still tied to a visualization takes its name from it: rename that instead.
  const source = state.visualizations.find((viz) => viz.templateId === templateId);
  if (source) {
    await updateVisualization(source.id, { name: trimmed });
    return;
  }
  const updated = { ...template, name: trimmed, updatedAt: timestamp() };
  await put('templates', updated);
  setState({ templates: replace(state.templates, updated) });
  announce();
}

/** Deletes a template. Visualizations made from it, or marked as it, are unaffected. */
export async function deleteTemplate(templateId: string): Promise<void> {
  const unlinked = state.visualizations.filter((viz) => viz.templateId === templateId).map((viz) => ({ ...viz, templateId: null }));
  await transact(['visualizations', 'templates'], 'readwrite', (tx) => {
    tx.objectStore('templates').delete(templateId);
    for (const viz of unlinked) tx.objectStore('visualizations').put(viz);
  });
  setState({
    templates: state.templates.filter((t) => t.id !== templateId),
    visualizations: state.visualizations.map((viz) => unlinked.find((u) => u.id === viz.id) ?? viz),
  });
  announce();
}
