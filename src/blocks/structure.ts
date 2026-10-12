/** Reading the block tree: which blocks are live, what a stack contains, how columns are named. */
import type { Block, Workspace } from 'blockly/core';
import type { Path } from '../data/schema';
import { decodePath, leafName } from './path';

export const ROOT_TYPE = 'jx_query';

/** Blocks that sit in the main stack under the root. */
export const STEP_TYPES: ReadonlySet<string> = new Set([
  'jx_filter',
  'jx_pick',
  'jx_sort',
  'jx_limit',
  'jx_group',
  'jx_summarize',
  'jx_expand_entries',
  'jx_expand_items',
  'jx_into',
  'jx_raw_step',
]);

/** Blocks carrying a PATH field. */
export const PATH_TYPES: ReadonlySet<string> = new Set(['jx_field', 'jx_col_field', 'jx_entry_value', 'jx_item']);

/** Blocks whose value is always true or false. */
export const BOOLEAN_TYPES: ReadonlySet<string> = new Set([
  'jx_boolean',
  'jx_compare',
  'jx_logic',
  'jx_not',
  'jx_exists',
  'jx_contains',
]);

export function isActive(block: Block | null | undefined): block is Block {
  return !!block && block.isEnabled() && !block.isInsertionMarker();
}

export function rootBlock(workspace: Workspace): Block | null {
  return workspace.getBlocksByType(ROOT_TYPE, true).find(isActive) ?? null;
}

/** The live steps stacked under the root, in order. */
export function stepsOf(workspace: Workspace): Block[] {
  const steps: Block[] = [];
  for (let block = rootBlock(workspace)?.getNextBlock() ?? null; block; block = block.getNextBlock()) {
    if (isActive(block)) steps.push(block);
  }
  return steps;
}

/** The live block plugged into a value input, if any. */
export function inputBlock(block: Block, name: string): Block | null {
  const target = block.getInputTargetBlock(name);
  return isActive(target) ? target : null;
}

/** The live blocks stacked inside a statement input. */
export function stackOf(block: Block, name: string): Block[] {
  const stack: Block[] = [];
  for (let child = block.getInputTargetBlock(name); child; child = child.getNextBlock()) {
    if (isActive(child)) stack.push(child);
  }
  return stack;
}

/** Every live block nested inside `block` (not the blocks stacked after it). */
export function* nestedBlocks(block: Block): Generator<Block> {
  for (const input of block.inputList) {
    for (let child = input.connection?.targetBlock() ?? null; child; child = child.getNextBlock()) {
      if (!isActive(child)) continue;
      yield child;
      yield* nestedBlocks(child);
    }
  }
}

export function blockPath(block: Block): Path {
  return decodePath(block.getFieldValue('PATH'));
}

export function textField(block: Block, name: string, fallback: string): string {
  const value = String(block.getFieldValue(name) ?? '').trim();
  return value === '' ? fallback : value;
}

export interface Column {
  block: Block;
  /** Final, unique name of the column. */
  name: string;
  /** The name before it was made unique, when it clashed with an earlier column. */
  clashedName: string | null;
  /** For `column <field>` blocks: the field's path. */
  path: Path | null;
  /** For `column <name> = <value>` blocks: the value block. */
  value: Block | null;
}

/**
 * The columns a block defines. Names are made unique, because JSONata rejects an object
 * that defines the same key twice. Column blocks with nothing to show are left out.
 */
export function columnsOf(container: Block, reserved: readonly string[] = []): Column[] {
  const used = new Set(reserved);
  const columns: Column[] = [];
  for (const block of stackOf(container, 'COLUMNS')) {
    let wanted: string;
    let path: Path | null = null;
    let value: Block | null = null;
    if (block.type === 'jx_col_field') {
      path = blockPath(block);
      if (path.length === 0) continue;
      wanted = leafName(path);
    } else {
      value = inputBlock(block, 'VALUE');
      if (!value) continue;
      wanted = textField(block, 'NAME', 'column');
    }
    let name = wanted;
    for (let n = 2; used.has(name); n++) name = `${wanted} (${n})`;
    used.add(name);
    columns.push({ block, name, clashedName: name === wanted ? null : wanted, path, value });
  }
  return columns;
}

/**
 * The nearest loop block of the given type whose body (its "where" or "get" slot) contains
 * `block`. The slot naming what to loop over is outside the loop.
 */
export function enclosingLoop(block: Block, loopType: string): Block | null {
  let child = block;
  for (let parent = block.getParent(); parent; child = parent, parent = parent.getParent()) {
    if (parent.type !== loopType) continue;
    const slot = parent.getInputWithBlock(child)?.name;
    if (slot === 'WHERE' || slot === 'GET') return parent;
  }
  return null;
}

/** The step of the main stack that `block` belongs to (possibly itself). */
export function owningStep(block: Block): Block | null {
  for (let current: Block | null = block; current; current = current.getSurroundParent()) {
    if (STEP_TYPES.has(current.type)) return current;
  }
  return null;
}
