import { describe, expect, it } from 'vitest';
import { compileState } from '../src/blocks/headless';
import { starterWorkspace } from '../src/blocks/starter';
import { inferSchema } from '../src/data/schema';
import { fileNameFor } from '../src/lib/download';
import { baseName, formatBytes, formatNumber, formatValue, plural } from '../src/lib/format';
import { hrefFor, parseRoute } from '../src/lib/router';

describe('starter blocks', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    board: 'mean-pool',
    constant: 7,
    loss: 1 / (i + 1),
    training_schedule_update: i,
    version: 2280 + i,
    win_rate: 0.5 + i / 100,
  }));

  it('charts the field that counts upwards against the first number that varies', () => {
    const schema = inferSchema(records);
    // `version` is preferred over another counter by its name; `constant` never varies.
    expect(compileState(starterWorkspace(schema, 'chart'), schema).query).toBe('$.{\n  "version": version,\n  "loss": loss\n}');
  });

  it('falls back to the steadiest counter, then to any plain field', () => {
    const counters = inferSchema(records.map(({ version: _version, ...rest }) => rest));
    expect(compileState(starterWorkspace(counters, 'chart'), counters).query).toBe('$.{\n  "training_schedule_update": training_schedule_update,\n  "loss": loss\n}');
    const unordered = inferSchema([{ name: 'b', n: 3 }, { name: 'a', n: 1 }, { name: 'c', n: 2 }]);
    expect(compileState(starterWorkspace(unordered, 'chart'), unordered).query).toBe('$.{\n  "name": name,\n  "n": n\n}');
  });

  it('starts tables, and charts with nothing to go on, from every record', () => {
    const schema = inferSchema(records);
    expect(compileState(starterWorkspace(schema, 'table'), schema).query).toBe('$');
    expect(compileState(starterWorkspace(undefined, 'chart'), undefined).query).toBe('$');
    expect(compileState(starterWorkspace(inferSchema([1, 2, 3]), 'chart'), undefined).query).toBe('$');
  });
});

describe('routes', () => {
  it('round-trip through the URL hash', () => {
    for (const route of [{ page: 'projects' }, { page: 'templates' }, { page: 'project', projectId: 'abc' }, { page: 'editor', projectId: 'abc', vizId: 'def' }] as const) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });

  it('send anything unrecognized to the project list', () => {
    expect(parseRoute('')).toEqual({ page: 'projects' });
    expect(parseRoute('#/nowhere/at/all')).toEqual({ page: 'projects' });
    expect(parseRoute('#/p')).toEqual({ page: 'projects' });
    expect(parseRoute('#/p/abc/v')).toEqual({ page: 'project', projectId: 'abc' });
  });
});

describe('formatting', () => {
  it('writes numbers with the digits worth reading', () => {
    expect([7297227, 12345.678, 2399, 2024, 1234.56, 79.627, 0.06340965, 0.00001234, -0.5, 0].map(formatNumber)).toEqual([
      '7,297,227',
      '12,345.7',
      '2399',
      '2024',
      '1234.6',
      '79.627',
      '0.06341',
      '1.23e-5',
      '-0.5',
      '0',
    ]);
  });

  it('writes counts, sizes and names for people', () => {
    expect(plural(1, 'record')).toBe('1 record');
    expect(plural(1920, 'row')).toBe('1,920 rows');
    expect([120, 18_841, 4_188_406, 3 * 1024 ** 3].map(formatBytes)).toEqual(['120 B', '18.4 KB', '4 MB', '3 GB']);
    expect(baseName('pilots-alone-metrics.jsonl')).toBe('pilots-alone-metrics');
    expect(baseName('archive.tar')).toBe('archive.tar');
    expect(fileNameFor('  Win rates: pilots / start?  ', 'csv')).toBe('Win rates pilots start.csv');
    expect(fileNameFor('///', 'csv')).toBe('untitled.csv');
  });

  it('shows any value on one line', () => {
    expect(formatValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(formatValue('x'.repeat(200) as unknown, 10)).toBe('x'.repeat(200));
    expect(formatValue({ long: 'x'.repeat(200) }, 20)).toHaveLength(20);
    expect(formatValue(null)).toBe('');
    expect(formatValue(true)).toBe('true');
  });
});
