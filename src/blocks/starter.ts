/** The blocks a new visualization starts with, chosen from the shape of its files. */
import { type SchemaNode, childSchema, isNumeric, isSequenceLike, keysOf, observedTypes } from '../data/schema';
import type { VizKind } from '../data/types';
import { encodePath } from './path';

/** Names that usually mean "the thing that advances": preferred for the X axis. */
const SEQUENCE_NAMES = /^(version|step|steps|epoch|iteration|iter|round|time|timestamp|ts|date|datetime|index|idx|t|x)$/i;

function sequenceField(schema: SchemaNode): string | undefined {
  const candidates = keysOf(schema).filter((key) => isSequenceLike(childSchema(schema, key)));
  return (
    candidates.find((key) => SEQUENCE_NAMES.test(key)) ??
    // Otherwise the one that increases most steadily.
    [...candidates].sort((a, b) => (childSchema(schema, b)?.order?.rises ?? 0) - (childSchema(schema, a)?.order?.rises ?? 0))[0]
  );
}

/**
 * A chart starts as "X: the field that counts upwards, Y: the first number that varies",
 * so there is a real picture to adjust from the first second. A table starts with every
 * record as it is.
 */
export function starterWorkspace(schema: SchemaNode | undefined, kind: VizKind): unknown {
  const root: Record<string, unknown> = { type: 'jx_query', x: 24, y: 24, deletable: false };
  if (kind === 'chart' && schema) {
    const keys = keysOf(schema);
    const isScalar = (key: string) => {
      const types = observedTypes(childSchema(schema, key));
      return types.length === 1 && (types[0] === 'number' || types[0] === 'string');
    };
    const x = sequenceField(schema) ?? keys.find(isScalar);
    const y = keys.find((key) => {
      const node = childSchema(schema, key);
      return key !== x && isNumeric(node) && node?.min !== node?.max && !isSequenceLike(node);
    });
    const columns = [x, y].filter((key): key is string => key !== undefined);
    let stack: Record<string, unknown> | undefined;
    for (const key of columns.reverse()) {
      stack = { type: 'jx_col_field', fields: { PATH: encodePath([key]) }, ...(stack ? { next: { block: stack } } : {}) };
    }
    if (stack) root.next = { block: { type: 'jx_pick', inputs: { COLUMNS: { block: stack } } } };
  }
  return { blocks: { languageVersion: 0, blocks: [root] } };
}
