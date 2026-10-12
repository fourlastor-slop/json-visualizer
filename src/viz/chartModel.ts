/**
 * From rows to a chart: which column goes where, which series exist, how they are split
 * into panels, and what color and stroke each one wears. Pure data; Chart.tsx draws it.
 *
 * The encoding rules:
 *  - With several files, color means "which file": each file keeps its own color in
 *    every chart. Measures then get a panel each (small multiples), or, overlaid in one
 *    plot, a stroke pattern each.
 *  - With one file, color means "which series", assigned in a fixed order.
 *  - There is one Y axis per plot, never two. Measures on different scales get panels.
 */
import { DASH_PATTERNS, SERIES_COUNT, seriesColor } from '../data/colors';
import type { Row } from '../data/query';
import type { ChartConfig, ChartType } from '../data/types';
import { type ColumnInfo, describeColumns, toTime } from './columns';

export interface FileRows {
  id: string;
  label: string;
  /** Palette slot of the file. */
  color: number;
  rows: Row[];
}

export type XKind = 'number' | 'time' | 'category';

export interface Point {
  /** A number, a time in milliseconds, or the index of a category. */
  x: number;
  y: number;
}

export interface Series {
  key: string;
  /** Name within its panel, for tooltips and end labels. */
  label: string;
  color: string;
  dash: string;
  points: Point[];
  /** Legend entries that control this series; it shows only while all are on. */
  legend: string[];
}

export interface Panel {
  key: string;
  /** Empty when there is a single plot. */
  title: string;
  series: Series[];
}

export interface LegendEntry {
  key: string;
  label: string;
  /** A color, or null for an entry that stands for a stroke pattern. */
  color: string | null;
  dash: string;
}

export interface ChartModel {
  type: ChartType;
  xKind: XKind;
  /** Labels of the categories, when X is categorical. */
  categories: string[];
  panels: Panel[];
  /** Groups of legend entries: files, then measures when both vary within a plot. */
  legend: LegendEntry[][];
  /** The columns in use, after defaults were applied. */
  x: string | null;
  y: string[];
  splitBy: string | null;
  /** Things the reader should know: columns left out, series capped… */
  notes: string[];
  /** Why there is nothing to draw, when there is nothing to draw. */
  empty: string | null;
}

/** Numeric columns plotted when none are chosen. */
const AUTO_Y_LIMIT = 6;
const MAX_PANELS = 24;
/** Color × stroke pattern combinations available within one plot. */
const MAX_OVERLAID = SERIES_COUNT * DASH_PATTERNS.length;

function categoryLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function resolveXKind(config: ChartConfig, x: ColumnInfo): XKind {
  // Bars sit side by side in slots, whatever the X values are.
  if (config.type === 'bar') return 'category';
  if (config.xScale !== 'auto') return config.xScale;
  return x.type === 'number' ? 'number' : x.type === 'date' ? 'time' : 'category';
}

/** The columns a chart would use for these rows, with defaults applied. */
export function resolveColumns(columns: ColumnInfo[], config: ChartConfig): { x: ColumnInfo | null; y: ColumnInfo[]; splitBy: ColumnInfo | null; skipped: number } {
  const plottable = columns.filter((column) => column.type !== 'other' && column.type !== 'empty');
  const x = columns.find((column) => column.name === config.x) ?? plottable[0] ?? null;
  const splitBy = columns.find((column) => column.name === config.splitBy && column !== x) ?? null;
  const chosen = (config.y ?? []).map((name) => columns.find((column) => column.name === name)).filter((column): column is ColumnInfo => !!column && column !== x && column !== splitBy);
  if (chosen.length > 0) return { x, y: chosen, splitBy, skipped: 0 };
  const numeric = columns.filter((column) => column.type === 'number' && column !== x && column !== splitBy);
  return { x, y: numeric.slice(0, AUTO_Y_LIMIT), splitBy, skipped: Math.max(0, numeric.length - AUTO_Y_LIMIT) };
}

function nothing(config: ChartConfig, empty: string): ChartModel {
  return { type: config.type, xKind: 'category', categories: [], panels: [], legend: [], x: null, y: [], splitBy: null, notes: [], empty };
}

export function buildChart(files: readonly FileRows[], config: ChartConfig): ChartModel {
  const columns = describeColumns(files.map((file) => file.rows));
  if (columns.length === 0) return nothing(config, 'The query returned no rows.');
  const { x, y, splitBy, skipped } = resolveColumns(columns, config);
  if (!x) return nothing(config, 'None of the columns can be plotted. Pick columns holding numbers or text.');
  if (y.length === 0) return nothing(config, 'There is no numeric column to plot against the X axis. Add one with “pick columns”, or show this as a table.');

  const notes: string[] = [];
  if (skipped > 0) notes.push(`Plotting ${y.length} of ${y.length + skipped} numeric columns. Choose others under Y.`);

  const xKind = resolveXKind(config, x);
  const categoryIndex = new Map<string, number>();
  const categoryValues: unknown[] = [];

  // One draft series per file × measure, where a measure is a Y column, or a Y column
  // for one value of the split column.
  const drafts = new Map<string, Point[]>();
  const groups: string[] = [];
  const groupSeen = new Set<string>();
  const seriesId = (file: number, column: number, group: string | null) => `${file}\u0000${column}\u0000${group ?? ''}`;

  files.forEach((file, fileIndex) => {
    for (const row of file.rows) {
      const raw = row[x.name];
      let xValue: number;
      if (xKind === 'category') {
        const label = categoryLabel(raw);
        if (label === null) continue;
        let index = categoryIndex.get(label);
        if (index === undefined) {
          index = categoryIndex.size;
          categoryIndex.set(label, index);
          categoryValues.push(raw);
        }
        xValue = index;
      } else {
        xValue = xKind === 'time' ? toTime(raw) : numberOf(raw);
        if (!Number.isFinite(xValue)) continue;
      }

      let group: string | null = null;
      if (splitBy) {
        group = categoryLabel(row[splitBy.name]);
        if (group === null) continue;
        if (!groupSeen.has(group)) {
          groupSeen.add(group);
          groups.push(group);
        }
      }

      for (let column = 0; column < y.length; column++) {
        const value = row[y[column]!.name];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const id = seriesId(fileIndex, column, group);
        let points = drafts.get(id);
        if (!points) drafts.set(id, (points = []));
        points.push({ x: xValue, y: value });
      }
    }
  });
  if (drafts.size === 0) return nothing(config, 'No row has both an X value and a number to plot.');

  // Categories that are really numbers or dates read better in order.
  let categories = Array.from(categoryIndex.keys());
  if (xKind === 'category' && (x.type === 'number' || x.type === 'date')) {
    const sortKey = (index: number) => (x.type === 'date' ? toTime(categoryValues[index]) : numberOf(categoryValues[index]));
    const order = categories.map((_, index) => index).sort((a, b) => sortKey(a) - sortKey(b));
    const position = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    categories = order.map((index) => categories[index]!);
    for (const points of drafts.values()) for (const point of points) point.x = position.get(point.x)!;
  }
  if (config.type !== 'scatter') for (const points of drafts.values()) points.sort((a, b) => a.x - b.x);

  // Measures, in a stable order: by Y column, then by split value as first seen.
  interface Measure {
    label: string;
    column: number;
    group: string | null;
  }
  let measures: Measure[] = [];
  for (let column = 0; column < y.length; column++) {
    for (const group of splitBy ? groups : [null]) {
      if (!files.some((_, fileIndex) => drafts.has(seriesId(fileIndex, column, group)))) continue;
      const label = group === null ? y[column]!.name : y.length > 1 ? `${y[column]!.name} · ${group}` : group;
      measures.push({ label, column, group });
    }
  }

  const multiFile = files.length > 1;
  let layout = config.layout === 'auto' ? (multiFile && measures.length > 1 ? 'panels' : 'overlay') : config.layout;
  if (layout === 'overlay' && multiFile && measures.length > DASH_PATTERNS.length) {
    layout = 'panels';
    notes.push(`${measures.length} measures across ${files.length} files are too many to tell apart in one plot, so each has its own.`);
  }
  const limit = layout === 'panels' ? MAX_PANELS : multiFile ? DASH_PATTERNS.length : MAX_OVERLAID;
  if (measures.length > limit) {
    notes.push(`Showing the first ${limit} of ${measures.length} series. Filter the rows, or split fewer ways, to see the rest.`);
    measures = measures.slice(0, limit);
  }

  // Files sharing a palette slot (more than eight files, or colors picked by hand) are
  // told apart by stroke pattern where that channel is free.
  const fileDash = files.map((file, index) => DASH_PATTERNS[files.slice(0, index).filter((other) => other.color === file.color).length % DASH_PATTERNS.length]!);

  const fileEntry = (index: number) => `file:${files[index]!.id}`;
  const measureEntry = (index: number) => `measure:${index}`;
  const legend: LegendEntry[][] = [];
  const dashByMeasure = layout === 'overlay' && multiFile && measures.length > 1;
  if (multiFile) {
    legend.push(files.map((file, index) => ({ key: fileEntry(index), label: file.label, color: seriesColor(file.color), dash: dashByMeasure ? '' : fileDash[index]! })));
    if (dashByMeasure) legend.push(measures.map((measure, index) => ({ key: measureEntry(index), label: measure.label, color: null, dash: DASH_PATTERNS[index]! })));
  } else if (layout === 'overlay' && measures.length > 1) {
    legend.push(
      measures.map((measure, index) => ({
        key: measureEntry(index),
        label: measure.label,
        color: seriesColor(index % SERIES_COUNT),
        dash: DASH_PATTERNS[Math.floor(index / SERIES_COUNT)]!,
      })),
    );
  }

  const panels: Panel[] = [];
  const seriesFor = (measure: Measure, measureIndex: number): Series[] => {
    const out: Series[] = [];
    files.forEach((file, fileIndex) => {
      const points = drafts.get(seriesId(fileIndex, measure.column, measure.group));
      if (!points) return;
      const key = `${fileEntry(fileIndex)}|${measureEntry(measureIndex)}`;
      if (multiFile) {
        out.push({
          key,
          label: dashByMeasure ? `${measure.label} · ${file.label}` : file.label,
          color: seriesColor(file.color),
          dash: dashByMeasure ? DASH_PATTERNS[measureIndex]! : fileDash[fileIndex]!,
          points,
          legend: dashByMeasure ? [fileEntry(fileIndex), measureEntry(measureIndex)] : [fileEntry(fileIndex)],
        });
      } else if (layout === 'overlay' && measures.length > 1) {
        out.push({
          key,
          label: measure.label,
          color: seriesColor(measureIndex % SERIES_COUNT),
          dash: DASH_PATTERNS[Math.floor(measureIndex / SERIES_COUNT)]!,
          points,
          legend: [measureEntry(measureIndex)],
        });
      } else {
        // The only series of its plot: it wears its file's color.
        out.push({ key, label: measure.label, color: seriesColor(file.color), dash: '', points, legend: [] });
      }
    });
    return out;
  };

  if (layout === 'panels') {
    measures.forEach((measure, index) => panels.push({ key: measureEntry(index), title: measure.label, series: seriesFor(measure, index) }));
  } else {
    panels.push({ key: 'all', title: '', series: measures.flatMap(seriesFor) });
  }

  return { type: config.type, xKind, categories, panels, legend, x: x.name, y: y.map((column) => column.name), splitBy: splitBy?.name ?? null, notes, empty: null };
}
