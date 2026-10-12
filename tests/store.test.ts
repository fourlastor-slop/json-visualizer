import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The store talks to the data worker through client.ts; see directClient.ts.
vi.mock('../src/data/client', () => import('./directClient'));

import { runFileQuery } from '../src/data/client';
import { separation } from '../src/data/colors';
import { getAll } from '../src/data/db';
import * as files from '../src/data/files';
import { childSchema, isSequenceLike, keysOf } from '../src/data/schema';
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

describe('several uploads as one file', () => {
  let projectId: string;
  const part = (n: number, extra: Record<string, unknown> = {}) => upload(`run.${String(n).padStart(4, '0')}.json`, JSON.stringify({ version: n, wins: n * 2, ...extra }));

  beforeAll(async () => {
    projectId = (await store.createProject('Checkpoints')).id;
  });

  it('are stored as its parts, in the order given', async () => {
    const file = await store.addFile(projectId, [part(120), part(240), part(360, { draws: 1 })], 'run.json');
    expect(file).toMatchObject({ name: 'run.json', records: 3, chunks: 3, rev: 1 });
    expect(file.size).toBe(26 + 26 + 36);
    expect(keysOf(file.schema)).toEqual(['version', 'wins', 'draws']);
    // The parts follow one another, so a field that grows across them is seen to grow.
    expect(isSequenceLike(childSchema(file.schema, 'version'))).toBe(true);
    expect(await query(file.id, '$.version')).toEqual([{ value: 120 }, { value: 240 }, { value: 360 }]);
    // The same from storage as from the parse cache.
    files.forget([file.id]);
    expect(await query(file.id, '$sum(wins)')).toEqual([{ value: 1440 }]);
    expect((await getAll<FileChunk>('chunks')).map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect((await reloaded()).files.find((f) => f.id === file.id)).toMatchObject({ records: 3, chunks: 3 });
  });

  it('are named after the first one unless told otherwise', async () => {
    const file = await store.addFile(projectId, [part(1), part(2)]);
    expect(file.name).toBe('run.0001.json');
    await store.deleteFile(file.id);
  });

  it('are appended in one step', async () => {
    const run = store.getState().files.find((f) => f.name === 'run.json')!;
    const appended = await store.appendToFile(run.id, [part(480), upload('more.jsonl', lines({ version: 600, wins: 1 }, { version: 720, wins: 2 }))]);
    expect(appended).toMatchObject({ records: 6, chunks: 5, rev: 2 });
    expect(await query(run.id, '$.version')).toEqual([120, 240, 360, 480, 600, 720].map((value) => ({ value })));
    expect((await getAll<FileChunk>('chunks')).map((chunk) => [chunk.seq, chunk.format])).toEqual([
      [0, 'json'],
      [1, 'json'],
      [2, 'json'],
      [3, 'json'],
      [4, 'jsonl'],
    ]);
  });

  it('store nothing when one of them cannot be read, and say which', async () => {
    const run = store.getState().files.find((f) => f.name === 'run.json')!;
    await expect(store.appendToFile(run.id, [part(840), upload('run.0960.json', '{"version": 960,'), part(1080)])).rejects.toThrow(/^run\.0960\.json: Not valid JSON/);
    await expect(store.addFile(projectId, [part(1), upload('nothing.json', '[]')], 'other.json')).rejects.toThrow('nothing.json: The file contains no records.');
    await expect(store.addFile(projectId, [], 'none.json')).rejects.toThrow('There is nothing to upload.');
    const state = await reloaded();
    expect(state.files.filter((f) => f.projectId === projectId).map((f) => [f.name, f.records, f.rev])).toEqual([['run.json', 6, 2]]);
    expect(await getAll<FileChunk>('chunks')).toHaveLength(5);
  });

  it('replace what was there', async () => {
    const run = store.getState().files.find((f) => f.name === 'run.json')!;
    const replaced = await store.replaceFile(run.id, [part(10), part(20)]);
    expect(replaced).toMatchObject({ id: run.id, records: 2, chunks: 2, rev: 3 });
    expect(await query(run.id, '$.version')).toEqual([{ value: 10 }, { value: 20 }]);
    expect((await getAll<FileChunk>('chunks')).map((chunk) => chunk.seq)).toEqual([0, 1]);
    await store.deleteProject(projectId);
    expect(await getAll<FileChunk>('chunks')).toEqual([]);
  });
});
