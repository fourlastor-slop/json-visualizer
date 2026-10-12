/**
 * A Blockly field holding a path into a record. Clicking it opens a picker listing the
 * fields that exist at the block's position, taken from the files being queried.
 */
import * as Blockly from 'blockly/core';
import { type Path, formatSegment } from '../data/schema';
import { fieldScope } from './context';
import { decodePath, encodePath } from './path';
import { PathPicker } from './pathPicker';

export interface FieldPathConfig extends Blockly.FieldConfig {
  /** Text shown while no path is chosen. */
  emptyLabel?: string;
}

const MAX_LABEL_LENGTH = 64;

/** "a ▸ b ▸ c", dropping middle segments of long paths so the leaf stays readable. */
function abbreviate(path: Path): string {
  const parts = path.map(formatSegment);
  const full = parts.join(' ▸ ');
  if (full.length <= MAX_LABEL_LENGTH || parts.length <= 2) return full;
  let tail = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i > 0; i--) {
    const longer = `${parts[i]} ▸ ${tail}`;
    if (parts[0]!.length + longer.length + 7 > MAX_LABEL_LENGTH) break;
    tail = longer;
  }
  return `${parts[0]} ▸ … ▸ ${tail}`;
}

const ROOT_LABELS: Record<string, string> = { jx_entry_value: 'entry value', jx_item: 'item' };

export class FieldPath extends Blockly.Field<string> {
  override EDITABLE = true;
  override SERIALIZABLE = true;
  override maxDisplayLength = 120;
  private emptyLabel = 'select field';
  private picker: PathPicker | null = null;

  constructor(value?: string | typeof Blockly.Field.SKIP_SETUP, validator?: Blockly.FieldValidator<string> | null, config?: FieldPathConfig) {
    super(Blockly.Field.SKIP_SETUP);
    if (value === Blockly.Field.SKIP_SETUP) return;
    if (config) this.configure_(config);
    this.setValue(value ?? '[]');
    if (validator) this.setValidator(validator);
  }

  static override fromJson(options: FieldPathConfig): FieldPath {
    return new this(undefined, undefined, options);
  }

  protected override configure_(config: FieldPathConfig): void {
    super.configure_(config);
    if (config.emptyLabel) this.emptyLabel = config.emptyLabel;
  }

  getPath(): Path {
    return decodePath(this.getValue());
  }

  protected override doClassValidation_(newValue?: unknown): string | null {
    return encodePath(decodePath(newValue));
  }

  protected override getText_(): string | null {
    const path = this.getPath();
    return `${path.length > 0 ? abbreviate(path) : this.emptyLabel} ▾`;
  }

  protected override initView(): void {
    super.initView();
    // Borrow the look of Blockly's own dropdowns.
    this.borderRect_?.classList.add('blocklyDropdownRect');
    this.textElement_?.classList.add('blocklyDropdownText');
  }

  override applyColour(): void {
    const block = this.getSourceBlock() as Blockly.BlockSvg | null;
    if (!block || !this.borderRect_) return;
    this.borderRect_.setAttribute('stroke', block.getColourTertiary());
    this.borderRect_.setAttribute('fill', this.picker ? block.getColourTertiary() : 'transparent');
  }

  protected override showEditor_(): void {
    const block = this.getSourceBlock();
    if (!block) return;
    const scope = fieldScope(block);

    // The dropdown opens below the field, or above it: whichever has more room.
    const frame = (block.workspace as Blockly.WorkspaceSvg).getInjectionDiv().getBoundingClientRect();
    const box = this.getSvgRoot()?.getBoundingClientRect();
    const room = box ? Math.max(frame.bottom - box.bottom, box.top - frame.top) : undefined;

    Blockly.DropDownDiv.clearContent();
    this.picker = new PathPicker({
      schema: scope.schema,
      rootLabel: ROOT_LABELS[block.type] ?? 'row',
      value: this.getPath(),
      room,
      emptyHint: scope.outsideLoop
        ? `Put this block inside a “for each ${scope.outsideLoop === 'entries' ? 'entry' : 'item'}” block to see what it contains.`
        : undefined,
      onPick: (path) => {
        this.setValue(encodePath(path));
        Blockly.DropDownDiv.hideIfOwner<string>(this);
      },
      onCancel: () => Blockly.DropDownDiv.hideIfOwner<string>(this),
    });
    Blockly.DropDownDiv.getContentDiv().appendChild(this.picker.element);
    Blockly.DropDownDiv.setColour('var(--surface)', 'var(--border-strong)');
    Blockly.DropDownDiv.showPositionedByField<string>(this, () => {
      this.picker = null;
      this.applyColour();
    });
    this.applyColour();
    this.picker.focus();
  }
}
