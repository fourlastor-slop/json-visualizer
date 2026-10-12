/** A button that opens a small menu of actions. */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** A color swatch shown instead of an icon. */
  dot?: string;
  /** Marks the current choice in a menu of options. */
  checked?: boolean;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a rule above this item. */
  separated?: boolean;
}

interface Props {
  /** Accessible name of the trigger. */
  label: string;
  items: MenuItem[];
  /** Trigger contents; a "more" icon by default. */
  children?: ReactNode;
  className?: string;
}

export function Menu({ label, items, children, className = 'icon-button' }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Placed and focused before the first paint. The position is written straight to the
  // element: the menu has to be visible to take focus, so it cannot wait, hidden, for a
  // second render to position it.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const size = menu.current.getBoundingClientRect();
    // Below the trigger, right edges aligned; flipped or shifted to stay on screen.
    const top = anchor.bottom + 4 + size.height > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - size.height) : anchor.bottom + 4;
    const left = Math.min(Math.max(8, anchor.right - size.width), window.innerWidth - size.width - 8);
    menu.current.style.top = `${top}px`;
    menu.current.style.left = `${left}px`;
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    // Escape closes the menu wherever the focus happens to be.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') {
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'ArrowDown') {
      buttons[(current + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      buttons[(current - 1 + buttons.length) % buttons.length]?.focus();
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <>
      <button ref={trigger} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen((value) => !value)}>
        {children ?? <Icon name="more" />}
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="menu" role="menu" onKeyDown={onKeyDown}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? ' is-danger' : ''}${item.separated ? ' is-separated' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} />}
                {item.dot && <span className="file-dot" style={{ background: item.dot }} aria-hidden="true" />}
                <span>{item.label}</span>
                {item.checked && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
