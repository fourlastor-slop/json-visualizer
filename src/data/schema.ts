/**
 * Schema inference for JSON records.
 *
 * A schema is a tree describing every shape seen at a position: which JSON types occurred,
 * which keys an object had, what the elements of a list looked like. It is what makes the
 * block editor "know" the fields of the files being queried.
 */

import { formatCount, formatNumber } from '../lib/format';

export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'object' | 'array';

/** One step of a path into a record. `null` stands for "any key" (JSONata's `*`). */
export type PathSegment = string | null;
export type Path = PathSegment[];

export interface SchemaNode {
  /** How many values were observed at this position. */
  count: number;
  /** Observed JSON types and how often each occurred. */
  types: Partial<Record<JsonType, number>>;
  /** Keys seen on objects at this position. */
  fields?: Record<string, SchemaNode>;
  /** Merged shape of the elements of lists at this position. */
  items?: SchemaNode;
  /** A few distinct scalar values, for display. */
  examples?: Array<string | number | boolean>;
  min?: number;
  max?: number;
  /**
   * Tracked for numeric top-level fields only: whether values never decreased in record
   * order, and how often they strictly increased. Sequence-like fields (step, version,
   * timestamp) make good default X axes.
   */
  order?: { first: number; last: number; sorted: boolean; rises: number };
  /** Objects with more than MAX_KEYS distinct keys fold the remainder in here. */
  overflow?: SchemaNode;
  /** The shape is not known statically (derived columns, raw JSONata). */
  unknown?: true;
}

const MAX_KEYS = 1000;
const MAX_DEPTH = 40;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 60;

// `fields` is keyed by arbitrary JSON keys, so "constructor" or "__proto__" must not reach
// Object.prototype: read with hasOwn, write with defineProperty.
function getOwn(fields: Record<string, SchemaNode> | undefined, key: string): SchemaNode | undefined {
  return fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined;
}

function setOwn(fields: Record<string, SchemaNode>, key: string, node: SchemaNode): void {
  Object.defineProperty(fields, key, { value: node, enumerable: true, writable: true, configurable: true });
}

export function emptySchema(): SchemaNode {
  return { count: 0, types: {} };
}

export function unknownSchema(): SchemaNode {
  return { count: 0, types: {}, unknown: true };
}

export function scalarSchema(type: JsonType): SchemaNode {
  return { count: 1, types: { [type]: 1 } };
}

export function objectSchema(entries: Array<[string, SchemaNode]>): SchemaNode {
  const fields: Record<string, SchemaNode> = {};
  for (const [key, node] of entries) setOwn(fields, key, node);
  return { count: 1, types: { object: 1 }, fields };
}

export function listSchema(items: SchemaNode | undefined): SchemaNode {
  return { count: 1, types: { array: 1 }, items: items ?? unknownSchema() };
}

export function jsonType(value: unknown): JsonType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return 'object';
  }
}

function addExample(node: SchemaNode, value: string | number | boolean): void {
  const examples = (node.examples ??= []);
  if (examples.length >= MAX_EXAMPLES) return;
  const shown = typeof value === 'string' && value.length > MAX_EXAMPLE_LENGTH ? value.slice(0, MAX_EXAMPLE_LENGTH) + '…' : value;
  if (!examples.includes(shown)) examples.push(shown);
}

function trackOrder(node: SchemaNode, value: number): void {
  const order = node.order;
  if (!order) {
    node.order = { first: value, last: value, sorted: true, rises: 0 };
    return;
  }
  if (value < order.last) order.sorted = false;
  else if (value > order.last) order.rises++;
  order.last = value;
}

function observe(node: SchemaNode, value: unknown, depth: number): void {
  node.count++;
  const type = jsonType(value);
  node.types[type] = (node.types[type] ?? 0) + 1;

  switch (type) {
    case 'object': {
      if (depth >= MAX_DEPTH) return;
      const fields = (node.fields ??= {});
      const object = value as Record<string, unknown>;
      for (const key of Object.keys(object)) {
        let child = getOwn(fields, key);
        if (!child) {
          if (Object.keys(fields).length >= MAX_KEYS) {
            child = node.overflow ??= emptySchema();
          } else {
            child = emptySchema();
            setOwn(fields, key, child);
          }
        }
        const fieldValue = object[key];
        observe(child, fieldValue, depth + 1);
        if (depth === 0 && typeof fieldValue === 'number') trackOrder(child, fieldValue);
      }
      break;
    }
    case 'array': {
      if (depth >= MAX_DEPTH) return;
      const items = (node.items ??= emptySchema());
      for (const element of value as unknown[]) observe(items, element, depth + 1);
      break;
    }
    case 'number': {
      const n = value as number;
      if (node.min === undefined || n < node.min) node.min = n;
      if (node.max === undefined || n > node.max) node.max = n;
      addExample(node, n);
      break;
    }
    case 'string':
    case 'boolean':
      addExample(node, value as string | boolean);
      break;
    default:
      break;
  }
}

/** Infers the shape of one record from a list of records. */
export function inferSchema(records: readonly unknown[]): SchemaNode {
  const root = emptySchema();
  for (const record of records) observe(root, record, 0);
  return root;
}

function mergeAt(a: SchemaNode, b: SchemaNode, level: number, sequential: boolean): SchemaNode {
  if (a.unknown || b.unknown) return unknownSchema();

  const out: SchemaNode = { count: a.count + b.count, types: { ...a.types } };
  for (const [type, n] of Object.entries(b.types) as Array<[JsonType, number]>) {
    out.types[type] = (out.types[type] ?? 0) + n;
  }

  if (a.fields || b.fields) {
    const fields: Record<string, SchemaNode> = {};
    for (const key of Object.keys(a.fields ?? {})) {
      const left = getOwn(a.fields, key)!;
      const right = getOwn(b.fields, key);
      setOwn(fields, key, right ? mergeAt(left, right, level + 1, sequential) : left);
    }
    for (const key of Object.keys(b.fields ?? {})) {
      if (!getOwn(a.fields, key)) setOwn(fields, key, getOwn(b.fields, key)!);
    }
    out.fields = fields;
  }

  if (a.items || b.items) {
    out.items = a.items && b.items ? mergeAt(a.items, b.items, level + 1, sequential) : (a.items ?? b.items);
  }
  if (a.overflow || b.overflow) {
    out.overflow = a.overflow && b.overflow ? mergeAt(a.overflow, b.overflow, level + 1, sequential) : (a.overflow ?? b.overflow);
  }

  const examples = [...(a.examples ?? [])];
  for (const example of b.examples ?? []) {
    if (examples.length < MAX_EXAMPLES && !examples.includes(example)) examples.push(example);
  }
  if (examples.length > 0) out.examples = examples;

  if (a.min !== undefined || b.min !== undefined) out.min = Math.min(a.min ?? Infinity, b.min ?? Infinity);
  if (a.max !== undefined || b.max !== undefined) out.max = Math.max(a.max ?? -Infinity, b.max ?? -Infinity);

  if (level === 1) {
    if (a.order && b.order) {
      // Appended data continues the sequence; separate files are independent sequences.
      const joins = !sequential || b.order.first >= a.order.last;
      out.order = {
        first: a.order.first,
        last: b.order.last,
        sorted: a.order.sorted && b.order.sorted && joins,
        rises: a.order.rises + b.order.rises + (sequential && b.order.first > a.order.last ? 1 : 0),
      };
    } else {
      out.order = a.order ?? b.order;
    }
  }
  return out;
}

/**
 * Merges two record schemas without mutating either. Pass `sequential` when `b` describes
 * records appended after `a` in the same file.
 */
export function mergeSchemas(a: SchemaNode, b: SchemaNode, sequential = false): SchemaNode {
  return mergeAt(a, b, 0, sequential);
}

/** The combined shape of the records of several files; undefined for none. */
export function mergeAll(schemas: readonly SchemaNode[]): SchemaNode | undefined {
  let merged: SchemaNode | undefined;
  for (const schema of schemas) merged = merged ? mergeSchemas(merged, schema) : schema;
  return merged;
}

const valuesCache = new WeakMap<SchemaNode, SchemaNode | undefined>();

/** Merged shape of all values of an object ("any key"). */
function valuesSchema(node: SchemaNode): SchemaNode | undefined {
  if (valuesCache.has(node)) return valuesCache.get(node);
  let merged: SchemaNode | undefined;
  for (const key of Object.keys(node.fields ?? {})) {
    const child = getOwn(node.fields, key)!;
    merged = merged ? mergeAt(merged, child, 2, false) : child;
  }
  if (node.overflow) merged = merged ? mergeAt(merged, node.overflow, 2, false) : node.overflow;
  valuesCache.set(node, merged);
  return merged;
}

/**
 * Shape reached by following one path segment. Lists are transparent, exactly like in
 * JSONata, where `orders.price` maps over the `orders` list.
 */
export function childSchema(node: SchemaNode | undefined, segment: PathSegment): SchemaNode | undefined {
  if (!node) return undefined;
  if (node.unknown) return node;
  const direct = segment === null ? valuesSchema(node) : (getOwn(node.fields, segment) ?? node.overflow);
  const viaItems = node.items ? childSchema(node.items, segment) : undefined;
  if (direct && viaItems) return mergeAt(direct, viaItems, 2, false);
  return direct ?? viaItems;
}

export function resolvePath(root: SchemaNode | undefined, path: Path): SchemaNode | undefined {
  let node = root;
  for (const segment of path) {
    node = childSchema(node, segment);
    if (!node) return undefined;
  }
  return node;
}

/** Keys reachable from a node in one step, looking through lists. */
export function keysOf(node: SchemaNode | undefined): string[] {
  if (!node || node.unknown) return [];
  const keys = Object.keys(node.fields ?? {});
  if (node.items) {
    const seen = new Set(keys);
    for (const key of keysOf(node.items)) {
      if (!seen.has(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * The element shape of a list. A value that is not (always) a list stands for itself:
 * JSONata treats it as a one-element sequence, and key lookups see through lists anyway.
 */
export function itemsSchema(node: SchemaNode | undefined): SchemaNode | undefined {
  if (!node) return undefined;
  if (node.unknown || !node.items) return node;
  const onlyLists = Object.keys(node.types).every((type) => type === 'array');
  return onlyLists ? node.items : node;
}

export function hasKeys(node: SchemaNode | undefined): boolean {
  return keysOf(node).length > 0;
}

const TYPE_LABELS: Record<JsonType, string> = {
  null: 'null',
  boolean: 'boolean',
  number: 'number',
  string: 'text',
  object: 'object',
  array: 'list',
};

/** Observed types, most frequent first, ignoring nulls unless nothing else was seen. */
export function observedTypes(node: SchemaNode | undefined): JsonType[] {
  if (!node) return [];
  const entries = (Object.entries(node.types) as Array<[JsonType, number]>).filter(([, n]) => n > 0);
  const nonNull = entries.filter(([type]) => type !== 'null');
  return (nonNull.length > 0 ? nonNull : entries).sort((a, b) => b[1] - a[1]).map(([type]) => type);
}

export function typeLabel(node: SchemaNode | undefined): string {
  if (!node || node.unknown) return '';
  const types = observedTypes(node);
  if (types.length === 0) return '';
  if (types.length > 1) return 'mixed';
  return TYPE_LABELS[types[0]!];
}

/**
 * A node in a few words: its type, plus its range, an example, or its size, and how many
 * of its parent objects have it when not all do.
 */
export function describeNode(node: SchemaNode | undefined, parentObjects?: number): { type: string; detail: string } {
  if (!node || node.unknown) return { type: '', detail: '' };
  const parts: string[] = [];
  const types = observedTypes(node);
  if (types.length === 1) {
    if (types[0] === 'number' && node.min !== undefined && node.max !== undefined) {
      parts.push(node.min === node.max ? formatNumber(node.min) : `${formatNumber(node.min)} – ${formatNumber(node.max)}`);
    } else if (types[0] === 'string' && node.examples?.length) {
      parts.push(`“${node.examples[0]}”`);
    } else if (types[0] === 'object') {
      const keys = keysOf(node).length;
      parts.push(`${keys}${node.overflow ? '+' : ''} ${keys === 1 ? 'key' : 'keys'}`);
    } else if (types[0] === 'array' && node.items) {
      const inner = typeLabel(node.items);
      if (inner) parts.push(`of ${inner}s`);
    }
  }
  if (parentObjects !== undefined && node.count < parentObjects) parts.push(`in ${formatCount(node.count)} of ${formatCount(parentObjects)}`);
  return { type: typeLabel(node), detail: parts.join(' · ') };
}

export function isNumeric(node: SchemaNode | undefined): boolean {
  const types = observedTypes(node);
  return types.length === 1 && types[0] === 'number';
}

/** True for numeric fields that mostly increase from record to record. */
export function isSequenceLike(node: SchemaNode | undefined): boolean {
  if (!node?.order || !isNumeric(node)) return false;
  return node.order.sorted && node.count >= 3 && node.order.rises >= (node.count - 1) * 0.8;
}

export function formatSegment(segment: PathSegment): string {
  return segment === null ? '*' : segment;
}

export function formatPath(path: Path): string {
  return path.map(formatSegment).join(' ▸ ');
}

export interface FlatPath {
  path: string[];
  node: SchemaNode;
}

/** Every concrete (wildcard-free) path below a node, breadth-first. */
export function flattenPaths(root: SchemaNode | undefined, maxDepth = 8, limit = 5000): FlatPath[] {
  const out: FlatPath[] = [];
  if (!root) return out;
  let level: FlatPath[] = [{ path: [], node: root }];
  for (let depth = 0; depth < maxDepth && level.length > 0 && out.length < limit; depth++) {
    const next: FlatPath[] = [];
    for (const entry of level) {
      for (const key of keysOf(entry.node)) {
        const node = childSchema(entry.node, key);
        if (!node) continue;
        const item = { path: [...entry.path, key], node };
        out.push(item);
        if (out.length >= limit) return out;
        next.push(item);
      }
    }
    level = next;
  }
  return out;
}
