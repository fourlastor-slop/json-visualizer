/** The "MCP server" dialog: the switch, what the connection is doing, and how to set a client up. */
import { useEffect, useMemo, useState } from 'react';
import { formatAgo } from '../lib/format';
import { Segmented } from '../ui/controls';
import { Dialog } from '../ui/Dialog';
import { confirm, toast, toastError } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { newToken } from './protocol';
import { BRIDGE_FILE, setupFor } from './setup';
import { type McpStatus, describeMcpStatus, retryMcp, updateMcpSettings, useMcpSettings, useMcpStatus } from './state';

/** The states in which trying again at once is worth offering, and what the button says. */
const RETRY_LABELS: Partial<Record<McpStatus['phase'], string>> = {
  waiting: 'Look again now',
  rejected: 'Look again now',
  forbidden: 'Look again now',
  blocked: 'Look again now',
  unanswered: 'Ask again',
  replaced: 'Connect here',
};

function Snippet({ text, label }: { text: string; label: string }) {
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied.'),
      (error: unknown) => toastError(error, 'Could not copy'),
    );
  };
  return (
    <div className="snippet">
      <pre className="code" tabIndex={0}>
        {text}
      </pre>
      <button type="button" className="icon-button" onClick={copy} title={`Copy ${label}`} aria-label={`Copy ${label}`}>
        <Icon name="copy" />
      </button>
    </div>
  );
}

function PortField({ port }: { port: number }) {
  const [draft, setDraft] = useState(String(port));
  useEffect(() => setDraft(String(port)), [port]);
  const next = Number(draft);
  const valid = Number.isInteger(next) && next >= 1024 && next <= 65535;
  const commit = () => {
    if (valid && next !== port) updateMcpSettings({ port: next });
    else setDraft(String(port));
  };
  return (
    <label className="field">
      <span className="field-label">Port</span>
      <input className="input" inputMode="numeric" value={draft} aria-invalid={!valid} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === 'Enter' && commit()} />
      <span className="field-hint">Where the bridge listens on this computer. Change it if another program uses it.</span>
    </label>
  );
}

export default function McpDialog({ onClose }: { onClose(): void }) {
  const settings = useMcpSettings();
  const status = useMcpStatus();
  const [client, setClient] = useState<'claude-code' | 'other'>('claude-code');
  const { tone, title, detail } = describeMcpStatus(status, settings);
  const setup = useMemo(() => setupFor(settings, location.href), [settings.port, settings.token]);

  // The setup below needs a pairing code to show, whether or not the switch is on yet.
  useEffect(() => {
    if (settings.token === '') updateMcpSettings({ token: newToken() });
  }, [settings.token]);

  const renewToken = async () => {
    const sure = await confirm({
      title: 'Make a new pairing code?',
      message: 'Clients set up with the current code stop working until you give them the new one.',
      confirmLabel: 'New code',
    });
    if (sure) updateMcpSettings({ token: newToken() });
  };

  return (
    <Dialog title="MCP server" onClose={onClose}>
      <div className="form">
        <p className="dialog-text">
          Lets an AI client that speaks the Model Context Protocol, such as Claude Code, Claude Desktop or Cursor, work with your projects here: see your files and their fields, run queries on them, and read or add visualizations.
          It reaches this tab through a small program on your computer, the bridge.
        </p>

        <div className="mcp-power">
          <label className="switch">
            <input type="checkbox" role="switch" checked={settings.enabled} onChange={(event) => updateMcpSettings({ enabled: event.target.checked })} data-autofocus />
            <span>Let MCP clients reach this browser</span>
          </label>
          <div className="mcp-status" role="status">
            <span className={`status-dot is-${tone}`} aria-hidden="true" />
            <div>
              <strong>{title}</strong>
              {detail && <p>{detail}</p>}
              {RETRY_LABELS[status.phase] && (
                <button type="button" className="button is-small" onClick={retryMcp}>
                  {RETRY_LABELS[status.phase]}
                </button>
              )}
            </div>
          </div>
        </div>

        <fieldset className="fieldset">
          <legend>Set up a client</legend>
          <ol className="steps">
            <li>
              <span>
                Save the bridge on your computer. It needs Node.js 22 or newer. Or{' '}
                <a href={setup.bridgeUrl} download={BRIDGE_FILE}>
                  download it
                </a>{' '}
                and put it where you like.
              </span>
              <Snippet text={setup.download} label="the download command" />
            </li>
            <li>
              <div className="steps-head">
                <span>Add it to your client.</span>
                <Segmented<'claude-code' | 'other'>
                  label="Client"
                  value={client}
                  onChange={setClient}
                  options={[
                    { value: 'claude-code', label: 'Claude Code' },
                    { value: 'other', label: 'Other clients' },
                  ]}
                />
              </div>
              {client === 'claude-code' ? (
                <Snippet text={setup.claudeCode} label="the command for Claude Code" />
              ) : (
                <>
                  <Snippet text={setup.json} label="the settings" />
                  <span className="field-hint">For the client’s MCP settings file, with the path changed to where you saved the bridge.</span>
                </>
              )}
            </li>
            <li>
              <span>Turn the switch on and keep this tab open. The client starts the bridge by itself; restart the client if it was already running.</span>
            </li>
          </ol>
        </fieldset>

        <details className="mcp-advanced">
          <summary>Pairing code and port</summary>
          <div className="form">
            <div className="field">
              <span className="field-label">Pairing code</span>
              <div className="mcp-token">
                <code>{settings.token}</code>
                <button type="button" className="button is-small" onClick={() => void renewToken()}>
                  New code
                </button>
              </div>
              <span className="field-hint">The bridge and this browser prove to each other that they have it, so that no other page or program can pose as either. It is part of the commands above.</span>
            </div>
            <PortField port={settings.port} />
          </div>
        </details>

        {status.calls.length > 0 && (
          <fieldset className="fieldset">
            <legend>Recent calls</legend>
            <ul className="mcp-calls">
              {status.calls.map((call) => (
                <li key={call.id}>
                  <code className="mcp-call-tool">{call.tool}</code>
                  <span className="mcp-call-about" title={call.about}>
                    {call.about}
                  </span>
                  <span className="mcp-call-meta">
                    {call.failed && <span className="chip is-warn">failed</span>}
                    {call.client ? `${call.client} · ` : ''}
                    {call.ms === null ? 'running…' : formatAgo(call.at)}
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        <p className="notice">
          What a client asks for leaves this browser: field names, query results and records go to the client and to the AI service behind it. A client can add visualizations; it cannot change or delete your files.
        </p>
      </div>
    </Dialog>
  );
}
