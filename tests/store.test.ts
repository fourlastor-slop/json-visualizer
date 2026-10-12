import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The store talks to the data worker through client.ts. There are no workers here, so
// route those calls straight to the code the worker would run.
vi.mock('../src/data/client', async () => {
  const files = await import('../src/data/files');
  const engine = await import('../src/data/engine');
  return {
    ingestFile: files.ingest,
    forgetFiles: async (ids: string[]) => files.forget(ids),
    previewFile: async (fileId: string, rev: number, offset: number, limit: number) => {
      const records = await files.loadRecords(fileId, rev);
      return { rows: engine.toRows(records.slice(offset, offset + limit)).rows, total: records.length };
    },
    runFileQuery: async (file: { id: string; rev: number }, query: string) => engine.runQuery(query, await files.loadRecords(file.id, file.rev)),
  };
});

import { runFileQuery } from '../src/data/client';
import { separation } from '../src/data/colors';
import { getAll } from '../src/data/db';
import * as files from '../src/data/files';
import { keysOf } from '../src/data/schema';
import * as store from '../src/data/store';
import type { FileChunk } from '../src/data/types';

const upload = (name: string, text: string) => new File([text], name);
const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n');
const query = async (fileId: string, jsonata: string) => (await runFileQuery(store.getState().files.find((f) => f.id === fileId)!, jsonata)).rows;

/** What a freshly opened tab would see. */
async function reloaded() {
  await store.loadAll();
  return store.getState();
}

describe('projects, files and visualizations', () => {
  let projectId: string;
  let a: string;
  let b: string;

  beforeAll(async () => {
    await store.loadAll();
  });

  it('starts empty', () => {
    expect(store.getState()).toMatchObject({ ready: true, failure: null, projects: [], files: [] });
  });

  it('creates and renames projects', async () => {
    const project = await store.createProject('  Self-play  ');
    projectId = project.id;
    expect(project.name).toBe('Self-play');
    await store.renameProject(projectId, 'Self-play runs');
    expect((await reloaded()).projects.map((p) => p.name)).toEqual(['Self-play runs']);
  });

  it('uploads files, inferring their schema and giving them distinguishable colors', async () => {
    const first = await store.addFile(projectId, upload('pilots.jsonl', lines({ version: 1, wins: 10 }, { version: 2, wins: 12 })));
    const second = await store.addFile(projectId, upload('itself.json', JSON.stringify([{ version: 1, wins: 7 }])));
    [a, b] = [first.id, second.id];
    expect(first).toMatchObject({ name: 'pilots.jsonl', records: 2, chunks: 1, rev: 1 });
    expect(second).toMatchObject({ name: 'itself.json', records: 1 });
    expect(keysOf(first.schema)).toEqual(['version', 'wins']);
    expect(separation(first.color, second.color)).toBeGreaterThanOrEqual(1);
    expect((await reloaded()).files.map((f) => f.name)).toEqual(['pilots.jsonl', 'itself.json']);
    expect(await query(a, '$sum(wins)')).toEqual([{ value: 22 }]);
  });

  it('rejects uploads that are not JSON, without storing anything', async () => {
    await expect(store.addFile(projectId, upload('broken.jsonl', '{"a":1}\n{nope}'))).rejects.toThrow(/Line 2/);
    await expect(store.addFile(projectId, upload('empty.json', '[]'))).rejects.toThrow(/no records/);
    expect((await reloaded()).files).toHaveLength(2);
    expect(await getAll<FileChunk>('chunks')).toHaveLength(2);
  });

  it('appends records, extending the schema', async () => {
    const appended = await store.appendToFile(a, upload('more.jsonl', lines({ version: 3, wins: 15, draws: 1 })));
    expect(appended).toMatchObject({ records: 3, chunks: 2, rev: 2, name: 'pilots.jsonl' });
    expect(keysOf(appended.schema)).toEqual(['version', 'wins', 'draws']);
    expect(await query(a, '$.version')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    // The same answer when read back from storage rather than from the parse cache.
    files.forget([a]);
    expect(await query(a, '$sum(wins)')).toEqual([{ value: 37 }]);
  });

  it('replaces contents while keeping the file, so visualizations stay attached', async () => {
    const viz = await store.createVisualization(projectId, [a, b], { workspace: {}, query: '$', name: 'Wins' });
    const replaced = await store.replaceFile(a, upload('new.json', JSON.stringify([{ version: 9, losses: 4 }])));
    expect(replaced).toMatchObject({ id: a, name: 'pilots.jsonl', records: 1, chunks: 1, rev: 3 });
    expect(keysOf(replaced.schema)).toEqual(['version', 'losses']);
    expect(await query(a, '$')).toEqual([{ version: 9, losses: 4 }]);
    expect((await getAll<FileChunk>('chunks')).filter((chunk) => chunk.fileId === a)).toHaveLength(1);
    expect((await reloaded()).visualizations.find((v) => v.id === viz.id)?.fileIds).toEqual([a, b]);
  });

  it('renames, recolors and reshuffles files', async () => {
    await store.renameFile(a, 'pilots-alone.jsonl');
    await store.setFileColor(a, 5);
    expect((await reloaded()).files.find((f) => f.id === a)).toMatchObject({ name: 'pilots-alone.jsonl', color: 5 });
    const before = store.getState().files.map((f) => f.color).join();
    await store.shuffleFileColors(projectId);
    const after = (await reloaded()).files.map((f) => f.color);
    expect(after.join()).not.toBe(before);
    expect(separation(after[0]!, after[1]!)).toBeGreaterThanOrEqual(1);
  });

  it('keeps a template in sync with its visualization, and after it is gone', async () => {
    const viz = store.getState().visualizations[0]!;
    await store.setTemplate(viz.id, true);
    await store.updateVisualization(viz.id, { query: '$[wins > 1]', name: 'Wins over 1', fields: ['wins'] });
    let state = await reloaded();
    expect(state.templates).toHaveLength(1);
    expect(state.templates[0]).toMatchObject({ name: 'Wins over 1', query: '$[wins > 1]', fields: ['wins'] });
    expect(state.visualizations[0]?.templateId).toBe(state.templates[0]?.id);

    await store.renameTemplate(state.templates[0]!.id, 'Winners');
    expect(store.getState().visualizations[0]?.name).toBe('Winners');

    const copy = await store.duplicateVisualization(viz.id);
    expect(copy).toMatchObject({ name: 'Winners (copy)', templateId: null, fileIds: [a, b] });

    await store.deleteVisualization(viz.id);
    state = await reloaded();
    expect(state.visualizations.map((v) => v.name)).toEqual(['Winners (copy)']);
    expect(state.templates.map((t) => t.name)).toEqual(['Winners']);
  });

  it('unmarks a template', async () => {
    const viz = store.getState().visualizations[0]!;
    await store.setTemplate(viz.id, true);
    expect(store.getState().templates).toHaveLength(2);
    await store.setTemplate(viz.id, false);
    const state = await reloaded();
    expect(state.templates).toHaveLength(1);
    expect(state.visualizations[0]?.templateId).toBeNull();
  });

  it('deletes a file with its contents and detaches it from visualizations', async () => {
    await store.deleteFile(a);
    const state = await reloaded();
    expect(state.files.map((f) => f.id)).toEqual([b]);
    expect(state.visualizations[0]?.fileIds).toEqual([b]);
    expect((await getAll<FileChunk>('chunks')).map((chunk) => chunk.fileId)).toEqual([b]);
  });

  it('deletes a project with everything in it, but keeps templates', async () => {
    await store.deleteProject(projectId);
    const state = await reloaded();
    expect(state).toMatchObject({ projects: [], files: [], visualizations: [] });
    expect(state.templates).toHaveLength(1);
    expect(await getAll<FileChunk>('chunks')).toEqual([]);
    await store.deleteTemplate(state.templates[0]!.id);
    expect((await reloaded()).templates).toEqual([]);
  });
});
