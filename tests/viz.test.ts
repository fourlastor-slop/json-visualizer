import { describe, expect, it } from 'vitest';
import { DASH_PATTERNS, seriesColor } from '../src/data/colors';
import { DEFAULT_CHART, DEFAULT_TABLE } from '../src/data/types';
import { barPath, buildXAxis, buildYAxis, linePixels, nearestIndex, pointsInView } from '../src/viz/chartGeometry';
import { type FileRows, buildChart } from '../src/viz/chartModel';
import { describeColumns, toTime } from '../src/viz/columns';
import { buildTable, toCsv } from '../src/viz/tableModel';

const pilots: FileRows = {
  id: 'p',
  label: 'pilots-alone',
  color: 0,
  rows: [
    { version: 2399, 'pilots %': 79.6, 'the start %': 45.5 },
    { version: 2519, 'pilots %': 80.6, 'the start %': 53.2 },
  ],
};
const itself: FileRows = {
  id: 'i',
  label: 'with-itself',
  color: 1,
  rows: [
    { version: 2399, 'pilots %': 78.1, 'the start %': 63.5 },
    { version: 2519, 'pilots %': 78.5, 'the start %': 65.7 },
  ],
};

describe('columns', () => {
  it('types columns by what they hold', () => {
    const columns = describeColumns([[{ n: 1, t: 'a', d: '2026-10-12', b: true, o: { x: 1 }, mixed: 1, gone: null }, { n: 2.5, t: 'b', d: '2026-10-13T08:00:00Z', mixed: 'x', late: 3 }]]);
    expect(columns).toEqual([
      { name: 'n', type: 'number' },
      { name: 't', type: 'text' },
      { name: 'd', type: 'date' },
      { name: 'b', type: 'boolean' },
      { name: 'o', type: 'other' },
      { name: 'mixed', type: 'text' },
      { name: 'gone', type: 'empty' },
      { name: 'late', type: 'number' },
    ]);
  });

  it('reads ISO dates and Unix timestamps as times', () => {
    expect(toTime('2026-10-12T00:00:00Z')).toBe(Date.UTC(2026, 9, 12));
    expect(toTime('2026-10-12')).toBe(Date.UTC(2026, 9, 12));
    expect(toTime(1_760_000_000)).toBe(1_760_000_000_000);
    expect(toTime(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(toTime('yesterday')).toBeNaN();
  });
});

describe('chart model', () => {
  it('plots one file with a color per measure', () => {
    const model = buildChart([pilots], DEFAULT_CHART);
    expect(model).toMatchObject({ xKind: 'number', x: 'version', y: ['pilots %', 'the start %'], empty: null });
    expect(model.panels).toHaveLength(1);
    expect(model.panels[0]!.series.map((s) => [s.label, s.color, s.dash])).toEqual([
      ['pilots %', seriesColor(0), ''],
      ['the start %', seriesColor(1), ''],
    ]);
    expect(model.panels[0]!.series[0]!.points).toEqual([
      { x: 2399, y: 79.6 },
      { x: 2519, y: 80.6 },
    ]);
    expect(model.legend).toEqual([
      [
        { key: 'measure:0', label: 'pilots %', color: seriesColor(0), dash: '' },
        { key: 'measure:1', label: 'the start %', color: seriesColor(1), dash: '' },
      ],
    ]);
  });

  it('gives a lone series its file’s color and no legend', () => {
    const model = buildChart([{ ...pilots, color: 4 }], { ...DEFAULT_CHART, y: ['pilots %'] });
    expect(model.legend).toEqual([]);
    expect(model.panels[0]!.series.map((s) => s.color)).toEqual([seriesColor(4)]);
  });

  it('compares files by color, with one panel per measure', () => {
    const model = buildChart([pilots, itself], DEFAULT_CHART);
    expect(model.panels.map((panel) => panel.title)).toEqual(['pilots %', 'the start %']);
    for (const panel of model.panels) {
      expect(panel.series.map((s) => [s.label, s.color, s.dash])).toEqual([
        ['pilots-alone', seriesColor(0), ''],
        ['with-itself', seriesColor(1), ''],
      ]);
    }
    expect(model.legend).toEqual([
      [
        { key: 'file:p', label: 'pilots-alone', color: seriesColor(0), dash: '' },
        { key: 'file:i', label: 'with-itself', color: seriesColor(1), dash: '' },
      ],
    ]);
  });

  it('overlays files and measures as color × stroke pattern, on request', () => {
    const model = buildChart([pilots, itself], { ...DEFAULT_CHART, layout: 'overlay' });
    expect(model.panels).toHaveLength(1);
    expect(model.panels[0]!.series.map((s) => [s.label, s.color, s.dash, s.legend])).toEqual([
      ['pilots % · pilots-alone', seriesColor(0), DASH_PATTERNS[0], ['file:p', 'measure:0']],
      ['pilots % · with-itself', seriesColor(1), DASH_PATTERNS[0], ['file:i', 'measure:0']],
      ['the start % · pilots-alone', seriesColor(0), DASH_PATTERNS[1], ['file:p', 'measure:1']],
      ['the start % · with-itself', seriesColor(1), DASH_PATTERNS[1], ['file:i', 'measure:1']],
    ]);
    expect(model.legend.map((group) => group.map((entry) => [entry.label, entry.color]))).toEqual([
      [
        ['pilots-alone', seriesColor(0)],
        ['with-itself', seriesColor(1)],
      ],
      [
        ['pilots %', null],
        ['the start %', null],
      ],
    ]);
  });

  it('never repeats a color for a ninth series: it reuses hues with a new stroke', () => {
    const rows = [Object.fromEntries([['x', 1], ...Array.from({ length: 10 }, (_, i) => [`m${i}`, i])])];
    const model = buildChart([{ id: 'f', label: 'f', color: 0, rows }], { ...DEFAULT_CHART, y: Array.from({ length: 10 }, (_, i) => `m${i}`) });
    const series = model.panels[0]!.series;
    expect(series[8]).toMatchObject({ color: seriesColor(0), dash: DASH_PATTERNS[1] });
    expect(new Set(series.map((s) => `${s.color}|${s.dash}`)).size).toBe(10);
  });

  it('splits rows into series by a column', () => {
    const rows = [
      { version: 1, matchup: 'burn', wins: 10 },
      { version: 1, matchup: 'heroes', wins: 20 },
      { version: 2, matchup: 'burn', wins: 12 },
    ];
    const one = buildChart([{ id: 'f', label: 'f', color: 2, rows }], { ...DEFAULT_CHART, splitBy: 'matchup' });
    expect(one.panels[0]!.series.map((s) => [s.label, s.points.length])).toEqual([
      ['burn', 2],
      ['heroes', 1],
    ]);
    const two = buildChart([{ id: 'f', label: 'f', color: 2, rows }, { id: 'g', label: 'g', color: 3, rows }], { ...DEFAULT_CHART, splitBy: 'matchup' });
    expect(two.panels.map((panel) => [panel.title, panel.series.map((s) => s.label)])).toEqual([
      ['burn', ['f', 'g']],
      ['heroes', ['f', 'g']],
    ]);
  });

  it('puts bars in category slots, ordered when the categories are numbers', () => {
    const model = buildChart([{ id: 'f', label: 'f', color: 0, rows: [{ step: 30, n: 3 }, { step: 10, n: 1 }, { step: 20, n: 2 }] }], { ...DEFAULT_CHART, type: 'bar' });
    expect(model.xKind).toBe('category');
    expect(model.categories).toEqual(['10', '20', '30']);
    expect(model.panels[0]!.series[0]!.points).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
    ]);
  });

  it('uses a time axis for dates and a category axis for text', () => {
    const dated = buildChart([{ id: 'f', label: 'f', color: 0, rows: [{ day: '2026-10-12', n: 1 }, { day: '2026-10-13', n: 2 }] }], DEFAULT_CHART);
    expect(dated.xKind).toBe('time');
    expect(dated.panels[0]!.series[0]!.points[0]).toEqual({ x: Date.UTC(2026, 9, 12), y: 1 });
    const named = buildChart([{ id: 'f', label: 'f', color: 0, rows: [{ deck: 'burn', n: 1 }, { deck: 'heroes', n: 2 }] }], DEFAULT_CHART);
    expect(named).toMatchObject({ xKind: 'category', categories: ['burn', 'heroes'] });
  });

  it('skips rows without a usable X or Y instead of plotting zeros', () => {
    const model = buildChart([{ id: 'f', label: 'f', color: 0, rows: [{ x: 1, y: 5 }, { x: 2 }, { y: 7 }, { x: 3, y: null }, { x: 4, y: 9 }] }], DEFAULT_CHART);
    expect(model.panels[0]!.series[0]!.points).toEqual([
      { x: 1, y: 5 },
      { x: 4, y: 9 },
    ]);
  });

  it('caps the columns plotted by default and says so', () => {
    const row = Object.fromEntries([['step', 1], ...Array.from({ length: 20 }, (_, i) => [`metric_${i}`, i])]);
    const model = buildChart([{ id: 'f', label: 'f', color: 0, rows: [row] }], DEFAULT_CHART);
    expect(model.y).toHaveLength(6);
    expect(model.notes[0]).toMatch(/6 of 20 numeric columns/);
  });

  it('explains why there is nothing to draw', () => {
    expect(buildChart([{ ...pilots, rows: [] }], DEFAULT_CHART).empty).toMatch(/no rows/);
    expect(buildChart([{ ...pilots, rows: [{ name: 'a' }] }], DEFAULT_CHART).empty).toMatch(/no numeric column/);
    expect(buildChart([{ ...pilots, rows: [{ o: { a: 1 } }] }], DEFAULT_CHART).empty).toMatch(/None of the columns/);
  });
});

describe('chart geometry', () => {
  const model = buildChart([pilots], DEFAULT_CHART);

  it('labels whole-number X ticks without thousands separators', () => {
    const axis = buildXAxis(model, [2399, 3239], 600);
    expect(axis.ticks.map((tick) => tick.label)).toContain('2600');
    expect(axis.toPx(2399)).toBeCloseTo(7);
    expect(axis.fromPx(axis.toPx(2800))).toBeCloseTo(2800);
  });

  it('rounds the Y axis out to clean numbers and includes zero on request', () => {
    const series = model.panels[0]!.series;
    expect(buildYAxis(series, null, false, 300).domain).toEqual([45, 85]);
    expect(buildYAxis(series, null, true, 300).domain).toEqual([0, 90]);
    expect(buildYAxis([{ ...series[0]!, points: [{ x: 1, y: 5 }] }], null, false, 300).domain[0]).toBeLessThan(5);
  });

  it('finds the nearest value and the points in view', () => {
    const values = Float64Array.from([10, 20, 30, 40]);
    expect([9, 14, 16, 31, 99].map((target) => nearestIndex(values, target))).toEqual([0, 0, 1, 2, 3]);
    expect(nearestIndex(new Float64Array(), 5)).toBe(-1);
    const points = [10, 20, 30, 40, 50].map((x) => ({ x, y: x }));
    expect(pointsInView(points, [22, 38]).map((point) => point.x)).toEqual([20, 30, 40]);
    expect(pointsInView(points, [0, 100])).toBe(points);
  });

  it('thins out a dense line without changing its extremes', () => {
    const points = Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: Math.sin(i / 50) * (i % 97) }));
    const x = buildXAxis({ ...model, xKind: 'number' }, [0, 19_999], 400);
    const y = buildYAxis([{ ...model.panels[0]!.series[0]!, points }], null, false, 300);
    const pixels = linePixels(points, x, y, 400);
    expect(pixels.length).toBeLessThan(1700);
    const all = points.map((point) => y.toPx(point.y));
    expect(Math.min(...pixels.map((p) => p.py))).toBe(Math.min(...all));
    expect(Math.max(...pixels.map((p) => p.py))).toBe(Math.max(...all));
  });

  it('rounds the data end of a bar, not its base', () => {
    expect(barPath(10, 20, 100, 40)).toBe('M10,100L10,44Q10,40 14,40L26,40Q30,40 30,44L30,100Z');
    expect(barPath(10, 20, 100, 160)).toBe('M10,100L10,156Q10,160 14,160L26,160Q30,160 30,156L30,100Z');
  });
});

describe('table model', () => {
  it('shows one file as it is', () => {
    const table = buildTable([pilots], DEFAULT_TABLE);
    expect(table.columns.map((column) => column.label)).toEqual(['version', 'pilots %', 'the start %']);
    expect(table.rows).toEqual([
      [2399, 79.6, 45.5],
      [2519, 80.6, 53.2],
    ]);
    expect(table.rowDots).toBeNull();
  });

  it('stacks several files under a file column', () => {
    const table = buildTable([pilots, itself], DEFAULT_TABLE);
    expect(table.columns.map((column) => column.label)).toEqual(['file', 'version', 'pilots %', 'the start %']);
    expect(table.rows.map((row) => row[0])).toEqual(['pilots-alone', 'pilots-alone', 'with-itself', 'with-itself']);
    expect(table.rowDots).toEqual([seriesColor(0), seriesColor(0), seriesColor(1), seriesColor(1)]);
  });

  it('sets files side by side on a key column', () => {
    const table = buildTable([pilots, { ...itself, rows: [...itself.rows, { version: 2639, 'pilots %': 77.6 }] }], { layout: 'compare', key: null });
    expect(table.columns.map((column) => [column.group, column.label])).toEqual([
      [undefined, 'version'],
      ['pilots %', 'pilots-alone'],
      ['pilots %', 'with-itself'],
      ['the start %', 'pilots-alone'],
      ['the start %', 'with-itself'],
    ]);
    expect(table.rows).toEqual([
      [2399, 79.6, 78.1, 45.5, 63.5],
      [2519, 80.6, 78.5, 53.2, 65.7],
      [2639, undefined, 77.6, undefined, undefined],
    ]);
  });

  it('exports CSV, quoting what needs quoting', () => {
    const table = buildTable([{ id: 'f', label: 'f', color: 0, rows: [{ name: 'a,b', note: 'say "hi"', nested: { k: 1 }, n: 1.5, gone: null }] }], DEFAULT_TABLE);
    expect(toCsv(table)).toBe('name,note,nested,n,gone\r\n"a,b","say ""hi""","{""k"":1}",1.5,');
  });
});
