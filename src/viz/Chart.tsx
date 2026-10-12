/** A chart: a legend over one or more plots that share an X axis, a crosshair and a zoom. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChartPanel, type Hover, LineKey } from './ChartPanel';
import { xExtent } from './chartGeometry';
import type { ChartModel, LegendEntry } from './chartModel';

interface Props {
  model: ChartModel;
  /** Height available for the plots. Many panels may take more, and scroll. */
  height: number;
  zeroBased: boolean;
}

const MIN_PANEL_WIDTH = 240;
const MIN_PANEL_HEIGHT = 150;
const PANEL_GAP = 12;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function LegendItem({ entry, type, hidden, onToggle, onIsolate }: { entry: LegendEntry; type: ChartModel['type']; hidden: boolean; onToggle(): void; onIsolate(): void }) {
  // The key mirrors the mark: a stroke for lines, a block for bars and areas, a dot for points.
  const swatch =
    entry.color === null || type === 'line' ? (
      <LineKey color={entry.color} dash={entry.dash} />
    ) : (
      <span className={type === 'scatter' ? 'chart-swatch is-dot' : 'chart-swatch'} style={{ background: entry.color }} aria-hidden="true" />
    );
  return (
    <button type="button" className={hidden ? 'chart-legend-item is-hidden' : 'chart-legend-item'} aria-pressed={!hidden} onClick={onToggle} onDoubleClick={onIsolate} title="Click to hide or show. Double-click to show only this one.">
      {swatch}
      <span>{entry.label}</span>
    </button>
  );
}

export function Chart({ model, height, zeroBased }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<Hover | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  // A different chart: its legend entries and X range mean something else.
  const identity = `${model.type}|${model.xKind}|${model.x}|${model.y.join()}|${model.splitBy}|${model.legend.map((group) => group.map((entry) => entry.key).join()).join('/')}`;
  useEffect(() => {
    setHidden(new Set());
    setZoom(null);
    setHover(null);
  }, [identity]);

  // Hiding a series never recolors the others: colors were assigned before this filter.
  const panels = useMemo(
    () => model.panels.map((panel) => ({ ...panel, series: panel.series.filter((series) => series.legend.every((key) => !hidden.has(key))) })).filter((panel) => panel.series.length > 0),
    [model.panels, hidden],
  );

  const fullDomain = useMemo<[number, number]>(() => {
    if (model.xKind === 'category') return [0, Math.max(0, model.categories.length - 1)];
    return xExtent(panels.flatMap((panel) => panel.series)) ?? [0, 1];
  }, [model.xKind, model.categories.length, panels]);
  const xDomain = zoom ?? fullDomain;

  const xValues = useMemo(() => {
    const values = new Set<number>();
    for (const panel of panels) for (const series of panel.series) for (const point of series.points) values.add(point.x);
    return Float64Array.from(values).sort();
  }, [panels]);

  const zoomable = model.xKind !== 'category' && model.type !== 'scatter';
  const columns = panels.length <= 1 ? 1 : Math.max(1, Math.min(panels.length, Math.floor((width + PANEL_GAP) / (MIN_PANEL_WIDTH + PANEL_GAP)), Math.round(Math.sqrt((panels.length * width) / (height * 1.8)))));
  const rows = Math.ceil(panels.length / columns);
  const panelWidth = Math.floor((width - PANEL_GAP * (columns - 1)) / columns);
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor((height - PANEL_GAP * (rows - 1)) / rows));

  const toggle = (key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const isolate = (group: LegendEntry[], key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      for (const entry of group) {
        if (entry.key === key) next.delete(entry.key);
        else next.add(entry.key);
      }
      return next;
    });

  return (
    <div className="chart" ref={ref}>
      {(model.legend.length > 0 || zoom) && (
        <div className="chart-legend">
          {model.legend.map((group, i) => (
            <div key={i} className="chart-legend-group">
              {group.map((entry) => (
                <LegendItem key={entry.key} entry={entry} type={model.type} hidden={hidden.has(entry.key)} onToggle={() => toggle(entry.key)} onIsolate={() => isolate(group, entry.key)} />
              ))}
            </div>
          ))}
          {zoom && (
            <button type="button" className="chart-reset" onClick={() => setZoom(null)}>
              Reset zoom
            </button>
          )}
        </div>
      )}
      {width > 0 && panels.length === 0 && <div className="chart-empty">Every series is hidden. Click a legend entry to show it again.</div>}
      {width > 0 && panels.length > 0 && (
        <div className="chart-panels" style={{ gridTemplateColumns: `repeat(${columns}, ${panelWidth}px)`, gap: PANEL_GAP }}>
          {panels.map((panel, index) => (
            <ChartPanel
              key={panel.key}
              model={model}
              panel={panel}
              index={index}
              width={panelWidth}
              height={panelHeight}
              xDomain={xDomain}
              xValues={xValues}
              hover={hover}
              onHover={setHover}
              onZoom={zoomable ? setZoom : null}
              zeroBased={zeroBased}
              xLabel={model.x ?? 'x'}
            />
          ))}
        </div>
      )}
      {model.notes.map((note) => (
        <p key={note} className="chart-note">
          {note}
        </p>
      ))}
    </div>
  );
}
