/** Turning uploaded text into records. */

export type SourceFormat = 'json' | 'jsonl';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface ParsedSource {
  format: SourceFormat;
  records: unknown[];
}

/** Guesses the format from a file name; `null` when the extension says nothing. */
export function formatFromName(name: string): SourceFormat | null {
  const lower = name.toLowerCase();
  if (/\.(jsonl|ndjson|jsonlines)$/.test(lower)) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ParseError(`Not valid JSON: ${messageOf(error)}`);
  }
  // A top-level list is a list of records; anything else is a single record.
  return Array.isArray(value) ? value : [value];
}

function parseJsonLines(text: string): unknown[] {
  const records: unknown[] = [];
  let start = 0;
  let lineNumber = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    lineNumber++;
    const line = text.slice(start, end).trim();
    if (line !== '') {
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        throw new ParseError(`Line ${lineNumber} is not valid JSON: ${messageOf(error)}`);
      }
    }
    start = end + 1;
  }
  return records;
}

const PARSERS: Record<SourceFormat, (text: string) => unknown[]> = { json: parseJson, jsonl: parseJsonLines };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Re-parses text that was already accepted once, in its known format. */
export function parseStored(text: string, format: SourceFormat): unknown[] {
  return PARSERS[format](stripBom(text));
}

/**
 * Parses an upload. The hint (usually from the file extension) is tried first, but a
 * `.json` file holding JSON Lines, or the reverse, is accepted too.
 */
export function parseSource(text: string, hint: SourceFormat | null): ParsedSource {
  const body = stripBom(text);
  if (body.trim() === '') throw new ParseError('The file is empty.');

  const first: SourceFormat = hint ?? 'json';
  const second: SourceFormat = first === 'json' ? 'jsonl' : 'json';
  const errors: Partial<Record<SourceFormat, unknown>> = {};
  for (const format of [first, second]) {
    try {
      const records = PARSERS[format](body);
      // A one-line file holding a JSON list is a list of records, whatever its extension.
      if (format === 'jsonl' && records.length === 1 && Array.isArray(records[0])) {
        return { format: 'json', records: records[0] };
      }
      return { format, records };
    } catch (error) {
      errors[format] = error;
    }
  }
  // Neither worked. Report the error for the format the file most resembles: if its first
  // line is a complete JSON value on its own, it was meant as JSON Lines.
  throw errors[looksLikeJsonLines(body) ? 'jsonl' : 'json'];
}

function looksLikeJsonLines(body: string): boolean {
  const firstLine = body.trimStart().split('\n', 1)[0] ?? '';
  try {
    JSON.parse(firstLine);
    return true;
  } catch {
    return false;
  }
}
