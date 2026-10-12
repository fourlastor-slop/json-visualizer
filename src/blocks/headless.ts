/** Compiling saved blocks without an editor on screen. */
import * as Blockly from 'blockly/core';
import type { SchemaNode } from '../data/schema';
import { type Analysis, type FileSchema, analyzeFiles, setRootSchema } from './context';
import { generateQuery } from './generator';
import { registerBlocks } from './setup';

export interface Compiled extends Analysis {
  query: string;
}

/**
 * Loads saved blocks into an off-screen workspace, generates their query and checks them
 * against a schema. This is how a template is tested against the files it is applied to.
 * Given the individual files as well, fields that only some of them lack are reported too.
 */
export function compileState(state: unknown, schema: SchemaNode | undefined, files: readonly FileSchema[] = []): Compiled {
  registerBlocks();
  const workspace = new Blockly.Workspace();
  Blockly.Events.disable();
  try {
    Blockly.serialization.workspaces.load(state as Record<string, unknown>, workspace, { recordUndo: false });
    setRootSchema(workspace, schema);
    return { query: generateQuery(workspace), ...analyzeFiles(workspace, files) };
  } finally {
    Blockly.Events.enable();
    workspace.dispose();
  }
}
