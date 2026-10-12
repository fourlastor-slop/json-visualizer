/** Formatting for display. Numbers use the JSON convention (a dot for decimals) everywhere. */

const LOCALE = 'en-US';

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const threeDecimals = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 3 });
const fourSignificant = new Intl.NumberFormat(LOCALE, { maximumSignificantDigits: 4 });

/**
 * A data value with as many digits as are useful to read: 7,297,227 · 12,345.6 · 79.627 ·
 * 0.06341. Numbers below ten thousand get no thousands separator: many of them are years,
 * versions or ids, and "2,024" is not a year.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (Number.isInteger(n)) return abs < 10_000 ? String(n) : integer.format(n);
  if (abs >= 10_000) return oneDecimal.format(n);
  if (abs >= 1000) return String(Math.round(n * 10) / 10);
  if (abs >= 1) return threeDecimals.format(n);
  if (abs >= 0.0001) return fourSignificant.format(n);
  return n.toExponential(2);
}

/** A count in running text, always with thousands separators: 1,920 rows. */
export function formatCount(n: number): string {
  return integer.format(n);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : oneDecimal.format(value)} ${units[unit]}`;
}

/** "1 record", "960 records". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(timestamp: number): string {
  return dateTime.format(timestamp);
}

/** "just now", "5 min ago", "3 h ago", then a date. */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return dateTime.format(timestamp);
}

/** A compact one-line rendering of any JSON value, for table cells and tooltips. */
export function formatValue(value: unknown, maxLength = 80): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const json = JSON.stringify(value);
  return json.length > maxLength ? json.slice(0, maxLength - 1) + '…' : json;
}

/** File name without its extension. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.(jsonl?|ndjson|jsonlines)$/i, '');
}
