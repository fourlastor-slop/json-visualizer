/** Blockly themes matching the app's light and dark surfaces. */
import * as Blockly from 'blockly/core';

// Block colors, one per kind of block. Every one keeps white text at 4.5:1 or better.
const BLOCK_COLOURS = {
  jx_root: '#41403c',
  jx_step: '#2468b8',
  jx_column: '#0e7f67',
  jx_field: '#bd5118',
  jx_value: '#5f6672',
  jx_math: '#1f7a2e',
  jx_summary: '#5c4bc0',
  jx_logic: '#b3386f',
  jx_text: '#8a6200',
  jx_collection: '#12788f',
  jx_date: '#b04434',
  jx_raw: '#5c5a55',
} as const;

// On the dark workspace the two charcoal styles would sink into the background.
const DARK_OVERRIDES: Partial<Record<keyof typeof BLOCK_COLOURS, string>> = { jx_root: '#6b6963', jx_raw: '#716f69' };

const FONT = { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', weight: '500', size: 11 };

function define(name: string, dark: boolean): Blockly.Theme {
  const colours = dark ? { ...BLOCK_COLOURS, ...DARK_OVERRIDES } : BLOCK_COLOURS;
  const blockStyles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
  const categoryStyles: Record<string, Blockly.Theme.CategoryStyle> = {};
  for (const [style, colour] of Object.entries(colours)) {
    blockStyles[style] = style === 'jx_root' ? { colourPrimary: colour, hat: 'cap' } : { colourPrimary: colour };
    categoryStyles[style] = { colour };
  }
  return Blockly.Theme.defineTheme(name, {
    name,
    base: Blockly.Themes.Zelos,
    blockStyles,
    categoryStyles,
    fontStyle: FONT,
    componentStyles: dark
      ? {
          workspaceBackgroundColour: '#141413',
          toolboxBackgroundColour: '#1a1a19',
          toolboxForegroundColour: '#c3c2b7',
          flyoutBackgroundColour: '#242423',
          flyoutForegroundColour: '#c3c2b7',
          flyoutOpacity: 1,
          scrollbarColour: '#52514e',
          scrollbarOpacity: 0.7,
          insertionMarkerColour: '#ffffff',
          insertionMarkerOpacity: 0.3,
          cursorColour: '#ffffff',
        }
      : {
          workspaceBackgroundColour: '#f4f3ef',
          toolboxBackgroundColour: '#fcfcfb',
          toolboxForegroundColour: '#52514e',
          flyoutBackgroundColour: '#eae9e4',
          flyoutForegroundColour: '#52514e',
          flyoutOpacity: 1,
          scrollbarColour: '#c3c2b7',
          scrollbarOpacity: 0.8,
          insertionMarkerColour: '#0b0b0b',
          insertionMarkerOpacity: 0.25,
          cursorColour: '#0b0b0b',
        },
  });
}

let themes: { light: Blockly.Theme; dark: Blockly.Theme } | null = null;

export function blocklyTheme(dark: boolean): Blockly.Theme {
  themes ??= { light: define('jx-light', false), dark: define('jx-dark', true) };
  return dark ? themes.dark : themes.light;
}
