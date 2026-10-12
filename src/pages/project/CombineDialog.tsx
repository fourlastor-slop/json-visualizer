/** Asks whether uploads that differ only by a number in their name should become one file. */
import { useState } from 'react';
import type { NameGroup } from '../../data/grouping';
import { plural } from '../../lib/format';
import { Dialog } from '../../ui/Dialog';

interface Props {
  groups: Array<NameGroup<File>>;
  /** Called with the groups to combine: none to keep every file, null to call the upload off. */
  onSettle(combined: Array<NameGroup<File>> | null): void;
}

export function CombineDialog({ groups, onSettle }: Props) {
  const [chosen, setChosen] = useState<ReadonlySet<NameGroup<File>>>(() => new Set(groups));
  const toggle = (group: NameGroup<File>, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(group);
      else next.delete(group);
      return next;
    });

  return (
    <Dialog
      title={groups.length === 1 ? 'Combine these files into one?' : 'Combine files that go together?'}
      onClose={() => onSettle(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => onSettle(null)}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => onSettle([])}>
            Keep separate
          </button>
          <button type="button" className="button is-primary" disabled={chosen.size === 0} onClick={() => onSettle(groups.filter((group) => chosen.has(group)))} data-autofocus>
            Combine
          </button>
        </>
      }
    >
      <div className="form">
        <p className="dialog-text">
          {groups.length === 1 ? 'These files differ' : 'Some of these files differ'} only by a number in their name. Combined, they are <strong>one file</strong> with the records of all of them, in the order of the numbers, and{' '}
          <strong>one series</strong> in a chart. Kept separate, each file is a series of its own.
        </p>
        <ul className="check-list is-roomy">
          {groups.map((group) => (
            <li key={group.pattern}>
              <label className="check">
                <input type="checkbox" checked={chosen.has(group)} onChange={(event) => toggle(group, event.target.checked)} />
                <span className="check-lines">
                  <span className="check-label">{group.name}</span>
                  <span className="check-meta">
                    {plural(group.members.length, 'file')}: {group.pattern}, from {group.numbers[0]} to {group.numbers.at(-1)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
