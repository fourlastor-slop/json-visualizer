import { describe, expect, it } from 'vitest';
import { SERIES_COUNT, pickSeriesSlot, pickSeriesSlots, separation } from '../src/data/colors';
import { runQuery, toRows } from '../src/data/engine';
import { byNaturalName, groupByNumber, unitsOf } from '../src/data/grouping';
import { QueryError } from '../src/data/query';
import { ParseError, formatFromName, parseSource, parseStored } from '../src/data/parse';
import { childSchema, flattenPaths, inferSchema, isSequenceLike, itemsSchema, keysOf, mergeSchemas, resolvePath, typeLabel } from '../src/data/schema';

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32, which mixes small seeds well). */
function seeded(seed: number): () => number {
  let state = Math.imul(seed, 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('parsing uploads', () => {
  it('reads JSON Lines, skipping blank lines', () => {
    expect(parseSource('{"a":1}\n\n{"a":2}\r\n', 'jsonl')).toEqual({ format: 'jsonl', records: [{ a: 1 }, { a: 2 }] });
  });

  it('treats a top-level list as records and anything else as one record', () => {
    expect(parseSource('[{"a":1},{"a":2}]', 'json').records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseSource('{"a":{"b":[1,2]}}', 'json').records).toEqual([{ a: { b: [1, 2] } }]);
  });

  it('accepts either format whatever the extension says', () => {
    expect(parseSource('{"a":1}\n{"a":2}', 'json')).toEqual({ format: 'jsonl', records: [{ a: 1 }, { a: 2 }] });
    expect(parseSource('{\n  "a": 1\n}', 'jsonl')).toEqual({ format: 'json', records: [{ a: 1 }] });
    expect(parseSource('[{"a":1},{"a":2}]\n', 'jsonl')).toEqual({ format: 'json', records: [{ a: 1 }, { a: 2 }] });
    expect(parseSource('﻿{"a":1}', null).records).toEqual([{ a: 1 }]);
  });

  it('points at the broken line', () => {
    expect(() => parseSource('{"a":1}\n{"a":\n{"a":3}', 'jsonl')).toThrow(/^Line 2 is not valid JSON/);
    expect(() => parseSource('{"a":1}\n{oops}', 'json')).toThrow(/^Line 2 is not valid JSON/);
    expect(() => parseSource('{\n  "a": 1,\n', 'json')).toThrow(/^Not valid JSON/);
    expect(() => parseSource('  \n', 'json')).toThrow(ParseError);
  });

  it('re-reads stored text in its recorded format', () => {
    expect(parseStored('{"a":1}\n{"a":2}', 'jsonl')).toHaveLength(2);
    expect(parseStored('[1,2,3]', 'json')).toEqual([1, 2, 3]);
  });

  it('guesses the format from the file name', () => {
    expect(formatFromName('metrics.JSONL')).toBe('jsonl');
    expect(formatFromName('events.ndjson')).toBe('jsonl');
    expect(formatFromName('config.json')).toBe('json');
    expect(formatFromName('data.txt')).toBeNull();
  });
});

describe('schema inference', () => {
  const records = [
    { step: 1, loss: 0.9, tag: 'a', ok: true, nested: { x: 1, deep: { y: 'p' } }, list: [{ n: 1 }, { n: 2, extra: 'e' }] },
    { step: 2, loss: 0.7, tag: 'b', ok: false, nested: { x: 2 }, list: [] },
    { step: 3, loss: 0.8, tag: null, scores: { alice: { points: 3 }, bob: { points: 5, bonus: 1 } } },
  ];
  const schema = inferSchema(records);

  it('records the keys, types and ranges seen', () => {
    expect(keysOf(schema)).toEqual(['step', 'loss', 'tag', 'ok', 'nested', 'list', 'scores']);
    expect(typeLabel(resolvePath(schema, ['step']))).toBe('number');
    expect(typeLabel(resolvePath(schema, ['tag']))).toBe('text');
    expect(typeLabel(resolvePath(schema, ['nested']))).toBe('object');
    expect(typeLabel(resolvePath(schema, ['list']))).toBe('list');
    expect(resolvePath(schema, ['loss'])).toMatchObject({ count: 3, min: 0.7, max: 0.9 });
    expect(resolvePath(schema, ['scores'])?.count).toBe(1);
    expect(resolvePath(schema, ['nope'])).toBeUndefined();
  });

  it('sees through lists, as JSONata does', () => {
    expect(keysOf(resolvePath(schema, ['list']))).toEqual(['n', 'extra']);
    expect(typeLabel(resolvePath(schema, ['list', 'n']))).toBe('number');
    expect(itemsSchema(resolvePath(schema, ['list']))?.fields).toHaveProperty('n');
  });

  it('merges the values of a dictionary under "any key"', () => {
    const anyScore = childSchema(resolvePath(schema, ['scores']), null);
    expect(keysOf(anyScore)).toEqual(['points', 'bonus']);
    expect(resolvePath(schema, ['scores', null, 'points'])).toMatchObject({ count: 2, min: 3, max: 5 });
  });

  it('spots fields that count upwards', () => {
    expect(isSequenceLike(resolvePath(schema, ['step']))).toBe(true);
    expect(isSequenceLike(resolvePath(schema, ['loss']))).toBe(false);
    expect(isSequenceLike(resolvePath(inferSchema([{ c: 5 }, { c: 5 }, { c: 5 }, { c: 5 }]), ['c']))).toBe(false);
  });

  it('merges schemas, continuing a sequence across appended data', () => {
    const more = inferSchema([{ step: 4, loss: 0.5, fresh: 'new' }]);
    const merged = mergeSchemas(schema, more, true);
    expect(keysOf(merged)).toContain('fresh');
    expect(resolvePath(merged, ['loss'])).toMatchObject({ count: 4, min: 0.5, max: 0.9 });
    expect(resolvePath(merged, ['step'])?.order).toEqual({ first: 1, last: 4, sorted: true, rises: 3 });
    // The originals are untouched.
    expect(resolvePath(schema, ['loss'])?.count).toBe(3);
    expect(keysOf(schema)).not.toContain('fresh');
    // Data appended out of order breaks the sequence.
    expect(resolvePath(mergeSchemas(schema, inferSchema([{ step: 0 }]), true), ['step'])?.order?.sorted).toBe(false);
  });

  it('is not confused by keys that exist on every object', () => {
    const odd = inferSchema([JSON.parse('{"constructor": 1, "__proto__": {"a": 2}, "toString": "x"}')]);
    expect(keysOf(odd)).toEqual(['constructor', '__proto__', 'toString']);
    expect(typeLabel(resolvePath(odd, ['constructor']))).toBe('number');
    expect(typeLabel(resolvePath(odd, ['__proto__', 'a']))).toBe('number');
    expect(resolvePath(inferSchema([{ a: 1 }]), ['constructor'])).toBeUndefined();
    expect(resolvePath(inferSchema([{ a: 1 }]), ['__proto__'])).toBeUndefined();
  });

  it('lists every nested path for search', () => {
    expect(flattenPaths(schema).map((entry) => entry.path.join('.'))).toEqual([
      'step',
      'loss',
      'tag',
      'ok',
      'nested',
      'list',
      'scores',
      'nested.x',
      'nested.deep',
      'list.n',
      'list.extra',
      'scores.alice',
      'scores.bob',
      'nested.deep.y',
      'scores.alice.points',
      'scores.bob.points',
      'scores.bob.bonus',
    ]);
  });
});

describe('file colors', () => {
  it('always gives two or three files colors that are clearly distinguishable', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = seeded(seed);
      const [a, b] = pickSeriesSlots(2, random) as [number, number];
      expect(separation(a, b), `pair ${a},${b}`).toBeGreaterThanOrEqual(1);
    }
    // A third clearly-separable color does not exist for every starting pair, but the draw
    // never falls back to one of the confusable pairs.
    for (let seed = 1; seed <= 500; seed++) {
      const slots = pickSeriesSlots(3, seeded(seed));
      const worst = Math.min(separation(slots[0]!, slots[1]!), separation(slots[0]!, slots[2]!), separation(slots[1]!, slots[2]!));
      expect(worst, `slots ${slots}`).toBeGreaterThanOrEqual(0.79);
    }
  });

  it('is actually random', () => {
    const first = new Set<number>();
    const pairs = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const slots = pickSeriesSlots(2, seeded(seed));
      first.add(slots[0]!);
      pairs.add(slots.join('-'));
    }
    expect(first.size).toBe(SERIES_COUNT);
    expect(pairs.size).toBeGreaterThan(20);
  });

  it('uses all eight colors before repeating any', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const slots = pickSeriesSlots(8, seeded(seed));
      expect(new Set(slots).size).toBe(8);
      const ninth = pickSeriesSlot(slots, seeded(seed));
      expect(ninth).toBeGreaterThanOrEqual(0);
      expect(ninth).toBeLessThan(SERIES_COUNT);
    }
  });
});

describe('running queries', () => {
  const records = [{ a: 1, tags: ['x'] }, { a: 2 }, { a: 3 }];

  it('always answers with rows', async () => {
    expect((await runQuery('$', records)).rows).toEqual(records);
    expect((await runQuery('$[a > 1].{"a": a}', records)).rows).toEqual([{ a: 2 }, { a: 3 }]);
    // JSONata unwraps single results and yields nothing for empty ones.
    expect((await runQuery('$[a = 2].{"a": a}', records)).rows).toEqual([{ a: 2 }]);
    expect((await runQuery('$[a > 9]', records)).rows).toEqual([]);
    expect((await runQuery('$sum(a)', records)).rows).toEqual([{ value: 6 }]);
    expect((await runQuery('a', records)).rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it('caps very large results and says how many rows there were', async () => {
    const result = await runQuery('$', records, { maxRows: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('returns plain JSON, without functions or sequence flags', () => {
    const sequence = Object.assign([1, 2], { sequence: true });
    expect(toRows([{ list: sequence, fn: () => 1, nothing: undefined, n: Number.NaN }]).rows).toEqual([{ list: [1, 2], n: null }]);
  });

  it('reports syntax and runtime errors with their message', async () => {
    await expect(runQuery('$[a >', records)).rejects.toBeInstanceOf(QueryError);
    await expect(runQuery('$.(a + "x")', records)).rejects.toThrow(/number/);
  });

  it('stops queries that would run forever', async () => {
    await expect(runQuery('($f := function($n) { $f($n + 1) }; $f(1))', records, { timeoutMs: 200 })).rejects.toThrow(/timeout/i);
  });
});

describe('uploads that belong together', () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));
  /** The groups found among some names: combined name, pattern, and members in order. */
  const grouped = (...names: string[]) => {
    const { groups, rest } = groupByNumber(named(...names));
    return { groups: groups.map((group) => [group.name, group.pattern, group.members.map((member) => member.name)]), rest: rest.map((item) => item.name) };
  };

  it('are the files whose names differ only by a number', () => {
    const steps = ['0120', '0240', '0360', '0480'];
    // In the order a file picker hands them over: by name.
    const names = [...steps.map((step) => `pilots-alone.${step}.json`), 'notes.json', ...steps.map((step) => `with-itself.${step}.json`)];
    const { groups, rest } = groupByNumber(named(...names));
    expect(groups.map((group) => [group.name, group.pattern, group.numbers])).toEqual([
      ['pilots-alone.json', 'pilots-alone.*.json', steps],
      ['with-itself.json', 'with-itself.*.json', steps],
    ]);
    expect(groups[1]!.members.map((member) => member.name)).toEqual(steps.map((step) => `with-itself.${step}.json`));
    expect(rest).toEqual([{ name: 'notes.json' }]);
  });

  it('are put in the order of their numbers, however they are written', () => {
    expect(grouped('step-10.json', 'step-9.json', 'step-100.json').groups).toEqual([['step.json', 'step-*.json', ['step-9.json', 'step-10.json', 'step-100.json']]]);
    expect(grouped('t-20261012103000123456.log', 't-9.log', 't-20261012103000123455.log').groups[0]![2]).toEqual(['t-9.log', 't-20261012103000123455.log', 't-20261012103000123456.log']);
  });

  it('are named after what they share', () => {
    const nameOf = (...names: string[]) => grouped(...names).groups.map((group) => group[0]);
    expect(nameOf('0120-metrics.jsonl', '0240-metrics.jsonl')).toEqual(['metrics.jsonl']);
    expect(nameOf('data_01_final.json', 'data_02_final.json')).toEqual(['data_final.json']);
    expect(nameOf('epoch7 loss.json', 'epoch8 loss.json')).toEqual(['epoch loss.json']);
    expect(nameOf('log (1).json', 'log (2).json')).toEqual(['log.json']);
    expect(nameOf('run.0120', 'run.0240')).toEqual(['run']);
    expect(nameOf('1.json', '2.json')).toEqual(['combined.json']);
  });

  it('go by the last number that differs, when a name has several', () => {
    // A number that is the same everywhere is part of the name.
    expect(grouped('v2-run.0120.json', 'v2-run.0240.json').groups).toEqual([['v2-run.json', 'v2-run.*.json', ['v2-run.0120.json', 'v2-run.0240.json']]]);
    expect(grouped('with-itself.0120.v2.json', 'with-itself.0240.v2.json').groups.map((group) => group.slice(0, 2))).toEqual([['with-itself.v2.json', 'with-itself.*.v2.json']]);
    // Two runs of two steps each are two files, not one and not four.
    expect(grouped('run1-step1.json', 'run2-step1.json', 'run1-step2.json', 'run2-step2.json')).toEqual({
      groups: [
        ['run1-step.json', 'run1-step*.json', ['run1-step1.json', 'run1-step2.json']],
        ['run2-step.json', 'run2-step*.json', ['run2-step1.json', 'run2-step2.json']],
      ],
      rest: [],
    });
  });

  it('are not found where names differ by more than that, or not by a number', () => {
    const alone = (...names: string[]) => expect(grouped(...names)).toEqual({ groups: [], rest: names });
    alone('pilots.json', 'itself.json');
    alone('a1.json', 'b1.json', 'c1.json');
    alone('part1.json', 'part2.jsonl');
    alone('a1.json', 'a01.json');
    alone('only-one.0120.json');
    alone();
  });

  it('take the place of their first member among the other uploads', () => {
    const items = named('b.2.json', 'notes.json', 'a.1.json', 'b.1.json', 'a.2.json');
    const { groups } = groupByNumber(items);
    const made = (combined: typeof groups) => unitsOf(items, combined).map((unit) => [unit.name, unit.sources.map((source) => source.name)]);
    expect(made(groups)).toEqual([
      ['b.json', ['b.1.json', 'b.2.json']],
      ['notes.json', ['notes.json']],
      ['a.json', ['a.1.json', 'a.2.json']],
    ]);
    // A group that is not combined stays the files it was.
    expect(made(groups.filter((group) => group.name === 'a.json'))).toEqual([
      ['b.2.json', ['b.2.json']],
      ['notes.json', ['notes.json']],
      ['a.json', ['a.1.json', 'a.2.json']],
      ['b.1.json', ['b.1.json']],
    ]);
    expect(made([]).map((unit) => unit[0])).toEqual(items.map((item) => item.name));
  });

  it('are sorted the way a person would sort names', () => {
    expect(['part10.json', 'part2.json', 'Part1.json', 'part009.json'].sort(byNaturalName)).toEqual(['Part1.json', 'part2.json', 'part009.json', 'part10.json']);
  });
});
