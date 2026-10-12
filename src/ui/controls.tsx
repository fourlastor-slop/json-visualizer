/** Small form controls shared by the pages. */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { seriesColor } from '../data/colors';
import { Icon, type IconName } from './Icon';

/** A row of mutually exclusive options. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: IconName }>;
  onChange(value: T): void;
  /** Shows only icons for the options that are not chosen. Every option needs an icon. */
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'segmented is-compact' : 'segmented'} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
          title={compact ? option.label : undefined}
          className={option.value === value ? 'is-on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <Icon name={option.icon} />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A heading that turns into a text box when clicked. */
export function EditableText({ value, onChange, label, className = '' }: { value: string; onChange(value: string): void; label: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null) input.current?.select();
    // Select once, when editing starts: not on every keystroke.
  }, [draft === null]);

  if (draft === null) {
    return (
      <button type="button" className={`editable ${className}`} onClick={() => setDraft(value)} title={`${label}: click to rename`}>
        <span>{value}</span>
        <Icon name="pencil" size={13} />
      </button>
    );
  }
  const commit = () => {
    const next = draft.trim();
    setDraft(null);
    if (next !== '' && next !== value) onChange(next);
  };
  return (
    <input
      ref={input}
      className={`editable-input ${className}`}
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** The colored dot that stands for a file. */
export function FileDot({ color }: { color: number }) {
  return <span className="file-dot" style={{ background: seriesColor(color) }} aria-hidden="true" />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
