/** Asks for a name: used to create and to rename things. */
import { type FormEvent, useState } from 'react';
import { Field } from '../ui/controls';
import { Dialog } from '../ui/Dialog';

interface Props {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit(name: string): void;
  onClose(): void;
}

export function NameDialog({ title, label, initial = '', submitLabel, onSubmit, onClose }: Props) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') onSubmit(name.trim());
  };
  return (
    <Dialog
      title={title}
      size="small"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="name-dialog" className="button is-primary" disabled={name.trim() === ''}>
            {submitLabel}
          </button>
        </>
      }
    >
      <form id="name-dialog" onSubmit={submit}>
        <Field label={label}>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} data-autofocus onFocus={(event) => event.target.select()} />
        </Field>
      </form>
    </Dialog>
  );
}
