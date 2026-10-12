/** Builders for Blockly workspace states, so tests read like the blocks they describe. */

export type BlockState = { type: string; fields?: Record<string, unknown>; inputs?: Record<string, unknown>; next?: unknown };

/** A block. An input given as a list becomes a stack of statement blocks. */
export function block(type: string, fields: Record<string, unknown> = {}, inputs: Record<string, BlockState | BlockState[] | undefined> = {}): BlockState {
  const state: BlockState = { type };
  if (Object.keys(fields).length > 0) state.fields = fields;
  const connected: Record<string, unknown> = {};
  for (const [name, target] of Object.entries(inputs)) {
    if (target === undefined) continue;
    const first = Array.isArray(target) ? stack(target) : target;
    if (first) connected[name] = { block: first };
  }
  if (Object.keys(connected).length > 0) state.inputs = connected;
  return state;
}

function stack(blocks: BlockState[]): BlockState | undefined {
  for (let i = blocks.length - 2; i >= 0; i--) blocks[i]!.next = { block: blocks[i + 1] };
  return blocks[0];
}

/** A whole program: the root block with these steps stacked under it. */
export function program(...steps: BlockState[]): unknown {
  const root: BlockState = { type: 'jx_query' };
  const first = stack(steps);
  if (first) root.next = { block: first };
  return { blocks: { languageVersion: 0, blocks: [{ ...root, x: 0, y: 0 }] } };
}

const path = (segments: Array<string | null>) => ({ PATH: JSON.stringify(segments) });

export const field = (...segments: Array<string | null>) => block('jx_field', path(segments));
export const num = (value: number) => block('jx_number', { NUM: value });
export const text = (value: string) => block('jx_text', { TEXT: value });
export const col = (...segments: Array<string | null>) => block('jx_col_field', path(segments));
export const colAs = (name: string, value: BlockState) => block('jx_col_expr', { NAME: name }, { VALUE: value });
export const entryValue = (...segments: Array<string | null>) => block('jx_entry_value', path(segments));
export const entryKey = () => block('jx_entry_key');
export const item = (...segments: Array<string | null>) => block('jx_item', path(segments));
export const arith = (a: BlockState, op: string, b: BlockState) => block('jx_arith', { OP: op }, { A: a, B: b });
export const compare = (a: BlockState, op: string, b: BlockState) => block('jx_compare', { OP: op }, { A: a, B: b });
export const aggregate = (op: string, value: BlockState) => block('jx_aggregate', { OP: op }, { VALUE: value });
export const exists = (value: BlockState) => block('jx_exists', {}, { VALUE: value });
export const round = (value: BlockState, decimals: number) => block('jx_round', { DECIMALS: decimals }, { VALUE: value });
export const percent = (a: BlockState, b: BlockState) => block('jx_percent', {}, { A: a, B: b });
export const eachEntry = (object: BlockState, where: BlockState | undefined, get: BlockState | undefined) =>
  block('jx_entries_each', {}, { OBJ: object, WHERE: where, GET: get });
export const eachItem = (list: BlockState, where: BlockState | undefined, get: BlockState | undefined) =>
  block('jx_items_each', {}, { LIST: list, WHERE: where, GET: get });

export const filter = (condition: BlockState) => block('jx_filter', {}, { COND: condition });
export const pick = (...columns: BlockState[]) => block('jx_pick', {}, { COLUMNS: columns });
export const sort = (key: BlockState, order: 'ASC' | 'DESC' = 'ASC') => block('jx_sort', { ORDER: order }, { KEY: key });
export const limit = (which: 'FIRST' | 'LAST', n: number) => block('jx_limit', { WHICH: which, N: n });
export const group = (key: BlockState, name: string, ...columns: BlockState[]) => block('jx_group', { NAME: name }, { KEY: key, COLUMNS: columns });
export const summarize = (...columns: BlockState[]) => block('jx_summarize', {}, { COLUMNS: columns });

/**
 * The query used as the running example: for each record that has an evaluation suite,
 * the share of games won against every opponent but the checkpoint, and against the
 * checkpoint alone.
 */
export function exampleProgram(): unknown {
  return program(
    filter(exists(field('evaluation_suite'))),
    pick(
      col('version'),
      colAs(
        'pilots %',
        round(
          percent(aggregate('SUM', eachEntry(field('evaluation_suite'), compare(entryKey(), 'NEQ', text('blackwing-vs-checkpoint')), entryValue('wins'))), num(1664)),
          1,
        ),
      ),
      colAs('the start %', round(percent(field('evaluation_suite', 'blackwing-vs-checkpoint', 'wins'), num(2048)), 1)),
    ),
  );
}
