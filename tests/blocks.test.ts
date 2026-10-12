import { describe, expect, it } from 'vitest';
import { compileState } from '../src/blocks/headless';
import { runQuery } from '../src/data/engine';
import { inferSchema, mergeSchemas } from '../src/data/schema';
import {
  type BlockState,
  aggregate,
  arith,
  block,
  col,
  colAs,
  compare,
  eachEntry,
  eachItem,
  entryKey,
  entryValue,
  exampleProgram,
  exists,
  field,
  filter,
  group,
  item,
  limit,
  num,
  percent,
  pick,
  program,
  round,
  sort,
  summarize,
  text,
} from './helpers';

const suite = (wins: Record<string, number>) =>
  Object.fromEntries(Object.entries(wins).map(([matchup, w]) => [matchup, { wins: w, games: 128, by_player: { '0': { wins: Math.floor(w / 2) }, '1': { wins: Math.ceil(w / 2) } } }]));

/** A miniature of the training-metrics files: mostly flat, with a sparse nested dictionary. */
const RECORDS = [
  { version: 1, learner: 'blackwing', win_rate: 0.5, duels: 520, tags: ['a', 'b'], steps: [{ loss: 0.4, n: 2 }, { loss: 0.2, n: 3 }] },
  {
    version: 2,
    learner: 'blackwing',
    win_rate: 0.6,
    duels: 520,
    tags: ['b'],
    steps: [{ loss: 0.1, n: 5 }],
    evaluation_suite: suite({ 'blackwing-vs-burn': 100, 'blackwing-vs-heroes': 90, 'blackwing-vs-checkpoint': 1024 }),
  },
  { version: 3, learner: 'heroes', win_rate: 0.7, duels: 260, tags: [], steps: [] },
  {
    version: 4,
    learner: 'heroes',
    win_rate: 0.8,
    duels: 520,
    evaluation_suite: suite({ 'blackwing-vs-burn': 120, 'blackwing-vs-heroes': 110, 'blackwing-vs-checkpoint': 1536 }),
  },
];
const SCHEMA = inferSchema(RECORDS);

const compile = (state: unknown) => compileState(state, SCHEMA);
const rows = async (state: unknown) => (await runQuery(compile(state).query, RECORDS)).rows;

/** The JSONata a value block generates, read back from a one-column query. */
function code(expression: BlockState): string {
  const query = compile(program(pick(colAs('x', expression)))).query;
  const match = /^\$\.\{\n {2}"x": ([\s\S]*)\n\}$/.exec(query);
  if (!match) throw new Error(`unexpected query shape: ${query}`);
  return match[1]!;
}

const value = async (expression: BlockState) => (await rows(program(pick(colAs('x', expression))))).map((row) => row.x);

describe('the example query', () => {
  it('generates idiomatic JSONata', () => {
    expect(compile(exampleProgram()).query).toBe(
      [
        '$[$exists(evaluation_suite)].{',
        '  "version": version,',
        '  "pilots %": $round($sum($each(evaluation_suite, function($v, $k) { $k != "blackwing-vs-checkpoint" ? $v.wins })) / 1664 * 100, 1),',
        '  "the start %": $round(evaluation_suite.`blackwing-vs-checkpoint`.wins / 2048 * 100, 1)',
        '}',
      ].join('\n'),
    );
  });

  it('computes both percentages for the records that were evaluated', async () => {
    expect(await rows(exampleProgram())).toEqual([
      { version: 2, 'pilots %': 11.4, 'the start %': 50 },
      { version: 4, 'pilots %': 13.8, 'the start %': 75 },
    ]);
  });

  it('reads only fields the files have', () => {
    const { issues, fields } = compile(exampleProgram());
    expect(issues).toEqual([]);
    expect(fields).toEqual(['evaluation_suite', 'version', 'evaluation_suite ▸ * ▸ wins', 'evaluation_suite ▸ blackwing-vs-checkpoint ▸ wins']);
  });
});

describe('expressions', () => {
  it('writes paths, quoting keys that are not plain names', () => {
    expect(code(field('version'))).toBe('version');
    expect(code(field('evaluation_suite', null, 'wins'))).toBe('evaluation_suite.*.wins');
    expect(code(field('evaluation_suite', 'blackwing-vs-burn', 'by_player', '0', 'wins'))).toBe('evaluation_suite.`blackwing-vs-burn`.by_player.`0`.wins');
    expect(code(field('and'))).toBe('`and`');
    expect(code(field('a`b', 'c'))).toBe('$lookup($, "a`b").c');
    expect(code(field())).toBe('$');
  });

  it('parenthesizes only where precedence requires it', () => {
    expect(code(arith(arith(num(1), 'ADD', num(2)), 'MUL', num(3)))).toBe('(1 + 2) * 3');
    expect(code(arith(num(1), 'ADD', arith(num(2), 'MUL', num(3))))).toBe('1 + 2 * 3');
    expect(code(arith(num(1), 'SUB', arith(num(2), 'SUB', num(3))))).toBe('1 - (2 - 3)');
    expect(code(arith(arith(num(1), 'SUB', num(2)), 'SUB', num(3)))).toBe('1 - 2 - 3');
    expect(code(arith(num(2), 'POW', num(10)))).toBe('$power(2, 10)');
    expect(code(percent(field('a'), arith(field('b'), 'ADD', field('c'))))).toBe('a / (b + c) * 100');
    expect(code(compare(arith(field('a'), 'ADD', num(1)), 'GTE', num(2)))).toBe('a + 1 >= 2');
    expect(code(block('jx_logic', { OP: 'AND' }, { A: block('jx_logic', { OP: 'OR' }, { A: exists(field('a')), B: exists(field('b')) }), B: exists(field('c')) }))).toBe(
      '($exists(a) or $exists(b)) and $exists(c)',
    );
  });

  it('evaluates arithmetic and text', async () => {
    expect(await value(round(arith(field('win_rate'), 'MUL', num(100)), 0))).toEqual([50, 60, 70, 80]);
    expect(await value(block('jx_concat', {}, { A: field('learner'), B: text('!') }))).toEqual(['blackwing!', 'blackwing!', 'heroes!', 'heroes!']);
    expect(await value(block('jx_contains', {}, { A: field('learner'), B: text('wing') }))).toEqual([true, true, false, false]);
    expect(await value(block('jx_string_op', { OP: 'LENGTH' }, { VALUE: field('learner') }))).toEqual([9, 9, 6, 6]);
  });

  it('treats an empty slot as nothing rather than failing', async () => {
    expect(code(arith(num(1), 'ADD', block('jx_math', { OP: 'ABS' })))).toBe('1 + $abs(())');
    expect(await rows(program(pick(col('version'), colAs('x', arith(field('version'), 'ADD', block('jx_math', { OP: 'ABS' }))))))).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
  });

  it('falls back when a value is missing', async () => {
    const expression = block('jx_default', {}, { VALUE: aggregate('SUM', field('evaluation_suite', null, 'wins')), DEFAULT: num(-1) });
    expect(code(expression)).toBe('$exists($sum(evaluation_suite.*.wins)) ? $sum(evaluation_suite.*.wins) : -1');
    expect(await value(expression)).toEqual([-1, 1214, -1, 1766]);
  });

  it('loops over the entries of a dictionary', async () => {
    const wins = eachEntry(field('evaluation_suite'), compare(entryValue('wins'), 'LT', num(1000)), entryKey());
    expect(code(wins)).toBe('$each(evaluation_suite, function($v, $k) { $v.wins < 1000 ? $k })');
    expect(await value(wins)).toEqual([undefined, ['blackwing-vs-burn', 'blackwing-vs-heroes'], undefined, ['blackwing-vs-burn', 'blackwing-vs-heroes']]);
  });

  it('names the variables of nested loops apart', () => {
    const inner = eachEntry(entryValue('by_player'), undefined, arith(entryValue('wins'), 'MUL', num(2)));
    expect(code(eachEntry(field('evaluation_suite'), undefined, aggregate('SUM', inner)))).toBe(
      '$each(evaluation_suite, function($v, $k) { $sum($each($v.by_player, function($v2, $k2) { $v2.wins * 2 })) })',
    );
  });

  it('loops over the items of a list', async () => {
    const weighted = aggregate('SUM', eachItem(field('steps'), compare(item('n'), 'GT', num(2)), arith(item('loss'), 'MUL', item('n'))));
    expect(code(weighted)).toBe('$sum($map(steps, function($item, $i) { $item.n > 2 ? $item.loss * $item.n }))');
    expect(await value(weighted)).toEqual([0.6000000000000001, 0.5, undefined, undefined]);
  });

  it('takes the first and last of several values', async () => {
    expect(code(block('jx_nth', { WHICH: 'LAST' }, { VALUE: field('tags') }))).toBe('(tags)[-1]');
    expect(await value(block('jx_nth', { WHICH: 'LAST' }, { VALUE: field('tags') }))).toEqual(['b', 'b', undefined, undefined]);
  });

  it('converts and truncates dates', async () => {
    const day = block('jx_date_trunc', { UNIT: '10' }, { VALUE: block('jx_date_epoch', { UNIT: 'S' }, { VALUE: arith(field('version'), 'MUL', num(86400)) }) });
    expect(code(day)).toBe('$substring($fromMillis(version * 86400 * 1000), 0, 10)');
    expect(await value(day)).toEqual(['1970-01-02', '1970-01-03', '1970-01-04', '1970-01-05']);
  });

  it('passes raw JSONata through', async () => {
    expect(await value(block('jx_raw', { CODE: '$uppercase(learner) & "/" & version' }))).toEqual(['BLACKWING/1', 'BLACKWING/2', 'HEROES/3', 'HEROES/4']);
  });
});

describe('steps', () => {
  it('returns every record when there are no steps', async () => {
    expect(compile(program()).query).toBe('$');
    expect(await rows(program())).toEqual(RECORDS);
  });

  it('chains row-by-row steps into one path', () => {
    const state = program(filter(compare(field('duels'), 'EQ', num(520))), pick(col('version'), col('win_rate')), sort(field('win_rate'), 'DESC'));
    expect(compile(state).query).toBe('$[duels = 520].{\n  "version": version,\n  "win_rate": win_rate\n}^(>win_rate)');
  });

  it('makes non-boolean conditions explicit, so a number is not read as a position', async () => {
    const state = program(filter(field('version')), pick(col('version')));
    expect(compile(state).query).toBe('$[$boolean(version)].{\n  "version": version\n}');
    expect(await rows(state)).toHaveLength(4);
  });

  it('limits all rows, not rows within a path step', async () => {
    const state = program(sort(field('win_rate'), 'DESC'), limit('FIRST', 2), pick(col('version')));
    expect(compile(state).query).toBe(
      ['(', '  $rows := $;', '  $rows := $rows^(>win_rate);', '  $rows := $filter($rows, function($row, $i) { $i < 2 });', '  $rows := $rows.{', '    "version": version', '  };', '  $rows', ')'].join('\n'),
    );
    expect(await rows(state)).toEqual([{ version: 4 }, { version: 3 }]);
    expect(await rows(program(pick(col('version')), limit('LAST', 1)))).toEqual([{ version: 4 }]);
  });

  it('groups rows and summarizes each group', async () => {
    const state = program(
      group(
        field('learner'),
        'learner',
        colAs('runs', block('jx_count_records')),
        colAs('duels', aggregate('SUM', field('duels'))),
        colAs('best %', aggregate('MAX', arith(field('win_rate'), 'MUL', num(100)))),
        colAs('latest', block('jx_nth', { WHICH: 'LAST' }, { VALUE: field('version') })),
      ),
    );
    expect(compile(state).query).toBe(
      [
        '(',
        '  $rows := $;',
        '  $rows := $each($rows{',
        '    $string(learner): {',
        '      "learner": $[0].learner,',
        '      "runs": $count($),',
        '      "duels": $sum(duels),',
        '      "best %": $max($.(win_rate * 100)),',
        '      "latest": (version)[-1]',
        '    }',
        '  }, function($group) { $group });',
        '  $rows',
        ')',
      ].join('\n'),
    );
    expect(await rows(state)).toEqual([
      { learner: 'blackwing', runs: 2, duels: 1040, 'best %': 60, latest: 2 },
      { learner: 'heroes', runs: 2, duels: 780, 'best %': 80, latest: 4 },
    ]);
  });

  it('runs loops per row inside a group', async () => {
    const wins = aggregate('SUM', eachEntry(field('evaluation_suite'), undefined, entryValue('wins')));
    expect(await rows(program(group(field('learner'), 'learner', colAs('wins', wins))))).toEqual([
      { learner: 'blackwing', wins: 1214 },
      { learner: 'heroes', wins: 1766 },
    ]);
  });

  it('summarizes all rows into one', async () => {
    const state = program(summarize(colAs('n', block('jx_count_records')), colAs('mean', aggregate('AVG', field('win_rate'))), colAs('learners', aggregate('DISTINCT', field('learner')))));
    expect(await rows(state)).toEqual([{ n: 4, mean: 0.65, learners: 2 }]);
  });

  it('expands dictionary entries and list items into rows', async () => {
    const perMatchup = program(
      block('jx_expand_entries', { KEY_NAME: 'matchup', VALUE_NAME: 'stats' }, { OBJ: field('evaluation_suite') }),
      filter(compare(field('matchup'), 'NEQ', text('blackwing-vs-checkpoint'))),
      pick(col('version'), col('matchup'), col('stats', 'wins')),
    );
    expect(compile(perMatchup).issues).toEqual([]);
    expect(await rows(perMatchup)).toEqual([
      { version: 2, matchup: 'blackwing-vs-burn', wins: 100 },
      { version: 2, matchup: 'blackwing-vs-heroes', wins: 90 },
      { version: 4, matchup: 'blackwing-vs-burn', wins: 120 },
      { version: 4, matchup: 'blackwing-vs-heroes', wins: 110 },
    ]);

    const perStep = program(block('jx_expand_items', { NAME: 'step' }, { LIST: field('steps') }), pick(col('version'), col('step', 'loss')));
    expect(await rows(perStep)).toEqual([
      { version: 1, loss: 0.4 },
      { version: 1, loss: 0.2 },
      { version: 2, loss: 0.1 },
    ]);
  });

  it('goes into nested lists', async () => {
    const state = program(block('jx_into', {}, { EXPR: field('steps') }), filter(compare(field('n'), 'GT', num(2))), pick(col('loss')));
    expect(compile(state).query).toBe('$.steps[n > 2].{\n  "loss": loss\n}');
    expect(compile(state).issues).toEqual([]);
    expect(await rows(state)).toEqual([{ loss: 0.2 }, { loss: 0.1 }]);
  });

  it('keeps column names unique', async () => {
    const state = program(pick(col('version'), colAs('version', field('duels')), col('evaluation_suite', 'blackwing-vs-burn', 'wins'), col('evaluation_suite', 'blackwing-vs-heroes', 'wins')));
    const compiled = compile(state);
    expect(compiled.issues.map((issue) => issue.kind)).toEqual(['duplicate', 'duplicate']);
    expect(Object.keys((await rows(state))[1]!)).toEqual(['version', 'version (2)', 'wins', 'wins (2)']);
  });

  it('skips steps that are not filled in yet', () => {
    const state = program(block('jx_filter'), block('jx_pick'), block('jx_sort', { ORDER: 'ASC' }), block('jx_group', { NAME: 'g' }), pick(col('version')));
    expect(compile(state).query).toBe('$.{\n  "version": version\n}');
  });

  it('accepts raw JSONata as a step', async () => {
    const state = program(pick(col('version')), block('jx_raw_step', { CODE: '$rows[version > 2]' }));
    expect(await rows(state)).toEqual([{ version: 3 }, { version: 4 }]);
  });
});

describe('schema awareness', () => {
  it('reports fields the files do not have', () => {
    const { issues } = compile(program(filter(exists(field('evaluation_suite', 'blackwing-vs-dragons'))), pick(col('nope'), col('version'))));
    expect(issues.map((issue) => [issue.kind, issue.field])).toEqual([
      ['missing-field', 'evaluation_suite ▸ blackwing-vs-dragons'],
      ['missing-field', 'nope'],
    ]);
  });

  it('resolves later steps against the columns earlier steps made', () => {
    const state = program(pick(colAs('v', field('version')), colAs('double', arith(field('duels'), 'MUL', num(2)))), sort(field('double')), filter(compare(field('duels'), 'GT', num(1))));
    const { issues, fields } = compile(state);
    // `double` exists after the pick; `duels` no longer does.
    expect(issues.map((issue) => issue.field)).toEqual(['duels']);
    expect(fields).toEqual(['version', 'duels']);
  });

  it('follows renamed columns back to the file fields they read', () => {
    const state = program(pick(colAs('suite', field('evaluation_suite'))), pick(col('suite', 'blackwing-vs-burn', 'wins')));
    const { issues, fields } = compile(state);
    expect(issues).toEqual([]);
    expect(fields).toEqual(['evaluation_suite', 'evaluation_suite ▸ blackwing-vs-burn ▸ wins']);
  });

  it('knows what loop variables contain', () => {
    const ok = program(pick(colAs('x', eachEntry(field('evaluation_suite'), undefined, entryValue('by_player', '0', 'wins')))));
    expect(compile(ok).issues).toEqual([]);
    const bad = program(pick(colAs('x', eachItem(field('steps'), undefined, item('accuracy')))));
    expect(compile(bad).issues.map((issue) => issue.field)).toEqual(['steps ▸ accuracy']);
  });

  it('flags loop variables used outside their loop', () => {
    const { issues } = compile(program(pick(colAs('x', entryKey()), colAs('y', item('loss')))));
    expect(issues.map((issue) => issue.kind)).toEqual(['outside-loop', 'outside-loop']);
  });

  it('cannot check anything without a schema, and says nothing', () => {
    expect(compileState(exampleProgram(), undefined).issues).toEqual([]);
  });

  it('names the files that lack a field when only some do', () => {
    const other = inferSchema([{ version: 1, evaluation_suite: { 'dragons-vs-burn': { wins: 3 } } }]);
    const bare = inferSchema([{ step: 1 }]);
    const files = [
      { name: 'full.jsonl', schema: SCHEMA },
      { name: 'other.jsonl', schema: other },
      { name: 'bare.jsonl', schema: bare },
    ];
    const combined = [SCHEMA, other, bare].reduce((a, b) => mergeSchemas(a, b));
    // Against the combined shape nothing is missing: every field exists somewhere.
    expect(compileState(exampleProgram(), combined).issues).toEqual([]);
    const issues = compileState(exampleProgram(), combined, files).issues;
    // In program order. The loop's own field is flagged; what it would have looped over
    // cannot be checked once the field itself is missing.
    expect(issues.map((issue) => [issue.field, issue.files])).toEqual([
      ['evaluation_suite', ['bare.jsonl']],
      ['version', ['bare.jsonl']],
      ['evaluation_suite', ['bare.jsonl']],
      ['evaluation_suite ▸ blackwing-vs-checkpoint ▸ wins', ['other.jsonl', 'bare.jsonl']],
    ]);
    expect(issues[3]!.message).toBe('“evaluation_suite ▸ blackwing-vs-checkpoint ▸ wins” is not in other.jsonl, bare.jsonl.');
    // A field no file has is reported once, without singling files out.
    const nowhere = compileState(program(pick(col('nope'))), combined, files).issues;
    expect(nowhere).toEqual([{ blockId: nowhere[0]!.blockId, kind: 'missing-field', field: 'nope', message: '“nope” was not found in the selected files.' }]);
  });

  it('judges a query against a different file', () => {
    const other = inferSchema([{ version: 1, evaluation_suite: { 'dragons-vs-burn': { wins: 3 } } }]);
    expect(compileState(exampleProgram(), other).issues.map((issue) => issue.field)).toEqual(['evaluation_suite ▸ blackwing-vs-checkpoint ▸ wins']);
  });
});
