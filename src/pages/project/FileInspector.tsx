/** A look inside a file: the fields found in it, and its first records. */
import { useEffect, useMemo, useState } from 'react';
import { previewFile } from '../../data/client';
import type { Row } from '../../data/query';
import { type SchemaNode, childSchema, describeNode, keysOf } from '../../data/schema';
import { DEFAULT_TABLE, type DataFile } from '../../data/types';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import { FileDot, Segmented } from '../../ui/controls';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { DataTable } from '../../viz/DataTable';
import { buildTable } from '../../viz/tableModel';

const PREVIEW_ROWS = 200;
/** Keys listed per object before the rest is summarized. */
const MAX_KEYS = 300;

function SchemaRow({ name, node, parentObjects, depth }: { name: string; node: SchemaNode; parentObjects: number | undefined; depth: number }) {
  const keys = keysOf(node);
  const [open, setOpen] = useState(false);
  const { type, detail } = describeNode(node, parentObjects);
  const expandable = keys.length > 0;
  return (
    <>
      <li className="schema-row" style={{ paddingLeft: 8 + depth * 16 }}>
        {expandable ? (
          <button type="button" className="schema-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? `Collapse ${name}` : `Expand ${name}`}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
        ) : (
          <span className="schema-toggle" />
        )}
        <span className="schema-name">{name}</span>
        <span className="schema-type">{type}</span>
        <span className="schema-detail">{detail}</span>
      </li>
      {open && <SchemaLevel node={node} depth={depth + 1} />}
    </>
  );
}

function SchemaLevel({ node, depth }: { node: SchemaNode; depth: number }) {
  const keys = keysOf(node);
  // "In 8 of 960" only makes sense against the objects that could have had the key.
  const parentObjects = node.items ? undefined : node.types.object;
  return (
    <>
      {keys.slice(0, MAX_KEYS).map((key) => {
        const child = childSchema(node, key);
        return child ? <SchemaRow key={key} name={key} node={child} parentObjects={parentObjects} depth={depth} /> : null;
      })}
      {keys.length > MAX_KEYS && (
        <li className="schema-row is-note" style={{ paddingLeft: 8 + depth * 16 }}>
          …and {keys.length - MAX_KEYS} more keys
        </li>
      )}
    </>
  );
}

export function FileInspector({ file, onClose }: { file: DataFile; onClose(): void }) {
  const [tab, setTab] = useState<'fields' | 'records'>('fields');
  const [preview, setPreview] = useState<{ rows: Row[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setPreview(null);
    setError(null);
    previewFile(file.id, file.rev, 0, PREVIEW_ROWS).then(
      (result) => current && setPreview(result),
      (reason: unknown) => current && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      current = false;
    };
  }, [file.id, file.rev]);

  const table = useMemo(() => (preview ? buildTable([{ id: file.id, label: file.name, color: file.color, rows: preview.rows }], DEFAULT_TABLE) : null), [preview, file.id, file.name, file.color]);
  const fieldCount = keysOf(file.schema).length;

  return (
    <Dialog title={file.name} size="large" onClose={onClose}>
      <div className="inspector-meta">
        <FileDot color={file.color} />
        <span>
          {plural(file.records, 'record')} · {plural(fieldCount, 'top-level field')} · {formatBytes(file.size)} · updated {formatDateTime(file.updatedAt)}
        </span>
        <Segmented<'fields' | 'records'>
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'fields', label: 'Fields' },
            { value: 'records', label: 'Records' },
          ]}
        />
      </div>
      {tab === 'fields' ? (
        fieldCount === 0 ? (
          <p className="viz-message">The records of this file are not objects, so they have no fields.</p>
        ) : (
          <ul className="schema" aria-label="Fields">
            <SchemaLevel node={file.schema} depth={0} />
          </ul>
        )
      ) : error ? (
        <div className="viz-error" role="alert">
          <span>{error}</span>
        </div>
      ) : !table ? (
        <p className="viz-message is-quiet">Reading…</p>
      ) : (
        <>
          <DataTable table={table} height={440} />
          {preview && preview.total > preview.rows.length && (
            <p className="chart-note">
              The first {preview.rows.length} of {plural(preview.total, 'record')}.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
