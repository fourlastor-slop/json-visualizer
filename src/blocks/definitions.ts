/** The custom blocks. Shapes and labels only: what they mean lives in generator.ts. */

const step = { previousStatement: 'Step', nextStatement: 'Step', style: 'jx_step' } as const;
const column = { previousStatement: 'Column', nextStatement: 'Column', style: 'jx_column' } as const;

const value = (name: string, check?: string) => (check ? { type: 'input_value', name, check } : { type: 'input_value', name });
const text = (name: string, initial: string) => ({ type: 'field_input', name, text: initial, spellcheck: false });
const choice = (name: string, options: Array<[label: string, value: string]>) => ({ type: 'field_dropdown', name, options });
const path = (emptyLabel: string) => ({ type: 'field_jx_path', name: 'PATH', emptyLabel });

export const BLOCK_DEFINITIONS: object[] = [
  // ── Steps ────────────────────────────────────────────────────────────────
  {
    type: 'jx_query',
    message0: 'records',
    nextStatement: 'Step',
    style: 'jx_root',
    tooltip: 'Every record of the selected files. Stack steps underneath to filter, reshape and summarize them.',
  },
  {
    type: 'jx_filter',
    message0: 'keep where %1',
    args0: [value('COND', 'Boolean')],
    inputsInline: true,
    ...step,
    tooltip: 'Keeps only the rows for which the condition holds.',
  },
  {
    type: 'jx_pick',
    message0: 'pick columns',
    message1: '%1',
    args1: [{ type: 'input_statement', name: 'COLUMNS', check: 'Column' }],
    ...step,
    tooltip: 'Turns every row into a row with just these columns. This is what a chart or table shows.',
  },
  {
    type: 'jx_sort',
    message0: 'sort by %1 %2',
    args0: [
      value('KEY'),
      choice('ORDER', [
        ['ascending', 'ASC'],
        ['descending', 'DESC'],
      ]),
    ],
    inputsInline: true,
    ...step,
    tooltip: 'Orders the rows by a number or a text.',
  },
  {
    type: 'jx_limit',
    message0: 'keep the %1 %2 rows',
    args0: [
      choice('WHICH', [
        ['first', 'FIRST'],
        ['last', 'LAST'],
      ]),
      { type: 'field_number', name: 'N', value: 10, min: 0, precision: 1 },
    ],
    ...step,
    tooltip: 'Keeps a number of rows from the start or the end.',
  },
  {
    type: 'jx_group',
    message0: 'group by %1 as %2',
    args0: [value('KEY'), text('NAME', 'group')],
    message1: 'summarize %1',
    args1: [{ type: 'input_statement', name: 'COLUMNS', check: 'Column' }],
    inputsInline: true,
    ...step,
    tooltip:
      'Makes one row per distinct value of the key. Columns here see all the rows of a group at once, so use summaries (sum, average, count…). Rows without the key are left out.',
  },
  {
    type: 'jx_summarize',
    message0: 'summarize all rows',
    message1: '%1',
    args1: [{ type: 'input_statement', name: 'COLUMNS', check: 'Column' }],
    ...step,
    tooltip: 'Collapses all rows into a single row of summaries (sum, average, count…).',
  },
  {
    type: 'jx_expand_entries',
    message0: 'for each entry of %1',
    args0: [value('OBJ')],
    message1: 'add columns %1 and %2',
    args1: [text('KEY_NAME', 'key'), text('VALUE_NAME', 'value')],
    inputsInline: true,
    ...step,
    tooltip:
      'For an object used as a dictionary: makes one row per entry, keeping the other fields and adding the entry’s key and value as columns.',
  },
  {
    type: 'jx_expand_items',
    message0: 'for each item of %1',
    args0: [value('LIST')],
    message1: 'add column %1',
    args1: [text('NAME', 'item')],
    inputsInline: true,
    ...step,
    tooltip: 'For a list: makes one row per item, keeping the other fields and adding the item as a column.',
  },
  {
    type: 'jx_into',
    message0: 'go into %1',
    args0: [value('EXPR')],
    inputsInline: true,
    ...step,
    tooltip: 'Continues with a nested object, or with every item of a nested list, as the rows.',
  },
  {
    type: 'jx_raw_step',
    message0: 'set rows to JSONata %1',
    args0: [text('CODE', '$rows')],
    ...step,
    style: 'jx_raw',
    tooltip: 'A JSONata expression that computes the new rows. The current rows are in $rows.',
  },

  // ── Columns ──────────────────────────────────────────────────────────────
  {
    type: 'jx_col_field',
    message0: 'column %1',
    args0: [path('select field')],
    ...column,
    tooltip: 'A column holding a field, named after it.',
  },
  {
    type: 'jx_col_expr',
    message0: 'column %1 = %2',
    args0: [text('NAME', 'name'), value('VALUE')],
    inputsInline: true,
    ...column,
    tooltip: 'A column with a name of your choice and any value.',
  },

  // ── Fields ───────────────────────────────────────────────────────────────
  {
    type: 'jx_field',
    message0: '%1',
    args0: [path('whole row')],
    output: null,
    style: 'jx_field',
    tooltip: 'A field of the row. Click to browse or search the fields of the selected files.',
  },

  // ── Values ───────────────────────────────────────────────────────────────
  { type: 'jx_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number', style: 'jx_value', tooltip: 'A number.' },
  { type: 'jx_text', message0: '“ %1 ”', args0: [text('TEXT', '')], output: 'String', style: 'jx_value', tooltip: 'A text.' },
  {
    type: 'jx_boolean',
    message0: '%1',
    args0: [
      choice('BOOL', [
        ['true', 'TRUE'],
        ['false', 'FALSE'],
      ]),
    ],
    output: 'Boolean',
    style: 'jx_value',
    tooltip: 'True or false.',
  },

  // ── Math ─────────────────────────────────────────────────────────────────
  {
    type: 'jx_arith',
    message0: '%1 %2 %3',
    args0: [
      value('A', 'Number'),
      choice('OP', [
        ['+', 'ADD'],
        ['−', 'SUB'],
        ['×', 'MUL'],
        ['÷', 'DIV'],
        ['mod', 'MOD'],
        ['^', 'POW'],
      ]),
      value('B', 'Number'),
    ],
    inputsInline: true,
    output: 'Number',
    style: 'jx_math',
    tooltip: 'Arithmetic on two numbers.',
  },
  {
    type: 'jx_percent',
    message0: '%1 as %% of %2',
    args0: [value('A', 'Number'), value('B', 'Number')],
    inputsInline: true,
    output: 'Number',
    style: 'jx_math',
    tooltip: 'The first number as a percentage of the second.',
  },
  {
    type: 'jx_round',
    message0: 'round %1 to %2 decimals',
    args0: [value('VALUE', 'Number'), { type: 'field_number', name: 'DECIMALS', value: 1, min: 0, max: 12, precision: 1 }],
    inputsInline: true,
    output: 'Number',
    style: 'jx_math',
    tooltip: 'Rounds a number.',
  },
  {
    type: 'jx_math',
    message0: '%1 %2',
    args0: [
      choice('OP', [
        ['absolute', 'ABS'],
        ['round down', 'FLOOR'],
        ['round up', 'CEIL'],
        ['square root of', 'SQRT'],
      ]),
      value('VALUE', 'Number'),
    ],
    inputsInline: true,
    output: 'Number',
    style: 'jx_math',
    tooltip: 'A function of one number.',
  },

  // ── Summaries ────────────────────────────────────────────────────────────
  {
    type: 'jx_aggregate',
    message0: '%1 of %2',
    args0: [
      choice('OP', [
        ['sum', 'SUM'],
        ['average', 'AVG'],
        ['minimum', 'MIN'],
        ['maximum', 'MAX'],
        ['count', 'COUNT'],
        ['distinct count', 'DISTINCT'],
      ]),
      value('VALUE'),
    ],
    inputsInline: true,
    output: 'Number',
    style: 'jx_summary',
    tooltip: 'Summarizes several values into one: all the values a path reaches, the results of a loop, or, inside a group, a value across the rows of the group.',
  },
  {
    type: 'jx_count_records',
    message0: 'number of rows',
    output: 'Number',
    style: 'jx_summary',
    tooltip: 'Inside “group by” or “summarize”: how many rows there are.',
  },
  {
    type: 'jx_nth',
    message0: '%1 of %2',
    args0: [
      choice('WHICH', [
        ['first', 'FIRST'],
        ['last', 'LAST'],
      ]),
      value('VALUE'),
    ],
    inputsInline: true,
    output: null,
    style: 'jx_summary',
    tooltip: 'The first or last of several values.',
  },

  // ── Logic ────────────────────────────────────────────────────────────────
  {
    type: 'jx_compare',
    message0: '%1 %2 %3',
    args0: [
      value('A'),
      choice('OP', [
        ['=', 'EQ'],
        ['≠', 'NEQ'],
        ['<', 'LT'],
        ['≤', 'LTE'],
        ['>', 'GT'],
        ['≥', 'GTE'],
      ]),
      value('B'),
    ],
    inputsInline: true,
    output: 'Boolean',
    style: 'jx_logic',
    tooltip: 'Compares two values.',
  },
  {
    type: 'jx_logic',
    message0: '%1 %2 %3',
    args0: [
      value('A', 'Boolean'),
      choice('OP', [
        ['and', 'AND'],
        ['or', 'OR'],
      ]),
      value('B', 'Boolean'),
    ],
    inputsInline: true,
    output: 'Boolean',
    style: 'jx_logic',
    tooltip: 'Combines two conditions.',
  },
  { type: 'jx_not', message0: 'not %1', args0: [value('VALUE', 'Boolean')], inputsInline: true, output: 'Boolean', style: 'jx_logic', tooltip: 'True when the condition is false.' },
  {
    type: 'jx_exists',
    message0: '%1 exists',
    args0: [value('VALUE')],
    inputsInline: true,
    output: 'Boolean',
    style: 'jx_logic',
    tooltip: 'True when the value is present. Useful for fields that only some records have.',
  },
  {
    type: 'jx_ternary',
    message0: 'if %1 then %2 else %3',
    args0: [value('IF', 'Boolean'), value('THEN'), value('ELSE')],
    inputsInline: true,
    output: null,
    style: 'jx_logic',
    tooltip: 'One value or another, depending on a condition. Leave “else” empty for “nothing”.',
  },
  {
    type: 'jx_default',
    message0: '%1 or if missing %2',
    args0: [value('VALUE'), value('DEFAULT')],
    inputsInline: true,
    output: null,
    style: 'jx_logic',
    tooltip: 'The first value, or the second when the first is missing.',
  },

  // ── Text ─────────────────────────────────────────────────────────────────
  { type: 'jx_concat', message0: 'join %1 %2', args0: [value('A'), value('B')], inputsInline: true, output: 'String', style: 'jx_text', tooltip: 'Joins two values into one text.' },
  {
    type: 'jx_contains',
    message0: '%1 contains %2',
    args0: [value('A', 'String'), value('B', 'String')],
    inputsInline: true,
    output: 'Boolean',
    style: 'jx_text',
    tooltip: 'True when the first text contains the second.',
  },
  {
    type: 'jx_string_op',
    message0: '%1 %2',
    args0: [
      choice('OP', [
        ['lowercase', 'LOWER'],
        ['uppercase', 'UPPER'],
        ['trim', 'TRIM'],
        ['length of', 'LENGTH'],
      ]),
      value('VALUE', 'String'),
    ],
    inputsInline: true,
    output: null,
    style: 'jx_text',
    tooltip: 'A function of one text.',
  },
  { type: 'jx_to_number', message0: 'as number %1', args0: [value('VALUE')], inputsInline: true, output: 'Number', style: 'jx_text', tooltip: 'Reads a text as a number.' },
  { type: 'jx_to_string', message0: 'as text %1', args0: [value('VALUE')], inputsInline: true, output: 'String', style: 'jx_text', tooltip: 'Writes a value as text.' },

  // ── Objects & lists ──────────────────────────────────────────────────────
  {
    type: 'jx_entries_each',
    message0: 'for each entry of %1',
    args0: [value('OBJ')],
    message1: 'where %1',
    args1: [value('WHERE', 'Boolean')],
    message2: 'get %1',
    args2: [value('GET')],
    inputsInline: false,
    output: 'Array',
    style: 'jx_collection',
    tooltip:
      'For an object used as a dictionary: goes through its entries and collects a value for each. Inside, “entry key” and “entry value” stand for the current entry. “where” is optional.',
  },
  { type: 'jx_entry_key', message0: 'entry key', output: 'String', style: 'jx_collection', tooltip: 'The key of the current entry, inside “for each entry”.' },
  {
    type: 'jx_entry_value',
    message0: 'entry value %1',
    args0: [path('itself')],
    output: null,
    style: 'jx_collection',
    tooltip: 'The value of the current entry, or a field inside it, inside “for each entry”.',
  },
  {
    type: 'jx_items_each',
    message0: 'for each item of %1',
    args0: [value('LIST')],
    message1: 'where %1',
    args1: [value('WHERE', 'Boolean')],
    message2: 'get %1',
    args2: [value('GET')],
    inputsInline: false,
    output: 'Array',
    style: 'jx_collection',
    tooltip: 'Goes through the items of a list and collects a value for each. Inside, “item” stands for the current item. “where” is optional.',
  },
  {
    type: 'jx_item',
    message0: 'item %1',
    args0: [path('itself')],
    output: null,
    style: 'jx_collection',
    tooltip: 'The current item, or a field inside it, inside “for each item”.',
  },
  { type: 'jx_item_index', message0: 'item index', output: 'Number', style: 'jx_collection', tooltip: 'The position of the current item, starting at 0, inside “for each item”.' },
  { type: 'jx_keys', message0: 'keys of %1', args0: [value('VALUE')], inputsInline: true, output: 'Array', style: 'jx_collection', tooltip: 'The keys of an object.' },

  // ── Dates ────────────────────────────────────────────────────────────────
  {
    type: 'jx_date_epoch',
    message0: 'date from %1 %2',
    args0: [
      choice('UNIT', [
        ['seconds', 'S'],
        ['milliseconds', 'MS'],
      ]),
      value('VALUE', 'Number'),
    ],
    inputsInline: true,
    output: 'String',
    style: 'jx_date',
    tooltip: 'Turns a Unix timestamp into a date, so charts can put it on a time axis.',
  },
  {
    type: 'jx_date_trunc',
    message0: '%1 to the %2',
    args0: [
      value('VALUE', 'String'),
      choice('UNIT', [
        ['year', '4'],
        ['month', '7'],
        ['day', '10'],
        ['hour', '13'],
        ['minute', '16'],
      ]),
    ],
    inputsInline: true,
    output: 'String',
    style: 'jx_date',
    tooltip: 'Cuts an ISO date (2026-10-12T07:34:00Z) down to its year, month, day… Handy as a “group by” key.',
  },

  // ── Advanced ─────────────────────────────────────────────────────────────
  { type: 'jx_raw', message0: 'JSONata %1', args0: [text('CODE', '')], output: null, style: 'jx_raw', tooltip: 'Any JSONata expression, evaluated for the current row.' },
];

/** A fresh workspace: just the root block. */
export const EMPTY_WORKSPACE = {
  blocks: { languageVersion: 0, blocks: [{ type: 'jx_query', x: 24, y: 24, deletable: false }] },
};
