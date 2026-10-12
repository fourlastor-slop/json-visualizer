// Blockly loads its cursors, icons and sounds from a remote host unless told otherwise.
// Copy them next to the app so the site is fully self-contained.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'public/blockly-media');

mkdirSync(target, { recursive: true });
cpSync(resolve(root, 'node_modules/blockly/media'), target, { recursive: true });
