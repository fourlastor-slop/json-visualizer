/**
 * The field picker: a small browser for the fields available at a block's position, with
 * search across every nested path. Plain DOM, because it lives inside Blockly's dropdown.
 */
import { type FlatPath, type Path, type SchemaNode, childSchema, describeNode, flattenPaths, formatSegment, hasKeys, keysOf, resolvePath } from '../data/schema';
import { formatCount } from '../lib/format';

export interface PathPickerOptions {
  /** Shape the path is relative to; undefined when nothing is known about it. */
  schema: SchemaNode | undefined;
  /** What the empty path stands for: "row", "entry value", "item". */
  rootLabel: string;
  value: Path;
  /** Shown instead of the list when there is nothing to pick from. */
  emptyHint?: string;
  /** Vertical space, in pixels, that the picker may take on screen. */
  room?: number;
  onPick(path: Path): void;
  onCancel(): void;
}

interface Row {
  path: Path;
  /** Leading part of the label, de-emphasized (the parent path in search results). */
  prefix: string;
  label: string;
  type: string;
  detail: string;
  /** Opens the next level instead of choosing. */
  drill: boolean;
  quiet?: boolean;
}

const MAX_KEYS_SHOWN = 400;
const MAX_RESULTS = 80;
/** Height of the list, and of everything around it (search box, crumbs, the dropdown's frame). */
const LIST_HEIGHT = { min: 112, max: 264 };
const CHROME_HEIGHT = 130;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class PathPicker {
  readonly element: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly crumbs: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private level: Path;
  private rows: Row[] = [];
  private active = 0;
  private index: FlatPath[] | null = null;

  constructor(private readonly options: PathPickerOptions) {
    // Start where the current value lives, so its siblings are one click away.
    const parent = options.value.slice(0, -1);
    this.level = options.value.length > 0 && hasKeys(resolvePath(options.schema, parent)) ? parent : [];

    this.element = el('div', 'jx-picker');
    this.search = el('input', 'jx-picker-search');
    this.search.type = 'text';
    this.search.placeholder = 'Search fields…';
    this.search.spellcheck = false;
    this.search.autocomplete = 'off';
    this.search.setAttribute('aria-label', 'Search fields');
    this.crumbs = el('div', 'jx-picker-crumbs');
    this.list = el('div', 'jx-picker-list');
    this.list.setAttribute('role', 'listbox');
    // A fixed height, so the dropdown does not jump as the list changes; shorter when the
    // field sits where a full-size picker would not fit above or below it.
    const height = Math.min(LIST_HEIGHT.max, Math.max(LIST_HEIGHT.min, (options.room ?? Infinity) - CHROME_HEIGHT));
    this.list.style.height = `${height}px`;
    this.element.append(this.search, this.crumbs, this.list);

    this.search.addEventListener('input', () => {
      this.active = 0;
      this.render();
    });
    this.search.addEventListener('keydown', (event) => this.onKey(event));
    this.render();
    this.active = Math.max(0, this.rows.findIndex((row) => row.path.length === options.value.length && row.path.every((s, i) => s === options.value[i])));
    this.highlight();
  }

  /** Call once the picker is on screen: scrolls to the current value and takes focus. */
  focus(): void {
    this.highlight();
    this.search.focus({ preventScroll: true });
  }

  private get query(): string {
    return this.search.value.trim();
  }

  private browseRows(): Row[] {
    const { schema, rootLabel } = this.options;
    const node = resolvePath(schema, this.level);
    const rows: Row[] = [];
    const last = this.level[this.level.length - 1];
    rows.push({
      path: this.level,
      prefix: '',
      label: this.level.length === 0 ? `the whole ${rootLabel}` : `all of “${formatSegment(last ?? null)}”`,
      type: '',
      detail: '',
      drill: false,
      quiet: true,
    });
    const keys = keysOf(node);
    if (keys.length > 1) {
      const any = childSchema(node, null);
      rows.push({ path: [...this.level, null], prefix: '', label: '* any key', ...describeNode(any), drill: hasKeys(any), quiet: true });
    }
    const parentObjects = node && !node.items ? node.types.object : undefined;
    for (const key of keys.slice(0, MAX_KEYS_SHOWN)) {
      const child = childSchema(node, key);
      rows.push({ path: [...this.level, key], prefix: '', label: key, ...describeNode(child, parentObjects), drill: hasKeys(child) });
    }
    return rows;
  }

  private searchRows(query: string): Row[] {
    this.index ??= flattenPaths(this.options.schema);
    const needle = query.toLowerCase();
    const terms = needle.split(/[\s.▸]+/).filter(Boolean);
    const scored: Array<{ entry: FlatPath; score: number }> = [];
    for (const entry of this.index) {
      const full = entry.path.join('.').toLowerCase();
      if (!terms.every((term) => full.includes(term))) continue;
      // The last word typed is most likely the field itself; earlier ones narrow down where.
      const leaf = entry.path[entry.path.length - 1]!.toLowerCase();
      const wanted = terms[terms.length - 1] ?? needle;
      const score = leaf === wanted ? 0 : leaf.startsWith(wanted) ? 1 : leaf.includes(wanted) ? 2 : 3;
      scored.push({ entry, score: score * 100 + entry.path.length });
    }
    scored.sort((a, b) => a.score - b.score);
    const rows: Row[] = scored.slice(0, MAX_RESULTS).map(({ entry }) => ({
      path: entry.path,
      prefix: entry.path.slice(0, -1).map((segment) => `${segment} ▸ `).join(''),
      label: entry.path[entry.path.length - 1]!,
      ...describeNode(entry.node),
      drill: false,
    }));

    // Always allow a name typed by hand: schemas come from the data seen so far.
    const typed: Path = query
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '')
      .map((segment) => (segment === '*' ? null : segment));
    const exact = scored.some(({ entry }) => entry.path.length === typed.length && entry.path.every((s, i) => s === typed[i]));
    if (typed.length > 0 && !exact) {
      rows.push({ path: typed, prefix: '', label: `use “${typed.map(formatSegment).join(' ▸ ')}” as typed`, type: '', detail: '', drill: false, quiet: true });
    }
    return rows;
  }

  private render(): void {
    const query = this.query;
    this.rows = query === '' ? this.browseRows() : this.searchRows(query);

    this.crumbs.replaceChildren();
    this.crumbs.hidden = query !== '';
    const crumb = (label: string, target: Path, current: boolean) => {
      const button = el('button', 'jx-picker-crumb', label);
      button.type = 'button';
      button.disabled = current;
      button.addEventListener('click', () => this.open(target));
      return button;
    };
    this.crumbs.append(crumb(this.options.rootLabel, [], this.level.length === 0));
    this.level.forEach((segment, i) => {
      this.crumbs.append(el('span', 'jx-picker-sep', '▸'), crumb(formatSegment(segment), this.level.slice(0, i + 1), i === this.level.length - 1));
    });

    this.list.replaceChildren();
    this.rows.forEach((row, i) => {
      const button = el('button', 'jx-picker-row' + (row.quiet ? ' is-quiet' : ''));
      button.type = 'button';
      button.setAttribute('role', 'option');
      // The leaf is what tells two paths apart, so when space runs out it is the parent
      // path that gets cut, never the leaf.
      const name = el('span', 'jx-picker-name');
      if (row.prefix) name.append(el('span', 'jx-picker-prefix', row.prefix));
      name.append(el('span', 'jx-picker-leaf', row.label));
      button.title = row.prefix + row.label;
      button.append(name);
      if (row.detail) button.append(el('span', 'jx-picker-detail', row.detail));
      if (row.type) button.append(el('span', 'jx-picker-type', row.type));
      if (row.drill) button.append(el('span', 'jx-picker-drill', '›'));
      button.addEventListener('click', () => this.activate(row));
      button.addEventListener('pointermove', () => {
        if (this.active !== i) {
          this.active = i;
          this.highlight(false);
        }
      });
      this.list.append(button);
    });

    const hidden = keysOf(resolvePath(this.options.schema, this.level)).length - MAX_KEYS_SHOWN;
    if (query === '' && hidden > 0) this.list.append(el('div', 'jx-picker-note', `${formatCount(hidden)} more — search to find them`));
    if (query === '' && this.rows.length <= 1 && this.level.length === 0) {
      this.list.append(el('div', 'jx-picker-note', this.options.emptyHint ?? 'Field names are not known here. Type a name, with dots for nested fields, and press Enter.'));
    }
    if (query !== '' && this.rows.length === 0) this.list.append(el('div', 'jx-picker-note', 'No matching field.'));
    this.highlight();
  }

  private highlight(scroll = true): void {
    this.active = Math.min(Math.max(0, this.active), Math.max(0, this.rows.length - 1));
    Array.from(this.list.querySelectorAll('.jx-picker-row')).forEach((row, i) => {
      row.classList.toggle('is-active', i === this.active);
      row.setAttribute('aria-selected', String(i === this.active));
      if (scroll && i === this.active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  private open(level: Path): void {
    this.level = level;
    this.search.value = '';
    this.active = 0;
    this.render();
    this.focus();
  }

  private activate(row: Row): void {
    if (row.drill) this.open(row.path);
    else this.options.onPick(row.path);
  }

  private onKey(event: KeyboardEvent): void {
    const row = this.rows[this.active];
    switch (event.key) {
      case 'ArrowDown':
        this.active++;
        break;
      case 'ArrowUp':
        this.active--;
        break;
      case 'Enter':
        if (row) this.activate(row);
        break;
      case 'ArrowRight':
        if (!row?.drill || this.search.selectionStart !== this.search.value.length) return;
        this.open(row.path);
        break;
      case 'ArrowLeft':
      case 'Backspace':
        if (this.search.value !== '' || this.level.length === 0) return;
        this.open(this.level.slice(0, -1));
        break;
      case 'Escape':
        this.options.onCancel();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.highlight();
  }
}
