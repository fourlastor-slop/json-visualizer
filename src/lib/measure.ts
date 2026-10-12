/** Measuring text before it is drawn, to size axis margins and labels. */

let context: CanvasRenderingContext2D | null | undefined;

export const AXIS_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

export function textWidth(text: string, font = AXIS_FONT): number {
  if (context === undefined) {
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!context) return text.length * 6.2;
  context.font = font;
  return context.measureText(text).width;
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, Math.max(1, maxLength - 1)) + '…' : text;
}
