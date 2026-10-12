/**
 * Finding the uploads that belong together. A run that writes one file per checkpoint
 * leaves names like run.0120.json, run.0240.json, …: the same name but for one number.
 * Combined into one file, in the order of the numbers, such a run is one series in a
 * chart instead of one per checkpoint.
 */

export interface NameGroup<T> {
  /** A name for the combined file: what the members share, without the number. */
  name: string;
  /** The members' names, with `*` where the number is. */
  pattern: string;
  /** The members in the order of their numbers, and the numbers as they are written. */
  members: T[];
  numbers: string[];
}

interface Parsed<T> {
  item: T;
  index: number;
  /** The name around its numbers: one more text than there are numbers. */
  texts: string[];
  numbers: string[];
  extension: string;
}

/** An extension is letters only: the ".0120" of "run.0120" is a number, not an extension. */
const EXTENSION = /\.[A-Za-z]{1,10}$/;
const SEPARATORS = '[._\\- ]';

function parse<T extends { name: string }>(item: T, index: number): Parsed<T> {
  const extension = EXTENSION.exec(item.name)?.[0] ?? '';
  const stem = extension === '' ? item.name : item.name.slice(0, -extension.length);
  return { item, index, texts: stem.split(/\d+/), numbers: stem.match(/\d+/g) ?? [], extension };
}

/** A number without its leading zeros: 0120 and 120 are the same number. */
const valueOf = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

/** Numbers of any length, compared as numbers. */
function compareNumbers(a: string, b: string): number {
  const [x, y] = [valueOf(a), valueOf(b)];
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** The name again, with something else in place of one of its numbers. */
function rebuild(parsed: Parsed<unknown>, position: number, replacement: string): string {
  let stem = parsed.texts[0]!;
  parsed.numbers.forEach((number, i) => {
    stem += (i === position ? replacement : number) + parsed.texts[i + 1]!;
  });
  return stem + parsed.extension;
}

/** The name without one of its numbers, and without the punctuation that set it apart. */
function nameWithout(parsed: Parsed<unknown>, position: number): string {
  let before = parsed.texts[0]!;
  for (let i = 0; i < position; i++) before += parsed.numbers[i]! + parsed.texts[i + 1]!;
  let after = parsed.texts[position + 1]!;
  for (let i = position + 1; i < parsed.numbers.length; i++) after += parsed.numbers[i]! + parsed.texts[i + 1]!;

  const trailing = new RegExp(`${SEPARATORS}+$`);
  const leading = new RegExp(`^${SEPARATORS}+`);
  // "run." + "" and "data_" + "_final": the separator before the number goes with it.
  let stem = trailing.test(before) && (after === '' || leading.test(after)) ? before.replace(trailing, '') + after : before + after;
  // "file (" + ")" leaves a pair of brackets around nothing.
  stem = stem.replace(/\s*(\(\s*\)|\[\s*\]|\{\s*\})/g, '');
  stem = stem.replace(leading, '').replace(trailing, '');
  return (stem === '' ? 'combined' : stem) + parsed.extension;
}

/**
 * Splits uploads into groups whose names differ only by a number, and the rest. Where
 * several numbers differ, the last one counts: run1.step2 and run1.step3 go together,
 * and apart from run2.step2.
 */
export function groupByNumber<T extends { name: string }>(items: readonly T[]): { groups: NameGroup<T>[]; rest: T[] } {
  // Names that are the same once their numbers are blanked out.
  const shapes = new Map<string, Array<Parsed<T>>>();
  items.forEach((item, index) => {
    const parsed = parse(item, index);
    const shape = [...parsed.texts, parsed.extension].join('\u0000');
    shapes.set(shape, [...(shapes.get(shape) ?? []), parsed]);
  });

  const found: Array<{ first: number; group: NameGroup<T> }> = [];
  const grouped = new Set<T>();
  for (const alike of shapes.values()) {
    const positions = alike[0]!.numbers.map((_, i) => i);
    const position = positions.findLast((i) => new Set(alike.map((parsed) => valueOf(parsed.numbers[i]!))).size > 1);
    if (position === undefined) continue;

    const byPattern = new Map<string, Array<Parsed<T>>>();
    for (const parsed of alike) {
      const pattern = rebuild(parsed, position, '*');
      byPattern.set(pattern, [...(byPattern.get(pattern) ?? []), parsed]);
    }
    for (const [pattern, members] of byPattern) {
      if (members.length < 2) continue;
      members.sort((a, b) => compareNumbers(a.numbers[position]!, b.numbers[position]!) || a.index - b.index);
      for (const member of members) grouped.add(member.item);
      found.push({
        first: Math.min(...members.map((member) => member.index)),
        group: { name: nameWithout(members[0]!, position), pattern, members: members.map((member) => member.item), numbers: members.map((member) => member.numbers[position]!) },
      });
    }
  }
  return { groups: found.sort((a, b) => a.first - b.first).map(({ group }) => group), rest: items.filter((item) => !grouped.has(item)) };
}

/** What becomes one file: one upload, or several whose records follow one another. */
export interface UploadUnit<T> {
  name: string;
  sources: T[];
}

/**
 * The files to make of some uploads, once it is decided which groups are combined. Each
 * combined group takes the place of its first member; everything else stays as it is.
 */
export function unitsOf<T extends { name: string }>(items: readonly T[], combined: ReadonlyArray<NameGroup<T>>): Array<UploadUnit<T>> {
  const groupOf = new Map<T, NameGroup<T>>();
  for (const group of combined) for (const member of group.members) groupOf.set(member, group);
  const placed = new Set<NameGroup<T>>();
  const units: Array<UploadUnit<T>> = [];
  for (const item of items) {
    const group = groupOf.get(item);
    if (!group) units.push({ name: item.name, sources: [item] });
    else if (!placed.has(group)) {
      placed.add(group);
      units.push({ name: group.name, sources: group.members });
    }
  }
  return units;
}

/** Names in the order a person would put them: file2 before file10. */
export const byNaturalName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
