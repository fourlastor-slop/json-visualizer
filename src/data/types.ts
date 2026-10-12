/** What the app stores. Everything lives in the browser's IndexedDB. */
import type { SourceFormat } from './parse';
import type { SchemaNode } from './schema';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** A data file's metadata. Its contents are stored separately, as chunks. */
export interface DataFile {
  id: string;
  projectId: string;
  name: string;
  /** Palette slot (0–7) this file is drawn in, in every chart. */
  color: number;
  /** Bytes of source text. */
  size: number;
  records: number;
  /** Number of stored chunks: the original upload plus one per append. */
  chunks: number;
  /** Bumped whenever the contents change, so cached results can be told stale. */
  rev: number;
  /** Shape of one record, merged over all records. */
  schema: SchemaNode;
  createdAt: number;
  updatedAt: number;
}

/** A piece of a file's contents: one upload, kept as it was uploaded. */
export interface FileChunk {
  fileId: string;
  seq: number;
  format: SourceFormat;
  text: string;
}

export type VizKind = 'chart' | 'table';
export type ChartType = 'line' | 'area' | 'bar' | 'scatter';

export interface ChartConfig {
  type: ChartType;
  /** Column on the X axis; null picks the first column. */
  x: string | null;
  /** Columns plotted on the Y axis; null picks the numeric ones. */
  y: string[] | null;
  /** Column whose distinct values split the rows into separate series. */
  splitBy: string | null;
  /** One plot with every series, or one small plot per measure. */
  layout: 'auto' | 'overlay' | 'panels';
  xScale: 'auto' | 'number' | 'time' | 'category';
  /** Start the Y axis at zero even when the data does not reach it. */
  zeroBased: boolean;
}

export interface TableConfig {
  /** Files one under the other, or side by side matched on a key column. */
  layout: 'stacked' | 'compare';
  /** Key column for the side-by-side layout; null picks the first column. */
  key: string | null;
}

export const DEFAULT_CHART: ChartConfig = { type: 'line', x: null, y: null, splitBy: null, layout: 'auto', xScale: 'auto', zeroBased: false };
export const DEFAULT_TABLE: TableConfig = { layout: 'stacked', key: null };

/** The reusable part of a visualization: its query and how the result is shown. */
export interface VizDefinition {
  name: string;
  kind: VizKind;
  /** The Blockly blocks, as saved by Blockly. */
  workspace: unknown;
  /** The JSONata query the blocks generate. */
  query: string;
  /** File fields the query reads, as display paths. */
  fields: string[];
  chart: ChartConfig;
  table: TableConfig;
}

export interface Visualization extends VizDefinition {
  id: string;
  projectId: string;
  /** Files the query runs on; each is drawn in its own color. */
  fileIds: string[];
  /** The template kept in sync with this visualization, if it is marked as one. */
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A query saved for reuse on other files. Outlives the visualization it came from. */
export interface Template extends VizDefinition {
  id: string;
  createdAt: number;
  updatedAt: number;
}
