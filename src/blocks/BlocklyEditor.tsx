/** The block editor: a Blockly workspace that reports the query its blocks stand for. */
import * as Blockly from 'blockly/core';
import { useEffect, useRef } from 'react';
import type { SchemaNode } from '../data/schema';
import { type FileSchema, type Issue, analyzeFiles, setRootSchema } from './context';
import { EMPTY_WORKSPACE } from './definitions';
import { generateQuery } from './generator';
import { registerBlocks } from './setup';
import { rootBlock } from './structure';
import { blocklyTheme } from './theme';
import { FIELDS_CATEGORY, TOOLBOX, fieldsFlyout } from './toolbox';

export interface EditorChange {
  /** The blocks, as Blockly saves them. */
  workspace: unknown;
  query: string;
  /** File fields the query reads. */
  fields: string[];
  issues: Issue[];
}

interface Props {
  /** Blocks to start from. Read once, when the editor mounts. */
  initialWorkspace: unknown;
  /** Combined shape of the records being queried: what the field pickers offer. */
  schema: SchemaNode | undefined;
  /** The files being queried, each checked on its own for fields it lacks. */
  files: readonly FileSchema[];
  dark: boolean;
  onChange(change: EditorChange): void;
}

/** How long the blocks must be left alone before the query is regenerated. */
const SETTLE_MS = 200;

type ToolboxDefinition = NonNullable<Blockly.BlocklyOptions['toolbox']>;

function load(workspace: Blockly.Workspace, state: unknown): void {
  Blockly.serialization.workspaces.load(state as Record<string, unknown>, workspace, { recordUndo: false });
}

export default function BlocklyEditor({ initialWorkspace, schema, files, dark, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const report = useRef<() => void>(() => {});
  // The latest props, for callbacks created once.
  const latest = useRef({ onChange, schema, files, dark, initialWorkspace });
  latest.current = { onChange, schema, files, dark, initialWorkspace };

  useEffect(() => {
    registerBlocks();
    const workspace = Blockly.inject(host.current!, {
      toolbox: TOOLBOX as unknown as ToolboxDefinition,
      renderer: 'zelos',
      theme: blocklyTheme(latest.current.dark),
      media: `${import.meta.env.BASE_URL}blockly-media/`,
      sounds: false,
      trashcan: true,
      maxInstances: { jx_query: 1 },
      move: { scrollbars: true, drag: true, wheel: true },
      zoom: { controls: true, wheel: false, pinch: true, startScale: 0.85, minScale: 0.4, maxScale: 1.6, scaleSpeed: 1.15 },
    });
    workspaceRef.current = workspace;
    workspace.registerToolboxCategoryCallback(FIELDS_CATEGORY, fieldsFlyout as unknown as (workspace: Blockly.WorkspaceSvg) => Blockly.utils.toolbox.FlyoutDefinition);
    setRootSchema(workspace, latest.current.schema);

    Blockly.Events.disable();
    try {
      try {
        load(workspace, latest.current.initialWorkspace ?? EMPTY_WORKSPACE);
      } catch (error) {
        // Blocks saved by an incompatible version: start over rather than show nothing.
        console.error('Could not load the saved blocks', error);
        workspace.clear();
      }
      if (!rootBlock(workspace)) load(workspace, EMPTY_WORKSPACE);
    } finally {
      Blockly.Events.enable();
    }

    // Blocks that are not attached to the stack take no part in the query: gray them out.
    workspace.addChangeListener(Blockly.Events.disableOrphans);

    const shown = new WeakMap<Blockly.Block, string>();
    const showWarnings = (issues: Issue[]) => {
      const messages = new Map<string, string[]>();
      for (const issue of issues) messages.set(issue.blockId, [...(messages.get(issue.blockId) ?? []), issue.message]);
      // Warnings are decoration, not edits: keep them out of the undo history.
      Blockly.Events.disable();
      try {
        for (const block of workspace.getAllBlocks(false)) {
          const text = messages.get(block.id)?.join('\n') ?? '';
          if ((shown.get(block) ?? '') === text) continue;
          shown.set(block, text);
          block.setWarningText(text === '' ? null : text);
        }
      } finally {
        Blockly.Events.enable();
      }
    };

    report.current = () => {
      const analysis = analyzeFiles(workspace, latest.current.files);
      showWarnings(analysis.issues);
      latest.current.onChange({
        workspace: Blockly.serialization.workspaces.save(workspace),
        query: generateQuery(workspace),
        fields: analysis.fields,
        issues: analysis.issues,
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    workspace.addChangeListener((event) => {
      if (event.isUiEvent) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Mid-drag the tree is in flux; the drop fires another event.
        if (!workspace.isDragging()) report.current();
      }, SETTLE_MS);
    });
    report.current();

    const observer = new ResizeObserver(() => Blockly.svgResize(workspace));
    observer.observe(host.current!);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      report.current = () => {};
      workspaceRef.current = null;
      workspace.dispose();
    };
  }, []);

  useEffect(() => {
    workspaceRef.current?.setTheme(blocklyTheme(dark));
  }, [dark]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    setRootSchema(workspace, schema);
    // An open "Fields" flyout lists the old fields.
    workspace.refreshToolboxSelection();
    report.current();
  }, [schema]);

  return <div ref={host} className="blockly-host" />;
}
