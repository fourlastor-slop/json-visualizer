/** The toolbox. Its "Fields" category is built from the files being queried. */
import type * as Blockly from 'blockly/core';
import { isSequenceLike, keysOf, resolvePath } from '../data/schema';
import { getRootSchema } from './context';
import { encodePath } from './path';

type Json = Record<string, unknown>;

const block = (type: string, extra: Json = {}): Json => ({ kind: 'block', type, ...extra });
const number = (value: number): Json => ({ shadow: { type: 'jx_number', fields: { NUM: value } } });
const text = (value: string): Json => ({ shadow: { type: 'jx_text', fields: { TEXT: value } } });

const category = (name: string, style: string, contents: Json[]): Json => ({ kind: 'category', name, categorystyle: style, contents });

export const FIELDS_CATEGORY = 'JX_FIELDS';

/** At most this many fields are listed as ready-made blocks; the rest are a search away. */
const MAX_FIELD_BLOCKS = 120;

export const TOOLBOX: Json = {
  kind: 'categoryToolbox',
  contents: [
    category('Steps', 'jx_step', [
      block('jx_filter'),
      block('jx_pick', { inputs: { COLUMNS: { block: { type: 'jx_col_field' } } } }),
      block('jx_sort'),
      block('jx_limit'),
      block('jx_group', { inputs: { COLUMNS: { block: { type: 'jx_col_expr', fields: { NAME: 'count' }, inputs: { VALUE: { block: { type: 'jx_count_records' } } } } } } }),
      block('jx_summarize'),
      block('jx_expand_entries'),
      block('jx_expand_items'),
      block('jx_into'),
    ]),
    category('Columns', 'jx_column', [block('jx_col_field'), block('jx_col_expr')]),
    { kind: 'category', name: 'Fields', categorystyle: 'jx_field', custom: FIELDS_CATEGORY },
    category('Values', 'jx_value', [block('jx_number'), block('jx_text'), block('jx_boolean')]),
    category('Math', 'jx_math', [
      block('jx_arith', { inputs: { A: number(1), B: number(1) } }),
      block('jx_percent', { inputs: { B: number(100) } }),
      block('jx_round'),
      block('jx_math'),
    ]),
    category('Summaries', 'jx_summary', [block('jx_aggregate'), block('jx_count_records'), block('jx_nth')]),
    category('Logic', 'jx_logic', [
      block('jx_compare', { inputs: { B: number(0) } }),
      block('jx_exists'),
      block('jx_logic'),
      block('jx_not'),
      block('jx_ternary'),
      block('jx_default', { inputs: { DEFAULT: number(0) } }),
    ]),
    category('Text', 'jx_text', [
      block('jx_concat', { inputs: { B: text('') } }),
      block('jx_contains', { inputs: { B: text('') } }),
      block('jx_string_op'),
      block('jx_to_number'),
      block('jx_to_string'),
    ]),
    category('Objects & lists', 'jx_collection', [
      block('jx_entries_each', { inputs: { GET: { block: { type: 'jx_entry_value' } } } }),
      block('jx_entry_key'),
      block('jx_entry_value'),
      block('jx_items_each', { inputs: { GET: { block: { type: 'jx_item' } } } }),
      block('jx_item'),
      block('jx_item_index'),
      block('jx_keys'),
    ]),
    category('Dates', 'jx_date', [block('jx_date_epoch'), block('jx_date_trunc')]),
    category('Advanced', 'jx_raw', [block('jx_raw'), block('jx_raw_step')]),
  ],
};

/** Flyout contents for the "Fields" category: one block per top-level field of the files. */
export function fieldsFlyout(workspace: Blockly.Workspace): Json[] {
  const schema = getRootSchema(workspace);
  const keys = keysOf(schema);
  if (keys.length === 0) {
    const text = schema ? 'The records of the selected files are not objects, so they have no fields.' : 'Select a file to see its fields here.';
    return [{ kind: 'label', text }, block('jx_field')];
  }
  // Fields that count upwards (step, version, timestamp…) first: they are the usual X axis.
  const ordered = [...keys.filter((key) => isSequenceLike(resolvePath(schema, [key]))), ...keys.filter((key) => !isSequenceLike(resolvePath(schema, [key])))];
  const contents: Json[] = [{ kind: 'label', text: 'Click a field block to browse or search nested fields.' }, block('jx_field')];
  for (const key of ordered.slice(0, MAX_FIELD_BLOCKS)) contents.push(block('jx_field', { fields: { PATH: encodePath([key]) } }));
  if (keys.length > MAX_FIELD_BLOCKS) contents.push({ kind: 'label', text: `…and ${keys.length - MAX_FIELD_BLOCKS} more. Use search in a field block.` });
  return contents;
}
