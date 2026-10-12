/** Scales, ticks and paths for the charts. Pure functions from data to pixels. */
import { scaleLinear, scaleTime } from 'd3-scale';
import { formatNumber } from '../lib/format';
import { truncate } from '../lib/measure';
import type { ChartModel, Point, Series, XKind } from './chartModel';

/** Space kept free at both ends of a continuous X axis, so end markers are not cut off. */
const INSET = 7;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Tick {
  at: number;
  label: string;
}

export interface XAxis {
  toPx(x: number): number;
  fromPx(px: number): number;
  ticks: Tick[];
  /** Width of one category slot; 0 for continuous axes. */
  step: number;
}

export interface YAxis {
  toPx(y: number): number;
  ticks: Tick[];
  domain: [number, number];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Extent of the X values of some series: [min, max], or null when there are no points. */
export function xExtent(series: readonly Series[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const point of s.points) {
      if (point.x < min) min = point.x;
      if (point.x > max) max = point.x;
    }
  }
  return min <= max ? [min, max] : null;
}

/** A domain with some width even when all values coincide. */
function widen(domain: [number, number], kind: XKind): [number, number] {
  if (domain[0] < domain[1]) return domain;
  const pad = kind === 'time' ? HOUR : Math.abs(domain[0]) * 0.01 || 1;
  return [domain[0] - pad, domain[1] + pad];
}

export function buildXAxis(model: ChartModel, domain: [number, number], width: number): XAxis {
  if (model.xKind === 'category') {
    const count = Math.max(1, model.categories.length);
    const step = width / count;
    // Label every category when they fit, otherwise every n-th.
    const longest = Math.min(16, Math.max(1, ...model.categories.map((label) => label.length)));
    const every = Math.max(1, Math.ceil((longest * 6.2 + 14) / step));
    const ticks: Tick[] = [];
    for (let i = 0; i < model.categories.length; i += every) ticks.push({ at: i, label: truncate(model.categories[i]!, 16) });
    return { toPx: (x) => (x + 0.5) * step, fromPx: (px) => clamp(Math.floor(px / step), 0, count - 1), ticks, step };
  }

  const [min, max] = widen(domain, model.xKind);
  const count = Math.max(2, Math.floor(width / 84));
  if (model.xKind === 'time') {
    const scale = scaleTime().domain([min, max]).range([INSET, width - INSET]);
    const format = scale.tickFormat();
    return { toPx: (x) => scale(x), fromPx: (px) => scale.invert(px).getTime(), ticks: scale.ticks(count).map((date) => ({ at: date.getTime(), label: format(date) })), step: 0 };
  }

  const scale = scaleLinear().domain([min, max]).range([INSET, width - INSET]);
  const values = scale.ticks(count);
  const largest = Math.max(Math.abs(min), Math.abs(max));
  // Whole numbers on an X axis are usually identifiers (years, versions, steps): written
  // plainly, without thousands separators. Very large ones are abbreviated.
  const format = largest >= 1e5 ? scale.tickFormat(count, '~s') : values.every(Number.isInteger) ? String : scale.tickFormat(count);
  return { toPx: (x) => scale(x), fromPx: (px) => scale.invert(px), ticks: values.map((value) => ({ at: value, label: format(value) })), step: 0 };
}

/** The Y axis of a plot: fitted to the points in view, rounded out to clean numbers. */
export function buildYAxis(series: readonly Series[], xDomain: [number, number] | null, includeZero: boolean, height: number): YAxis {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const point of s.points) {
      if (xDomain && (point.x < xDomain[0] || point.x > xDomain[1])) continue;
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
  }
  if (min > max) [min, max] = [0, 1];
  if (includeZero) [min, max] = [Math.min(min, 0), Math.max(max, 0)];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    [min, max] = [min - pad, max + pad];
  }
  const count = height < 130 ? 3 : 5;
  // Rounded out at twice the tick density, so the data fills more of the plot than it
  // would if the axis had to start and end on a labelled tick.
  const scale = scaleLinear()
    .domain([min, max])
    .nice(count * 2)
    .range([height, 0]);
  const [low, high] = scale.domain() as [number, number];
  const format = Math.max(Math.abs(low), Math.abs(high)) >= 1e6 ? scale.tickFormat(count, '~s') : scale.tickFormat(count);
  return { toPx: (y) => scale(y), ticks: scale.ticks(count).map((value) => ({ at: value, label: format(value) })), domain: [low, high] };
}

const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** An X value in full, for tooltips. */
export function formatX(model: ChartModel, x: number): string {
  if (model.xKind === 'category') return model.categories[x] ?? '';
  if (model.xKind === 'time') {
    // A date with no time of day was parsed as midnight UTC: show it as that date.
    return x % DAY === 0 ? dateOnly.format(x) : dateTime.format(x);
  }
  return Number.isInteger(x) && Math.abs(x) < 1e5 ? String(x) : formatNumber(x);
}

/** Index of the value nearest to `target` in an ascending list; -1 if the list is empty. */
export function nearestIndex(sorted: ArrayLike<number>, target: number): number {
  if (sorted.length === 0) return -1;
  let low = 0;
  let high = sorted.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < target) low = middle;
    else high = middle;
  }
  return Math.abs(sorted[low]! - target) <= Math.abs(sorted[high]! - target) ? low : high;
}

/** The points of a series sorted by X that fall in a domain, plus one neighbor each side. */
export function pointsInView(points: readonly Point[], domain: [number, number]): readonly Point[] {
  if (points.length === 0 || (points[0]!.x >= domain[0] && points[points.length - 1]!.x <= domain[1])) return points;
  let start = 0;
  while (start < points.length && points[start]!.x < domain[0]) start++;
  let end = points.length;
  while (end > 0 && points[end - 1]!.x > domain[1]) end--;
  return points.slice(Math.max(0, start - 1), Math.min(points.length, end + 1));
}

export interface Pixel {
  px: number;
  py: number;
}

/**
 * Pixel positions for a line. A series with far more points than pixels is reduced to
 * the first, lowest, highest and last point of every pixel column, which draws the same
 * picture with a fraction of the path.
 */
export function linePixels(points: readonly Point[], x: XAxis, y: YAxis, width: number): Pixel[] {
  const pixels: Pixel[] = points.map((point) => ({ px: x.toPx(point.x), py: y.toPx(point.y) }));
  if (pixels.length <= width * 4) return pixels;
  const out: Pixel[] = [];
  let i = 0;
  while (i < pixels.length) {
    const column = Math.round(pixels[i]!.px);
    const first = pixels[i]!;
    let last = first;
    let lowest = first;
    let highest = first;
    for (; i < pixels.length && Math.round(pixels[i]!.px) === column; i++) {
      last = pixels[i]!;
      if (last.py > lowest.py) lowest = last;
      if (last.py < highest.py) highest = last;
    }
    out.push(first);
    if (lowest !== first && lowest !== last) out.push(lowest);
    if (highest !== first && highest !== last && highest !== lowest) out.push(highest);
    if (last !== first) out.push(last);
  }
  return out;
}

const round = (value: number) => Math.round(value * 10) / 10;

export function linePath(pixels: readonly Pixel[]): string {
  let d = '';
  for (let i = 0; i < pixels.length; i++) d += `${i === 0 ? 'M' : 'L'}${round(pixels[i]!.px)},${round(pixels[i]!.py)}`;
  return d;
}

/** The line closed down to a baseline, for the wash under an area chart. */
export function areaPath(pixels: readonly Pixel[], baseline: number): string {
  if (pixels.length === 0) return '';
  return `${linePath(pixels)}L${round(pixels[pixels.length - 1]!.px)},${round(baseline)}L${round(pixels[0]!.px)},${round(baseline)}Z`;
}

/** A bar from the baseline to a value: square at the baseline, rounded at the data end. */
export function barPath(left: number, width: number, baseline: number, end: number): string {
  const radius = Math.min(4, width / 2, Math.abs(end - baseline));
  const r = end < baseline ? radius : -radius;
  const right = left + width;
  return `M${round(left)},${round(baseline)}L${round(left)},${round(end + r)}Q${round(left)},${round(end)} ${round(left + radius)},${round(end)}L${round(right - radius)},${round(end)}Q${round(right)},${round(end)} ${round(right)},${round(end + r)}L${round(right)},${round(baseline)}Z`;
}
