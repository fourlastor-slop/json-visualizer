/**
 * Blocks → JSONata.
 *
 * The program is a stack of steps under the root block. Each step transforms the rows the
 * previous one produced; value blocks inside a step are expressions evaluated for one row.
 */
import type { Block, Workspace } from 'blockly/core';
import { pathToJsonata } from './path';
import { BOOLEAN_TYPES, blockPath, columnsOf, inputBlock, stepsOf, textField } from './structure';

// Binding strength, strongest first. Mirrors JSONata's operator precedence.
const ATOMIC = 0;
const MULTIPLY = 1;
const ADD = 2;
const COMPARE = 3;
const AND = 4;
const OR = 5;
const CONDITION = 6;
const ANY = 99;

interface Loop {
  kind: 'entries' | 'items';
  value: string;
  key: string;
}

interface Scope {
  /**
   * True inside a group: the context is then all the rows of the group at once, so
   * anything computed per row has to be mapped over them explicitly.
   */
  collection: boolean;
  loops: readonly Loop[];
}

type Code = [code: string, order: number];

const ARITHMETIC: Record<string, [symbol: string, order: number]> = {
  ADD: ['+', ADD],
  SUB: ['-', ADD],
  MUL: ['*', MULTIPLY],
  DIV: ['/', MULTIPLY],
  MOD: ['%', MULTIPLY],
};

const COMPARISONS: Record<string, string> = { EQ: '=', NEQ: '!=', LT: '<', LTE: '<=', GT: '>', GTE: '>=' };

const AGGREGATES: Record<string, string> = { SUM: '$sum', AVG: '$average', MIN: '$min', MAX: '$max', COUNT: '$count' };

const MATH: Record<string, string> = { ABS: '$abs', FLOOR: '$floor', CEIL: '$ceil', SQRT: '$sqrt' };

const STRING_OPS: Record<string, string> = { LOWER: '$lowercase', UPPER: '$uppercase', TRIM: '$trim', LENGTH: '$length' };

/** Placeholder for an empty slot: an empty JSONata block evaluates to "nothing". */
const NOTHING = '()';

function indent(code: string): string {
  return code.replace(/\n/g, '\n  ');
}

function numberLiteral(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
}

function loopFor(scope: Scope, kind: Loop['kind']): Loop | undefined {
  for (let i = scope.loops.length - 1; i >= 0; i--) {
    if (scope.loops[i]!.kind === kind) return scope.loops[i];
  }
  return undefined;
}

function enterLoop(scope: Scope, kind: Loop['kind']): [Scope, Loop] {
  const depth = scope.loops.filter((loop) => loop.kind === kind).length;
  const suffix = depth === 0 ? '' : String(depth + 1);
  const loop: Loop = kind === 'entries' ? { kind, value: `$v${suffix}`, key: `$k${suffix}` } : { kind, value: `$item${suffix}`, key: `$i${suffix}` };
  // The body of a loop runs once per entry, for one row.
  return [{ collection: false, loops: [...scope.loops, loop] }, loop];
}

/** Code for a slot, parenthesized when it binds more loosely than `limit` allows. */
function slot(block: Block, name: string, scope: Scope, limit: number): string {
  const code = expression(inputBlock(block, name), scope);
  if (!code) return NOTHING;
  return code[1] > limit ? `(${code[0]})` : code[0];
}

/** A slot used as a condition where JSONata would read a number as a position. */
function predicate(block: Block, name: string, scope: Scope): string | null {
  const target = inputBlock(block, name);
  const code = expression(target, scope);
  if (!target || !code) return null;
  return BOOLEAN_TYPES.has(target.type) ? code[0] : `$boolean(${code[0]})`;
}

function isPlainPath(block: Block | null, code: string): boolean {
  return block?.type === 'jx_field' && !code.startsWith('$');
}

/**
 * The argument of a summary function. Inside a group a plain path already maps over the
 * rows of the group; anything else is computed row by row with `$.( … )`.
 */
function perRow(block: Block, name: string, scope: Scope): string {
  const target = inputBlock(block, name);
  const code = expression(target, { ...scope, collection: false });
  if (!code) return NOTHING;
  return scope.collection && !isPlainPath(target, code[0]) ? `$.(${code[0]})` : code[0];
}

function loopBody(block: Block, scope: Scope, fallback: string): string {
  const condition = expression(inputBlock(block, 'WHERE'), scope);
  const result = expression(inputBlock(block, 'GET'), scope);
  const value = result ? (result[1] >= CONDITION ? `(${result[0]})` : result[0]) : fallback;
  if (!condition) return value;
  return `${condition[1] >= CONDITION ? `(${condition[0]})` : condition[0]} ? ${value}`;
}

function expression(block: Block | null, scope: Scope): Code | null {
  if (!block) return null;
  switch (block.type) {
    case 'jx_field':
      return [pathToJsonata(null, blockPath(block)), ATOMIC];
    case 'jx_entry_value':
      return [pathToJsonata(loopFor(scope, 'entries')?.value ?? '$v', blockPath(block)), ATOMIC];
    case 'jx_entry_key':
      return [loopFor(scope, 'entries')?.key ?? '$k', ATOMIC];
    case 'jx_item':
      return [pathToJsonata(loopFor(scope, 'items')?.value ?? '$item', blockPath(block)), ATOMIC];
    case 'jx_item_index':
      return [loopFor(scope, 'items')?.key ?? '$i', ATOMIC];

    case 'jx_number':
      return [numberLiteral(block.getFieldValue('NUM')), ATOMIC];
    case 'jx_text':
      return [JSON.stringify(String(block.getFieldValue('TEXT') ?? '')), ATOMIC];
    case 'jx_boolean':
      return [block.getFieldValue('BOOL') === 'TRUE' ? 'true' : 'false', ATOMIC];

    case 'jx_arith': {
      const op = String(block.getFieldValue('OP'));
      if (op === 'POW') return [`$power(${slot(block, 'A', scope, ANY)}, ${slot(block, 'B', scope, ANY)})`, ATOMIC];
      const [symbol, order] = ARITHMETIC[op] ?? ARITHMETIC.ADD!;
      // Left-associative: the right operand must bind strictly tighter.
      return [`${slot(block, 'A', scope, order)} ${symbol} ${slot(block, 'B', scope, order - 0.5)}`, order];
    }
    case 'jx_percent':
      return [`${slot(block, 'A', scope, MULTIPLY)} / ${slot(block, 'B', scope, ATOMIC)} * 100`, MULTIPLY];
    case 'jx_round': {
      const decimals = Math.max(0, Math.round(Number(block.getFieldValue('DECIMALS')) || 0));
      const value = slot(block, 'VALUE', scope, ANY);
      return [decimals === 0 ? `$round(${value})` : `$round(${value}, ${decimals})`, ATOMIC];
    }
    case 'jx_math':
      return [`${MATH[String(block.getFieldValue('OP'))] ?? '$abs'}(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];

    case 'jx_aggregate': {
      const op = String(block.getFieldValue('OP'));
      const argument = perRow(block, 'VALUE', scope);
      if (op === 'DISTINCT') return [`$count($distinct(${argument}))`, ATOMIC];
      return [`${AGGREGATES[op] ?? '$sum'}(${argument})`, ATOMIC];
    }
    case 'jx_count_records':
      return ['$count($)', ATOMIC];
    case 'jx_nth':
      // Parenthesized so the position applies to the whole list, not to each step of a path.
      return [`(${perRow(block, 'VALUE', scope)})[${block.getFieldValue('WHICH') === 'LAST' ? -1 : 0}]`, ATOMIC];

    case 'jx_compare': {
      const symbol = COMPARISONS[String(block.getFieldValue('OP'))] ?? '=';
      return [`${slot(block, 'A', scope, ADD)} ${symbol} ${slot(block, 'B', scope, ADD)}`, COMPARE];
    }
    case 'jx_logic': {
      const or = block.getFieldValue('OP') === 'OR';
      const order = or ? OR : AND;
      return [`${slot(block, 'A', scope, order)} ${or ? 'or' : 'and'} ${slot(block, 'B', scope, order - 0.5)}`, order];
    }
    case 'jx_not':
      return [`$not(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    case 'jx_exists':
      return [`$exists(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    case 'jx_contains':
      return [`$contains(${slot(block, 'A', scope, ANY)}, ${slot(block, 'B', scope, ANY)})`, ATOMIC];
    case 'jx_ternary': {
      const head = `${slot(block, 'IF', scope, OR)} ? ${slot(block, 'THEN', scope, OR)}`;
      return [inputBlock(block, 'ELSE') ? `${head} : ${slot(block, 'ELSE', scope, OR)}` : head, CONDITION];
    }
    case 'jx_default': {
      const value = slot(block, 'VALUE', scope, OR);
      return [`$exists(${value}) ? ${value} : ${slot(block, 'DEFAULT', scope, OR)}`, CONDITION];
    }

    case 'jx_concat':
      return [`${slot(block, 'A', scope, ADD)} & ${slot(block, 'B', scope, ADD - 0.5)}`, ADD];
    case 'jx_string_op':
      return [`${STRING_OPS[String(block.getFieldValue('OP'))] ?? '$trim'}(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    case 'jx_to_number':
      return [`$number(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    case 'jx_to_string':
      return [`$string(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];

    case 'jx_keys':
      return [`$keys(${slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    case 'jx_entries_each': {
      const source = slot(block, 'OBJ', scope, ANY);
      const [inner, loop] = enterLoop(scope, 'entries');
      return [`$each(${source}, function(${loop.value}, ${loop.key}) { ${loopBody(block, inner, loop.value)} })`, ATOMIC];
    }
    case 'jx_items_each': {
      const source = slot(block, 'LIST', scope, ANY);
      const [inner, loop] = enterLoop(scope, 'items');
      return [`$map(${source}, function(${loop.value}, ${loop.key}) { ${loopBody(block, inner, loop.value)} })`, ATOMIC];
    }

    case 'jx_date_epoch': {
      const seconds = block.getFieldValue('UNIT') === 'S';
      return [`$fromMillis(${seconds ? `${slot(block, 'VALUE', scope, MULTIPLY)} * 1000` : slot(block, 'VALUE', scope, ANY)})`, ATOMIC];
    }
    case 'jx_date_trunc':
      return [`$substring(${slot(block, 'VALUE', scope, ANY)}, 0, ${numberLiteral(block.getFieldValue('UNIT'))})`, ATOMIC];

    case 'jx_raw': {
      const code = String(block.getFieldValue('CODE') ?? '').trim();
      return [code === '' ? NOTHING : `(${code})`, ATOMIC];
    }
    default:
      return null;
  }
}

function objectLiteral(entries: Array<[name: string, code: string]>): string {
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([name, code]) => `  ${JSON.stringify(name)}: ${indent(code)}`).join(',\n')}\n}`;
}

function columnEntries(container: Block, scope: Scope, reserved: readonly string[] = []): Array<[string, string]> {
  return columnsOf(container, reserved).map((column) => [
    column.name,
    column.path ? pathToJsonata(null, column.path) : (expression(column.value, scope)?.[0] ?? NOTHING),
  ]);
}

interface Step {
  /** Suffix that extends a path, for steps that work one row at a time. */
  chain: string | null;
  /** The step applied to an expression holding all rows. */
  apply: (rows: string) => string;
}

function chained(suffix: string): Step {
  return { chain: suffix, apply: (rows) => rows + suffix };
}

const ROW: Scope = { collection: false, loops: [] };
const GROUP: Scope = { collection: true, loops: [] };

function step(block: Block): Step | null {
  switch (block.type) {
    case 'jx_filter': {
      const condition = predicate(block, 'COND', ROW);
      return condition ? chained(`[${condition}]`) : null;
    }
    case 'jx_pick': {
      const entries = columnEntries(block, ROW);
      return entries.length > 0 ? chained(`.${objectLiteral(entries)}`) : null;
    }
    case 'jx_sort': {
      const key = expression(inputBlock(block, 'KEY'), ROW);
      if (!key) return null;
      return chained(`^(${block.getFieldValue('ORDER') === 'DESC' ? '>' : ''}${key[0]})`);
    }
    case 'jx_limit': {
      const count = Math.max(0, Math.round(Number(block.getFieldValue('N')) || 0));
      const last = block.getFieldValue('WHICH') === 'LAST';
      return {
        chain: null,
        apply: (rows) =>
          last
            ? `$filter(${rows}, function($row, $i, $all) { $i >= $count($all) - ${count} })`
            : `$filter(${rows}, function($row, $i) { $i < ${count} })`,
      };
    }
    case 'jx_group': {
      const keyBlock = inputBlock(block, 'KEY');
      const key = expression(keyBlock, ROW);
      if (!key) return null;
      const name = textField(block, 'NAME', 'group');
      // The key column keeps the key's own type; the grouping key itself must be text.
      const keyValue = key[0] === '$' ? '$[0]' : isPlainPath(keyBlock, key[0]) ? `$[0].${key[0]}` : `$[0].(${key[0]})`;
      const row = objectLiteral([[name, keyValue], ...columnEntries(block, GROUP, [name])]);
      return {
        chain: null,
        apply: (rows) => `$each(${rows}{\n  $string(${key[0]}): ${indent(row)}\n}, function($group) { $group })`,
      };
    }
    case 'jx_summarize': {
      const entries = columnEntries(block, GROUP);
      if (entries.length === 0) return null;
      return { chain: null, apply: (rows) => `${rows}{\n  "all": ${indent(objectLiteral(entries))}\n} ~> $lookup("all")` };
    }
    case 'jx_expand_entries': {
      const source = expression(inputBlock(block, 'OBJ'), ROW);
      if (!source) return null;
      const added = `{${JSON.stringify(textField(block, 'KEY_NAME', 'key'))}: $k, ${JSON.stringify(textField(block, 'VALUE_NAME', 'value'))}: $v}`;
      return chained(`.$each(${source[0]}, function($v, $k) { $merge([$, ${added}]) })`);
    }
    case 'jx_expand_items': {
      const source = expression(inputBlock(block, 'LIST'), ROW);
      if (!source) return null;
      const added = `{${JSON.stringify(textField(block, 'NAME', 'item'))}: $item}`;
      return chained(`.$map(${source[0]}, function($item) { $merge([$, ${added}]) })`);
    }
    case 'jx_into': {
      const target = inputBlock(block, 'EXPR');
      const code = expression(target, ROW);
      if (!code || code[0] === '$') return null;
      return chained(isPlainPath(target, code[0]) ? `.${code[0]}` : `.(${code[0]})`);
    }
    case 'jx_raw_step': {
      const code = String(block.getFieldValue('CODE') ?? '').trim();
      return code === '' || code === '$rows' ? null : { chain: null, apply: () => `(${code})` };
    }
    default:
      return null;
  }
}

/** The JSONata query a workspace stands for. With no steps it returns every record. */
export function generateQuery(workspace: Workspace): string {
  const steps = stepsOf(workspace)
    .map(step)
    .filter((s): s is Step => s !== null);
  if (steps.length === 0) return '$';

  // Steps that work row by row chain into a single path, the idiomatic JSONata form.
  if (steps.every((s) => s.chain !== null)) return '$' + steps.map((s) => s.chain).join('');

  // Otherwise each step rebinds $rows, so that "the first 10" or "group by" see all the
  // rows rather than being applied inside a path, once per row.
  const lines = steps.map((s) => `  $rows := ${indent(s.apply('$rows'))};`);
  return ['(', '  $rows := $;', ...lines, '  $rows', ')'].join('\n');
}
