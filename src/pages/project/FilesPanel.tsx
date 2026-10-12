/** The files of a project: upload, append, replace, rename, recolor, delete. */
import { type DragEvent, useRef, useState } from 'react';
import { SERIES_COUNT, SERIES_NAMES, seriesColor } from '../../data/colors';
import { addFile, appendToFile, deleteFile, renameFile, replaceFile, setFileColor, shuffleFileColors } from '../../data/store';
import type { DataFile, Project, Visualization } from '../../data/types';
import { formatBytes, plural } from '../../lib/format';
import { FileDot } from '../../ui/controls';
import { Dialog } from '../../ui/Dialog';
import { confirm, toast, toastError } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { NameDialog } from '../NameDialog';

interface Props {
  project: Project;
  files: DataFile[];
  visualizations: Visualization[];
  onInspect(file: DataFile): void;
}

type Collision = 'append' | 'replace' | 'keep' | 'skip';

const ACCEPT = '.json,.jsonl,.ndjson,application/json,application/x-ndjson,text/plain';

/** "name.jsonl" → "name (2).jsonl", skipping names already taken. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function FilesPanel({ project, files, visualizations, onInspect }: Props) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const action = useRef<{ file: DataFile; mode: 'append' | 'replace' } | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<DataFile | null>(null);
  const [collision, setCollision] = useState<{ existing: DataFile; settle(choice: Collision): void } | null>(null);

  const working = async (label: string, work: () => Promise<void>) => {
    setBusy((current) => [...current, label]);
    try {
      await work();
    } catch (error) {
      toastError(error, label);
    } finally {
      setBusy((current) => {
        const index = current.indexOf(label);
        return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
      });
    }
  };

  const upload = async (sources: File[]) => {
    // Names taken in this project, including by files added earlier in this batch.
    const byName = new Map(files.map((file) => [file.name, file]));
    for (const source of sources) {
      const existing = byName.get(source.name);
      const choice = existing ? await new Promise<Collision>((settle) => setCollision({ existing, settle })) : 'keep';
      setCollision(null);
      if (choice === 'skip') continue;
      await working(source.name, async () => {
        if (existing && choice === 'append') {
          const before = existing.records;
          const file = await appendToFile(existing.id, source);
          byName.set(file.name, file);
          toast(`Appended ${plural(file.records - before, 'record')} to ${file.name}.`);
        } else if (existing && choice === 'replace') {
          const file = await replaceFile(existing.id, source);
          byName.set(file.name, file);
          toast(`Replaced ${file.name}: ${plural(file.records, 'record')}.`);
        } else {
          const name = existing ? freeName(source.name, new Set(byName.keys())) : source.name;
          const file = await addFile(project.id, source, name);
          byName.set(file.name, file);
          toast(`Added ${file.name}: ${plural(file.records, 'record')}.`);
        }
      });
    }
  };

  const startAction = (file: DataFile, mode: 'append' | 'replace') => {
    action.current = { file, mode };
    actionInput.current?.click();
  };

  const runAction = async (source: File) => {
    const pending = action.current;
    action.current = null;
    if (!pending) return;
    const { file, mode } = pending;
    await working(file.name, async () => {
      if (mode === 'append') {
        const updated = await appendToFile(file.id, source);
        toast(`Appended ${plural(updated.records - file.records, 'record')} to ${file.name}.`);
      } else {
        const updated = await replaceFile(file.id, source);
        toast(`Replaced the contents of ${file.name}: ${plural(updated.records, 'record')}.`);
      }
    });
  };

  const remove = async (file: DataFile) => {
    const users = visualizations.filter((viz) => viz.fileIds.includes(file.id)).length;
    const confirmed = await confirm({
      title: `Delete “${file.name}”?`,
      message:
        users > 0
          ? `Its ${plural(file.records, 'record')} are deleted from this browser, and it is removed from the ${plural(users, 'visualization')} using it.`
          : `Its ${plural(file.records, 'record')} are deleted from this browser.`,
      confirmLabel: 'Delete file',
      danger: true,
    });
    if (confirmed) await deleteFile(file.id).catch((error) => toastError(error, 'Could not delete the file'));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) void upload(dropped);
  };

  return (
    <section
      className={dragging ? 'files is-dragging' : 'files'}
      aria-label="Files"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="section-head">
        <h2>Files</h2>
        <div className="section-actions">
          {files.length > 1 && (
            <button type="button" className="icon-button" onClick={() => void shuffleFileColors(project.id).catch((error) => toastError(error))} title="Shuffle colors: draw new random colors for these files" aria-label="Shuffle file colors">
              <Icon name="shuffle" />
            </button>
          )}
          <button type="button" className="button is-small" onClick={() => uploadInput.current?.click()}>
            <Icon name="upload" />
            Upload
          </button>
        </div>
      </div>

      <input
        ref={uploadInput}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (chosen.length > 0) void upload(chosen);
        }}
      />
      <input
        ref={actionInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void runAction(chosen);
        }}
      />

      {files.length === 0 && busy.length === 0 ? (
        <button type="button" className="dropzone" onClick={() => uploadInput.current?.click()}>
          <Icon name="upload" size={20} />
          <strong>Drop .json or .jsonl files here</strong>
          <span>or click to choose. They are stored in this browser only.</span>
        </button>
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.id} className="file-row">
              <Menu
                label={`Color of ${file.name}: ${SERIES_NAMES[file.color % SERIES_COUNT]}. Click to change.`}
                className="file-color"
                items={SERIES_NAMES.map((name, slot) => ({
                  label: name,
                  dot: seriesColor(slot),
                  checked: slot === file.color,
                  onSelect: () => void setFileColor(file.id, slot).catch((error) => toastError(error)),
                }))}
              >
                <FileDot color={file.color} />
              </Menu>
              <button type="button" className="file-main" onClick={() => onInspect(file)} title="Inspect fields and records">
                <span className="file-name">{file.name}</span>
                <span className="file-meta">
                  {plural(file.records, 'record')} · {formatBytes(file.size)}
                  {file.chunks > 1 ? ` · ${file.chunks - 1} ${file.chunks === 2 ? 'append' : 'appends'}` : ''}
                </span>
              </button>
              <Menu
                label={`Actions for ${file.name}`}
                items={[
                  { label: 'Inspect', icon: 'search', onSelect: () => onInspect(file) },
                  { label: 'Append data…', icon: 'append', onSelect: () => startAction(file, 'append') },
                  { label: 'Replace data…', icon: 'replace', onSelect: () => startAction(file, 'replace') },
                  { label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(file) },
                  { label: 'Delete', icon: 'trash', danger: true, separated: true, onSelect: () => void remove(file) },
                ]}
              />
            </li>
          ))}
          {busy.map((label, i) => (
            <li key={`${label}:${i}`} className="file-row is-busy">
              <span className="spinner" aria-hidden="true" />
              <span className="file-main">
                <span className="file-name">{label}</span>
                <span className="file-meta">Reading…</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && <p className="files-hint">Drop files anywhere in this panel to add them.</p>}

      {renaming && (
        <NameDialog
          title="Rename file"
          label="Name"
          initial={renaming.name}
          submitLabel="Rename"
          onSubmit={(name) => {
            void renameFile(renaming.id, name).catch((error) => toastError(error));
            setRenaming(null);
          }}
          onClose={() => setRenaming(null)}
        />
      )}

      {collision && (
        <Dialog
          title={`“${collision.existing.name}” is already in this project`}
          size="small"
          onClose={() => collision.settle('skip')}
          footer={
            <>
              <button type="button" className="button" onClick={() => collision.settle('skip')}>
                Skip
              </button>
              <button type="button" className="button" onClick={() => collision.settle('keep')}>
                Keep both
              </button>
              <button type="button" className="button" onClick={() => collision.settle('replace')}>
                Replace
              </button>
              <button type="button" className="button is-primary" onClick={() => collision.settle('append')} data-autofocus>
                Append
              </button>
            </>
          }
        >
          <p className="dialog-text">
            <strong>Append</strong> adds the new records after the {plural(collision.existing.records, 'record')} already there. <strong>Replace</strong> swaps the contents. Either way, the visualizations using the
            file keep working.
          </p>
        </Dialog>
      )}
    </section>
  );
}
