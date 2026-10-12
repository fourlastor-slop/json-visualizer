/** A modal dialog on the native <dialog>, which brings focus trapping and Escape for free. */
import { type ReactNode, useEffect, useRef } from 'react';
import { Icon } from './Icon';

interface Props {
  title: string;
  /** Called when the dialog is dismissed: Escape, the close button, or a click outside. */
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'small' | 'medium' | 'large';
}

/** Mount it to open it; unmount it to close it. */
export function Dialog({ title, onClose, children, footer, size = 'medium' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // showModal() focuses the first focusable element, which is the close button. React
    // does not render the `autofocus` attribute, so the element to start on is marked
    // with data-autofocus instead.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog is-${size}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        // A press on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-box">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
