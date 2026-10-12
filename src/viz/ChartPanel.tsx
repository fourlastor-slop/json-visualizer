/** One plot: axes, marks, and the hover layer. A chart is one or more of these. */
import { type KeyboardEvent, type PointerEvent, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatNumber } from '../lib/format';
import { AXIS_FONT, textWidth, truncate } from '../lib/measure';
import { type Pixel, areaPath, barPath, buildXAxis, buildYAxis, formatX, linePath, linePixels, nearestIndex, pointsInView } from './chartGeometry';
import type { ChartModel, Panel, Series } from './chartModel';

export interface Hover {
  panel: number;
  /** The X value under the pointer, snapped to the data. */
  x: number;
  px: number;
  py: number;
  /** Scatter only: the series and Y value of the point under the pointer. */
  point?: { series: string; y: number };
}

interface Props {
  model: ChartModel;
  panel: Panel;
  index: number;
  width: number;
  height: number;
  /** X domain shared by every panel of the chart. */
  xDomain: [number, number];
  /** Every X value with data, ascending: what the crosshair snaps to. */
  xValues: Float64Array;
  hover: Hover | null;
  onHover(hover: Hover | null): void;
  /** Called with a new X domain when the reader drags across the plot, or null to reset. */
  onZoom: ((domain: [number, number] | null) => void) | null;
  zeroBased: boolean;
  /** Name of the X column, for scatter tooltips. */
  xLabel: string;
}

const TOP = 10;
const AXIS_BAND = 24;
const MAX_BAR = 24;
const BAR_GAP = 2;
const END_LABEL_LIMIT = 4;
/** Distance kept between the crosshair and the tooltip beside it. */
const TOOLTIP_GAP = 14;

/** A short stroke in a series' color and pattern: the key used in tooltips and legends. */
export function LineKey({ color, dash }: { color: string | null; dash: string }) {
  return (
    <svg className="chart-key" width="18" height="8" viewBox="0 0 18 8" aria-hidden="true">
      <line x1="1" x2="17" y1="4" y2="4" stroke={color ?? 'var(--text-2)'} strokeWidth="2" strokeLinecap="round" strokeDasharray={dash || undefined} />
    </svg>
  );
}

export function ChartPanel({ model, panel, index, width, height, xDomain, xValues, hover, onHover, onZoom, zeroBased, xLabel }: Props) {
  const clipId = useId();
  const tooltip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragStart = useRef<number | null>(null);

  const { type } = model;
  const isBar = type === 'bar';
  const isScatter = type === 'scatter';
  const plotHeight = Math.max(40, height - TOP - AXIS_BAND - (panel.title ? 20 : 0));

  // Direct labels at the line ends, for a handful of series in a single plot. The legend
  // stays; these save the eye a trip to it.
  const wantsEndLabels = (type === 'line' || type === 'area') && model.panels.length === 1 && panel.series.length >= 2 && panel.series.length <= END_LABEL_LIMIT;
  const endLabelWidth = wantsEndLabels ? Math.min(150, Math.max(...panel.series.map((series) => textWidth(truncate(series.label, 24))))) + 14 : 0;

  const y = useMemo(
    () => buildYAxis(panel.series, model.xKind === 'category' ? null : xDomain, zeroBased || isBar || type === 'area', plotHeight),
    [panel.series, model.xKind, xDomain, zeroBased, isBar, type, plotHeight],
  );
  const left = Math.ceil(Math.max(...y.ticks.map((tick) => textWidth(tick.label, AXIS_FONT)), 12)) + 10;
  const right = Math.max(10, endLabelWidth);
  const plotWidth = Math.max(40, width - left - right);
  const x = useMemo(() => buildXAxis(model, xDomain, plotWidth), [model, xDomain, plotWidth]);

  /** Y by X, per series: what the tooltip reads. */
  const lookup = useMemo(() => new Map(panel.series.map((series) => [series.key, new Map(series.points.map((point) => [point.x, point.y]))])), [panel.series]);

  const drawn = useMemo(
    () =>
      panel.series.map((series) => {
        const points = isScatter || model.xKind === 'category' ? series.points : pointsInView(series.points, xDomain);
        return { series, points, pixels: isBar || isScatter ? [] : linePixels(points, x, y, plotWidth) };
      }),
    [panel.series, isBar, isScatter, model.xKind, xDomain, x, y, plotWidth],
  );

  const baseline = y.toPx(Math.min(Math.max(0, y.domain[0]), y.domain[1]));
  const densest = Math.max(1, ...drawn.map((entry) => entry.points.length));
  const showMarkers = !isBar && !isScatter && densest <= 80 && plotWidth / densest >= 9;

  // ── Hover ────────────────────────────────────────────────────────────────
  const active = hover !== null && (isScatter ? hover.panel === index : true) ? hover : null;
  const activePx = active ? x.toPx(active.x) : 0;
  const inView = active !== null && activePx >= -1 && activePx <= plotWidth + 1;

  const readout: Array<{ series: Series; value: number }> = [];
  if (active && inView) {
    if (isScatter) {
      const series = panel.series.find((s) => s.key === active.point?.series);
      if (series && active.point) readout.push({ series, value: active.point.y });
    } else {
      for (const series of panel.series) {
        const value = lookup.get(series.key)?.get(active.x);
        if (value !== undefined) readout.push({ series, value });
      }
    }
  }

  const hoverAt = (px: number, py: number): Hover | null => {
    if (isScatter) {
      let best: Hover | null = null;
      let bestDistance = 30 * 30;
      for (const { series, points } of drawn) {
        for (const point of points) {
          const dx = x.toPx(point.x) - px;
          const dy = y.toPx(point.y) - py;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { panel: index, x: point.x, px: x.toPx(point.x), py: y.toPx(point.y), point: { series: series.key, y: point.y } };
          }
        }
      }
      return best;
    }
    const target = model.xKind === 'category' ? x.fromPx(px) : xValues[nearestIndex(xValues, x.fromPx(px))];
    return target === undefined ? null : { panel: index, x: target, px: x.toPx(target), py };
  };

  const local = (event: PointerEvent<SVGRectElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const [px, py] = local(event);
    if (dragStart.current !== null) {
      setDrag({ from: dragStart.current, to: Math.min(plotWidth, Math.max(0, px)) });
      onHover(null);
      return;
    }
    onHover(hoverAt(px, py));
  };

  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    if (!onZoom || event.button !== 0) return;
    dragStart.current = local(event)[0];
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerUp = () => {
    const selection = drag;
    dragStart.current = null;
    setDrag(null);
    if (!selection || !onZoom || Math.abs(selection.to - selection.from) < 6) return;
    const [a, b] = [x.fromPx(Math.min(selection.from, selection.to)), x.fromPx(Math.max(selection.from, selection.to))];
    if (b > a) onZoom([a, b]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onHover(null);
      return;
    }
    if (isScatter || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    let next: number | undefined;
    if (model.xKind === 'category') {
      const count = model.categories.length;
      next = hover ? Math.min(count - 1, Math.max(0, hover.x + step)) : step > 0 ? 0 : count - 1;
    } else {
      // Step through the values in view.
      let i = hover ? nearestIndex(xValues, hover.x) + step : step > 0 ? 0 : xValues.length - 1;
      while (i >= 0 && i < xValues.length && (xValues[i]! < xDomain[0] || xValues[i]! > xDomain[1])) i += step;
      next = xValues[i];
    }
    if (next !== undefined) onHover({ panel: index, x: next, px: x.toPx(next), py: plotHeight / 3 });
  };

  // ── Marks ────────────────────────────────────────────────────────────────
  const marks: ReactNode[] = [];
  if (isBar) {
    const count = panel.series.length;
    const slot = x.step * 0.8;
    const barWidth = Math.max(1, Math.min(MAX_BAR, (slot - BAR_GAP * (count - 1)) / count));
    const gap = barWidth >= 3 ? BAR_GAP : 0;
    const groupWidth = count * barWidth + (count - 1) * gap;
    drawn.forEach(({ series, points }, seriesIndex) => {
      let d = '';
      for (const point of points) d += barPath(x.toPx(point.x) - groupWidth / 2 + seriesIndex * (barWidth + gap), barWidth, baseline, y.toPx(point.y));
      marks.push(<path key={series.key} d={d} fill={series.color} />);
    });
  } else if (isScatter) {
    const dense = drawn.reduce((total, entry) => total + entry.points.length, 0) > 400;
    for (const { series, points } of drawn) {
      marks.push(
        <g key={series.key} fill={series.color} stroke="var(--chart-surface)" strokeWidth={dense ? 0.75 : 2} fillOpacity={dense ? 0.75 : 1}>
          {points.map((point, i) => (
            <circle key={i} cx={x.toPx(point.x)} cy={y.toPx(point.y)} r={dense ? 3 : 4} />
          ))}
        </g>,
      );
    }
  } else {
    for (const { series, pixels } of drawn) {
      if (type === 'area') marks.push(<path key={`${series.key}:area`} d={areaPath(pixels, baseline)} fill={series.color} fillOpacity={0.1} />);
      marks.push(
        <path
          key={series.key}
          d={linePath(pixels)}
          fill="none"
          stroke={series.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={series.dash || undefined}
        />,
      );
      if (showMarkers || pixels.length === 1) {
        marks.push(
          <g key={`${series.key}:dots`} fill={series.color} stroke="var(--chart-surface)" strokeWidth={2}>
            {pixels.map((pixel, i) => (
              <circle key={i} cx={pixel.px} cy={pixel.py} r={4} />
            ))}
          </g>,
        );
      }
    }
  }

  // End labels: dropped altogether when any two would collide, rather than nudged apart.
  let endLabels: Array<{ series: Series; at: Pixel }> = [];
  if (wantsEndLabels) {
    endLabels = drawn.filter((entry) => entry.pixels.length > 0).map((entry) => ({ series: entry.series, at: entry.pixels[entry.pixels.length - 1]! }));
    const heights = endLabels.map((label) => label.at.py).sort((a, b) => a - b);
    if (heights.some((py, i) => i > 0 && py - heights[i - 1]! < 14)) endLabels = [];
  }

  // The tooltip is placed once it has been measured, and before it is painted: beside the
  // crosshair, on the side that has room. It may reach over a neighboring plot, but never
  // past the edge of the chart: one that stuck out would push whatever contains the chart
  // into scrolling.
  useLayoutEffect(() => {
    const element = tooltip.current;
    const frame = element?.parentElement?.getBoundingClientRect();
    if (!element || !frame || !active) return;
    const chart = element.closest('.chart-body')?.getBoundingClientRect() ?? frame;
    const [min, max] = [chart.left - frame.left, chart.right - frame.left - element.offsetWidth];
    const anchor = left + activePx;
    let x = anchor + TOOLTIP_GAP;
    if (x > max) x = anchor - TOOLTIP_GAP - element.offsetWidth;
    element.style.left = `${Math.max(min, Math.min(x, max))}px`;
    element.style.top = `${Math.max(0, Math.min(TOP + active.py - 16, TOP + plotHeight + AXIS_BAND - element.offsetHeight))}px`;
  });

  return (
    <div className="chart-panel" style={{ width }}>
      {panel.title && (
        <div className="chart-panel-title" style={{ paddingLeft: left }} title={panel.title}>
          {panel.title}
        </div>
      )}
      <div
        className="chart-plot"
        tabIndex={0}
        role="img"
        aria-label={`${panel.title || 'Chart'}: ${panel.series.map((series) => series.label).join(', ')}. Use the arrow keys to read values.`}
        onKeyDown={onKeyDown}
        onBlur={() => onHover(null)}
      >
        <svg width={width} height={TOP + plotHeight + AXIS_BAND} role="presentation">
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={-6} width={plotWidth} height={plotHeight + 12} />
            </clipPath>
          </defs>
          <g transform={`translate(${left},${TOP})`}>
            {y.ticks.map((tick) => (
              <g key={tick.at} transform={`translate(0,${y.toPx(tick.at)})`}>
                <line x2={plotWidth} className="chart-grid" />
                <text x={-8} dy="0.32em" textAnchor="end" className="chart-tick">
                  {tick.label}
                </text>
              </g>
            ))}
            {isBar && active && inView && <rect className="chart-band" x={activePx - x.step / 2} width={x.step} height={plotHeight} />}
            <line x2={plotWidth} y1={baseline} y2={baseline} className="chart-axis" />
            {x.ticks
              .filter((tick) => x.toPx(tick.at) >= 0 && x.toPx(tick.at) <= plotWidth)
              .map((tick) => (
                <text key={tick.at} x={x.toPx(tick.at)} y={plotHeight + 16} textAnchor="middle" className="chart-tick">
                  {tick.label}
                </text>
              ))}
            {!isBar && !isScatter && active && inView && <line className="chart-crosshair" x1={activePx} x2={activePx} y2={plotHeight} />}
            <g clipPath={`url(#${clipId})`}>{marks}</g>
            {!isBar &&
              active &&
              inView &&
              readout.map(({ series, value }) => (
                <circle key={series.key} cx={activePx} cy={y.toPx(value)} r={5} fill={series.color} stroke="var(--chart-surface)" strokeWidth={2} />
              ))}
            {endLabels.map(({ series, at }) => (
              <text key={series.key} x={at.px + 9} y={at.py} dy="0.32em" className="chart-end-label">
                {truncate(series.label, 24)}
              </text>
            ))}
            {drag && <rect className="chart-selection" x={Math.min(drag.from, drag.to)} width={Math.abs(drag.to - drag.from)} height={plotHeight} />}
            <rect
              className={onZoom ? 'chart-hit is-zoomable' : 'chart-hit'}
              width={plotWidth}
              height={plotHeight}
              onPointerMove={onPointerMove}
              onPointerLeave={() => dragStart.current === null && onHover(null)}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={() => onZoom?.(null)}
            />
          </g>
        </svg>
        {hover?.panel === index && inView && readout.length > 0 && (
          <div ref={tooltip} className="chart-tooltip" role="status">
            <div className="chart-tooltip-x">{isScatter ? readout[0]!.series.label : formatX(model, hover.x)}</div>
            {isScatter ? (
              <>
                <div className="chart-tooltip-row">
                  <span className="chart-tooltip-label">{xLabel}</span>
                  <span className="chart-tooltip-value">{formatX(model, hover.x)}</span>
                </div>
                <div className="chart-tooltip-row">
                  <LineKey color={readout[0]!.series.color} dash="" />
                  <span className="chart-tooltip-label">{panel.title || model.y[0]}</span>
                  <span className="chart-tooltip-value">{formatNumber(readout[0]!.value)}</span>
                </div>
              </>
            ) : (
              readout.map(({ series, value }) => (
                <div key={series.key} className="chart-tooltip-row">
                  <LineKey color={series.color} dash={series.dash} />
                  <span className="chart-tooltip-label">{series.label}</span>
                  <span className="chart-tooltip-value">{formatNumber(value)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
