/** Field paths: how they are stored in a block and how they are written in JSONata. */
import type { Path } from '../data/schema';

export function encodePath(path: Path): string {
  return JSON.stringify(path);
}

/** Reads a stored path, tolerating anything that is not one. */
export function decodePath(value: unknown): Path {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((segment): segment is string | null => segment === null || typeof segment === 'string');
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['and', 'or', 'in', 'true', 'false', 'null', 'function']);

/** A key as a JSONata name, or `null` when it cannot be written as one. */
function nameToken(key: string): string | null {
  if (IDENTIFIER.test(key) && !RESERVED.has(key)) return key;
  if (key !== '' && !key.includes('`')) return '`' + key + '`';
  return null;
}

/**
 * JSONata for a path. `base` is the expression the path starts from; without one the path
 * is relative to the current context, and an empty path is the context itself (`$`).
 */
export function pathToJsonata(base: string | null, path: Path): string {
  let code = base ?? '';
  for (const segment of path) {
    if (segment === null) {
      code = code === '' ? '*' : `${code}.*`;
      continue;
    }
    const name = nameToken(segment);
    if (name !== null) code = code === '' ? name : `${code}.${name}`;
    else code = `$lookup(${code === '' ? '$' : code}, ${JSON.stringify(segment)})`;
  }
  return code === '' ? '$' : code;
}

/** The column name a path gets when none is given: its last named key. */
export function leafName(path: Path): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];
    if (typeof segment === 'string' && segment !== '') return segment;
  }
  return 'value';
}
