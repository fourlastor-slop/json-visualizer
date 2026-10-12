/** A chart: a legend over one or more plots that share an X axis, a crosshair and a zoom. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChartPanel, type Hover, LineKey } from './ChartPanel';
import { xExtent } from './chartGeometry';
import type { ChartModel, LegendEntry } from './chartModel';

interface Props {
  model: ChartModel;
  /**
   * Height for the plots, or 'fill' to use whatever the container leaves once the legend
   * has taken its share. Many panels may need more than that, and scroll.
   */
  height: number | 'fill';
  zeroBased: boolean;
}

const MIN_PANEL_WIDTH = 240;
const MIN_PANEL_HEIGHT = 150;
const PANEL_GAP = 12;

/**
 * The inner size of an element, kept current. The height is tracked only on request: where
 * it follows the content instead of the container, tracking it would re-render for nothing.
 */
function useSize<T extends HTMLElement>(trackHeight: boolean): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: trackHeight ? element.clientHeight : 0 };
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [trackHeight]);
  return [ref, size];
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
  const fill = height === 'fill';
  const [body, size] = useSize<HTMLDivElement>(fill);
  const width = size.width;
  const available = fill ? size.height : height;
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
  const ready = width > 0 && available > 0;
  const columns = panels.length <= 1 ? 1 : Math.max(1, Math.min(panels.length, Math.floor((width + PANEL_GAP) / (MIN_PANEL_WIDTH + PANEL_GAP)), Math.round(Math.sqrt((panels.length * width) / (available * 1.8)))));
  const rows = Math.ceil(panels.length / columns);
  const panelWidth = Math.floor((width - PANEL_GAP * (columns - 1)) / columns);
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor((available - PANEL_GAP * (rows - 1)) / rows));
  // When filling a container, the plots scroll inside it only if they cannot all be given
  // their minimum height. Deciding that here, rather than leaving it to `overflow: auto`,
  // keeps tooltips that reach past a plot's edge from summoning scrollbars.
  const scrolls = fill && rows * MIN_PANEL_HEIGHT + PANEL_GAP * (rows - 1) > available;

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
    <div className={fill ? 'chart is-fill' : 'chart'}>
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
      <div className={scrolls ? 'chart-body is-scrolling' : 'chart-body'} ref={body}>
        {ready && panels.length === 0 && <div className="chart-empty">Every series is hidden. Click a legend entry to show it again.</div>}
        {ready && panels.length > 0 && (
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
      </div>
      {model.notes.map((note) => (
        <p key={note} className="chart-note">
          {note}
        </p>
      ))}
    </div>
  );
}
