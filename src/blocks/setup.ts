/** One-time registration of the custom blocks and field with Blockly. */
import * as Blockly from 'blockly/core';
import * as English from 'blockly/msg/en';
import { BLOCK_DEFINITIONS } from './definitions';
import { FieldPath } from './fieldPath';

const PATH_FIELD = 'field_jx_path';

export function registerBlocks(): void {
  // Checked against Blockly's registry rather than a module flag, so re-running this
  // module (hot reload) does not register twice.
  if (Blockly.registry.hasItem(Blockly.registry.Type.FIELD, PATH_FIELD)) return;
  Blockly.setLocale(English as unknown as Record<string, string>);
  Blockly.fieldRegistry.register(PATH_FIELD, FieldPath);
  Blockly.common.defineBlocksWithJsonArray(BLOCK_DEFINITIONS);
}
