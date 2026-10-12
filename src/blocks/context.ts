/**
 * What a block can "see": the shape of the rows reaching each step, and of the entry or
 * item inside each loop. This is what lets a field block offer the fields that actually
 * exist at its position, and what decides whether a query fits another file.
 */
import type { Block, Workspace } from 'blockly/core';
import {
  type Path,
  type SchemaNode,
  childSchema,
  formatPath,
  itemsSchema,
  listSchema,
  mergeSchemas,
  objectSchema,
  resolvePath,
  scalarSchema,
  unknownSchema,
} from '../data/schema';
import {
  BOOLEAN_TYPES,
  type Column,
  PATH_TYPES,
  blockPath,
  columnsOf,
  enclosingLoop,
  inputBlock,
  nestedBlocks,
  owningStep,
  rootBlock,
  stepsOf,
  textField,
} from './structure';

const rootSchemas = new WeakMap<Workspace, SchemaNode>();

/** Tells a workspace the shape of the records its query runs on. */
export function setRootSchema(workspace: Workspace, schema: SchemaNode | undefined): void {
  if (schema) rootSchemas.set(workspace, schema);
  else rootSchemas.delete(workspace);
}

export function getRootSchema(workspace: Workspace): SchemaNode | undefined {
  return rootSchemas.get(workspace);
}

/** The rows flowing into a step. */
class RowContext {
  constructor(
    /** Shape of one row; undefined when no file is selected. */
    readonly schema: SchemaNode | undefined,
    /** Where a row sits in the file, or null once rows are no longer file records. */
    private readonly base: Path | null,
    /** File locations of columns that were added or renamed along the way. */
    private readonly columns: ReadonlyMap<string, Path | null> = new Map(),
  ) {}

  /** The file field a row-relative path reads, or null if it is not a file field. */
  origin(path: Path): Path | null {
    const head = path[0];
    if (typeof head === 'string' && this.columns.has(head)) {
      const column = this.columns.get(head)!;
      return column ? [...column, ...path.slice(1)] : null;
    }
    return this.base ? [...this.base, ...path] : null;
  }

  /** Rows replaced by new columns. */
  static derived(columns: Array<[name: string, schema: SchemaNode | undefined, origin: Path | null]>): RowContext {
    return new RowContext(
      objectSchema(columns.map(([name, schema]) => [name, schema ?? unknownSchema()])),
      null,
      new Map(columns.map(([name, , origin]) => [name, origin])),
    );
  }

  /** Rows that keep their columns and gain some. */
  extended(columns: Array<[name: string, schema: SchemaNode | undefined, origin: Path | null]>): RowContext {
    const added = objectSchema(columns.map(([name, schema]) => [name, schema ?? unknownSchema()]));
    const schema = !this.schema || this.schema.unknown ? this.schema : { ...this.schema, fields: { ...this.schema.fields, ...added.fields } };
    const origins = new Map(this.columns);
    for (const [name, , origin] of columns) origins.set(name, origin);
    return new RowContext(schema, this.base, origins);
  }
}

/** What a PATH field is relative to. */
export interface FieldScope {
  /** Shape the path is resolved against; undefined when nothing is known. */
  schema: SchemaNode | undefined;
  /** The file field a path in this scope reads, or null. */
  origin(path: Path): Path | null;
  /** Set when a loop variable is used outside its loop. */
  outsideLoop?: 'entries' | 'items';
}

const NUMBER_TYPES = new Set([
  'jx_number',
  'jx_arith',
  'jx_percent',
  'jx_round',
  'jx_math',
  'jx_aggregate',
  'jx_count_records',
  'jx_to_number',
  'jx_item_index',
]);
const STRING_TYPES = new Set(['jx_text', 'jx_concat', 'jx_to_string', 'jx_entry_key', 'jx_date_epoch', 'jx_date_trunc']);

function fieldScopeIn(block: Block, rows: RowContext): FieldScope {
  if (block.type === 'jx_entry_value') {
    const loop = enclosingLoop(block, 'jx_entries_each');
    if (!loop) return { schema: undefined, origin: () => null, outsideLoop: 'entries' };
    const source = inputBlock(loop, 'OBJ');
    const base = exprOrigin(source, rows);
    return { schema: childSchema(exprSchema(source, rows), null), origin: (path) => (base ? [...base, null, ...path] : null) };
  }
  if (block.type === 'jx_item') {
    const loop = enclosingLoop(block, 'jx_items_each');
    if (!loop) return { schema: undefined, origin: () => null, outsideLoop: 'items' };
    const source = inputBlock(loop, 'LIST');
    const base = exprOrigin(source, rows);
    return { schema: itemsSchema(exprSchema(source, rows)), origin: (path) => (base ? [...base, ...path] : null) };
  }
  return { schema: rows.schema, origin: (path) => rows.origin(path) };
}

/** Shape of the value a block produces; undefined when it reads a field that is not there. */
function exprSchema(block: Block | null, rows: RowContext): SchemaNode | undefined {
  if (!block) return undefined;
  if (PATH_TYPES.has(block.type)) return resolvePath(fieldScopeIn(block, rows).schema, blockPath(block));
  if (NUMBER_TYPES.has(block.type)) return scalarSchema('number');
  if (STRING_TYPES.has(block.type)) return scalarSchema('string');
  if (BOOLEAN_TYPES.has(block.type)) return scalarSchema('boolean');
  switch (block.type) {
    case 'jx_string_op':
      return scalarSchema(block.getFieldValue('OP') === 'LENGTH' ? 'number' : 'string');
    case 'jx_ternary': {
      const yes = exprSchema(inputBlock(block, 'THEN'), rows);
      const no = exprSchema(inputBlock(block, 'ELSE'), rows);
      return yes && no ? mergeSchemas(yes, no) : (yes ?? no);
    }
    case 'jx_default':
      return exprSchema(inputBlock(block, 'VALUE'), rows) ?? exprSchema(inputBlock(block, 'DEFAULT'), rows);
    case 'jx_nth':
      return itemsSchema(exprSchema(inputBlock(block, 'VALUE'), rows));
    case 'jx_keys':
      return listSchema(scalarSchema('string'));
    case 'jx_entries_each': {
      const result = inputBlock(block, 'GET');
      return listSchema(result ? exprSchema(result, rows) : childSchema(exprSchema(inputBlock(block, 'OBJ'), rows), null));
    }
    case 'jx_items_each': {
      const result = inputBlock(block, 'GET');
      return listSchema(result ? exprSchema(result, rows) : itemsSchema(exprSchema(inputBlock(block, 'LIST'), rows)));
    }
    default:
      return unknownSchema();
  }
}

/** The file field a block's value is read from, when it is a plain field reference. */
function exprOrigin(block: Block | null, rows: RowContext): Path | null {
  if (!block || !PATH_TYPES.has(block.type)) return null;
  return fieldScopeIn(block, rows).origin(blockPath(block));
}

function columnInfo(column: Column, rows: RowContext): [string, SchemaNode | undefined, Path | null] {
  if (column.path) return [column.name, resolvePath(rows.schema, column.path), rows.origin(column.path)];
  return [column.name, exprSchema(column.value, rows), exprOrigin(column.value, rows)];
}

/** The rows a step hands to the next one. Mirrors what the generator emits for it. */
function rowsAfter(step: Block, rows: RowContext): RowContext {
  switch (step.type) {
    case 'jx_pick': {
      const columns = columnsOf(step);
      return columns.length > 0 ? RowContext.derived(columns.map((column) => columnInfo(column, rows))) : rows;
    }
    case 'jx_group': {
      const key = inputBlock(step, 'KEY');
      if (!key) return rows;
      const name = textField(step, 'NAME', 'group');
      return RowContext.derived([
        [name, exprSchema(key, rows), exprOrigin(key, rows)],
        // Summaries are computed values, not file fields.
        ...columnsOf(step, [name]).map((column): [string, SchemaNode | undefined, null] => [column.name, columnInfo(column, rows)[1], null]),
      ]);
    }
    case 'jx_summarize': {
      const columns = columnsOf(step);
      if (columns.length === 0) return rows;
      return RowContext.derived(columns.map((column): [string, SchemaNode | undefined, null] => [column.name, columnInfo(column, rows)[1], null]));
    }
    case 'jx_expand_entries': {
      const source = inputBlock(step, 'OBJ');
      if (!source) return rows;
      const base = exprOrigin(source, rows);
      return rows.extended([
        [textField(step, 'KEY_NAME', 'key'), scalarSchema('string'), null],
        [textField(step, 'VALUE_NAME', 'value'), childSchema(exprSchema(source, rows), null), base ? [...base, null] : null],
      ]);
    }
    case 'jx_expand_items': {
      const source = inputBlock(step, 'LIST');
      if (!source) return rows;
      return rows.extended([[textField(step, 'NAME', 'item'), itemsSchema(exprSchema(source, rows)), exprOrigin(source, rows)]]);
    }
    case 'jx_into': {
      const source = inputBlock(step, 'EXPR');
      if (!source || (PATH_TYPES.has(source.type) && blockPath(source).length === 0)) return rows;
      return new RowContext(itemsSchema(exprSchema(source, rows)) ?? unknownSchema(), exprOrigin(source, rows));
    }
    case 'jx_raw_step': {
      const code = String(step.getFieldValue('CODE') ?? '').trim();
      return code === '' || code === '$rows' ? rows : new RowContext(unknownSchema(), null);
    }
    default:
      return rows;
  }
}

/** Calls `visit` for every live step with the rows flowing into it. */
function walkSteps(workspace: Workspace, visit: (step: Block, rows: RowContext) => void, schema = getRootSchema(workspace)): void {
  let rows = new RowContext(schema, []);
  for (const step of stepsOf(workspace)) {
    visit(step, rows);
    rows = rowsAfter(step, rows);
  }
}

/** The scope of a block's PATH field: used by the field picker. */
export function fieldScope(block: Block): FieldScope {
  const workspace = block.workspace;
  const step = owningStep(block);
  let found: RowContext | undefined;
  if (step) {
    walkSteps(workspace, (candidate, rows) => {
      if (candidate === step) found = rows;
    });
  }
  // A block that is not (yet) part of the query is treated as if it read file records.
  return fieldScopeIn(block, found ?? new RowContext(getRootSchema(workspace), []));
}

export type IssueKind = 'missing-field' | 'outside-loop' | 'unset' | 'duplicate';

export interface Issue {
  blockId: string;
  kind: IssueKind;
  message: string;
  /** For missing fields: the field as shown to the user. */
  field?: string;
  /** For missing fields: the files lacking it, when only some of the files do. */
  files?: string[];
}

/** A file a query runs on, as far as checking the query goes. */
export interface FileSchema {
  name: string;
  schema: SchemaNode;
}

export interface Analysis {
  issues: Issue[];
  /** File fields the query reads, as display paths, in first-use order. */
  fields: string[];
  hasRoot: boolean;
}

/** Checks a query against a schema: by default, the one set on its workspace. */
export function analyze(workspace: Workspace, schema: SchemaNode | undefined = getRootSchema(workspace)): Analysis {
  const issues: Issue[] = [];
  const fields = new Set<string>();

  const checkPath = (block: Block, rows: RowContext): void => {
    const scope = fieldScopeIn(block, rows);
    if (scope.outsideLoop) {
      const [what, loop] = scope.outsideLoop === 'entries' ? ['entry value', 'for each entry'] : ['item', 'for each item'];
      issues.push({ blockId: block.id, kind: 'outside-loop', message: `“${what}” only works inside the “where” or “get” slot of a “${loop}” block.` });
      return;
    }
    const path = blockPath(block);
    if (path.length === 0) {
      if (block.type === 'jx_col_field') issues.push({ blockId: block.id, kind: 'unset', message: 'Choose a field for this column.' });
      return;
    }
    const origin = scope.origin(path);
    if (origin) fields.add(formatPath(origin));
    if (!scope.schema || scope.schema.unknown) return;
    if (!resolvePath(scope.schema, path)) {
      const field = formatPath(origin ?? path);
      issues.push({ blockId: block.id, kind: 'missing-field', field, message: `“${field}” was not found in the selected files.` });
    }
  };

  const visit = (step: Block, rows: RowContext): void => {
    for (const block of [step, ...nestedBlocks(step)]) {
      if (PATH_TYPES.has(block.type)) {
        checkPath(block, rows);
      } else if (block.type === 'jx_entry_key' && !enclosingLoop(block, 'jx_entries_each')) {
        issues.push({ blockId: block.id, kind: 'outside-loop', message: '“entry key” only works inside the “where” or “get” slot of a “for each entry” block.' });
      } else if (block.type === 'jx_item_index' && !enclosingLoop(block, 'jx_items_each')) {
        issues.push({ blockId: block.id, kind: 'outside-loop', message: '“item index” only works inside the “where” or “get” slot of a “for each item” block.' });
      }
    }
    if (step.type === 'jx_pick' || step.type === 'jx_group' || step.type === 'jx_summarize') {
      const reserved = step.type === 'jx_group' ? [textField(step, 'NAME', 'group')] : [];
      for (const column of columnsOf(step, reserved)) {
        if (column.clashedName !== null) {
          issues.push({
            blockId: column.block.id,
            kind: 'duplicate',
            message: `There is already a column named “${column.clashedName}”; this one is output as “${column.name}”.`,
          });
        }
      }
    }
  };
  walkSteps(workspace, visit, schema);

  return { issues, fields: [...fields], hasRoot: rootBlock(workspace) !== null };
}

/**
 * Checks a query that runs on several files. The workspace's own schema is their combined
 * shape, which is what the field pickers offer; but a field that only some files have
 * leaves gaps in the others, so missing fields are looked for file by file.
 */
export function analyzeFiles(workspace: Workspace, files: readonly FileSchema[]): Analysis {
  const combined = analyze(workspace);
  if (files.length <= 1) return combined;

  const lacking = new Map<string, Issue & { files: string[] }>();
  for (const file of files) {
    for (const issue of analyze(workspace, file.schema).issues) {
      if (issue.kind !== 'missing-field') continue;
      const known = lacking.get(issue.blockId);
      if (known) known.files.push(file.name);
      else lacking.set(issue.blockId, { ...issue, files: [file.name] });
    }
  }
  const issues = combined.issues.filter((issue) => issue.kind !== 'missing-field');
  for (const issue of lacking.values()) {
    if (issue.files.length === files.length) issues.push({ blockId: issue.blockId, kind: issue.kind, field: issue.field, message: issue.message });
    else issues.push({ ...issue, message: `“${issue.field}” is not in ${issue.files.join(', ')}.` });
  }

  // Listed in the order the blocks appear in the program, whichever file raised them.
  const position = new Map<string, number>();
  walkSteps(workspace, (step) => {
    for (const block of [step, ...nestedBlocks(step)]) position.set(block.id, position.size);
  });
  issues.sort((a, b) => (position.get(a.blockId) ?? 0) - (position.get(b.blockId) ?? 0));
  return { ...combined, issues };
}
