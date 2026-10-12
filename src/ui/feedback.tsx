/** Toasts and confirmations: called from anywhere, rendered once by <Feedback />. */
import { useSyncExternalStore } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  settle(confirmed: boolean): void;
}

let toasts: Toast[] = [];
let confirmation: Confirmation | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismiss(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, message, kind }];
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4500);
}

/** Shows what went wrong to the reader instead of losing it in the console. */
export function toastError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  toast(context ? `${context}: ${message}` : message, 'error');
}

/** Asks before doing something that cannot be undone. */
export function confirm(options: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmation?.settle(false);
    confirmation = {
      ...options,
      danger: options.danger ?? false,
      settle(confirmed) {
        confirmation = null;
        emit();
        resolve(confirmed);
      },
    };
    emit();
  });
}

export function Feedback() {
  const shownToasts = useSyncExternalStore(subscribe, () => toasts);
  const pending = useSyncExternalStore(subscribe, () => confirmation);
  return (
    <>
      {pending && (
        <Dialog
          title={pending.title}
          size="small"
          onClose={() => pending.settle(false)}
          footer={
            <>
              <button type="button" className="button" onClick={() => pending.settle(false)}>
                Cancel
              </button>
              <button type="button" className={pending.danger ? 'button is-danger' : 'button is-primary'} onClick={() => pending.settle(true)} data-autofocus>
                {pending.confirmLabel}
              </button>
            </>
          }
        >
          <p className="dialog-text">{pending.message}</p>
        </Dialog>
      )}
      <div className="toasts" aria-live="polite">
        {shownToasts.map((item) => (
          <div key={item.id} className={`toast is-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}>
            {item.kind === 'error' && <Icon name="alert" />}
            <span>{item.message}</span>
            <button type="button" className="icon-button" onClick={() => dismiss(item.id)} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
