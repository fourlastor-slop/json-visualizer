/**
 * Series colors.
 *
 * Eight categorical hues, each with a light-surface and a dark-surface step. Every file gets
 * one of these slots at random, and keeps it: the same file is the same color in every chart.
 */

export const SERIES_COUNT = 8;

export const SERIES_NAMES = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'] as const;

export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

/** CSS color for a slot; resolves to the light or dark step with the active theme. */
export function seriesColor(slot: number): string {
  return `var(--series-${(((slot % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT) + 1})`;
}

/**
 * How well two slots can be told apart, for every pair, in the worse of the two themes:
 * min(ΔE / 15, ΔE under simulated protanopia or deuteranopia / 8), with ΔE the OKLab
 * distance ×100. A score of 1 or more clears both the normal-vision floor and the
 * color-vision-deficiency target; pairs like blue/violet or aqua/magenta collapse for
 * color-blind readers and score far below it.
 */
const SEPARATION: readonly (readonly number[])[] = [
  [0, 2.12, 1.4, 2.05, 1.63, 1.93, 0.24, 1.94],
  [2.12, 0, 1.15, 0.6, 0.77, 0.33, 1.8, 0.47],
  [1.4, 1.15, 0, 1.05, 0.19, 0.79, 1.64, 0.82],
  [2.05, 0.6, 1.05, 0, 1.28, 0.87, 1.84, 0.84],
  [1.63, 0.77, 0.19, 1.28, 0, 1.62, 1.32, 0.52],
  [1.93, 0.33, 0.79, 0.87, 1.62, 0, 2.27, 0.9],
  [0.24, 1.8, 1.64, 1.84, 1.32, 2.27, 0, 1.5],
  [1.94, 0.47, 0.82, 0.84, 0.52, 0.9, 1.5, 0],
];

export function separation(a: number, b: number): number {
  return SEPARATION[a]?.[b] ?? 0;
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/**
 * Draws a random slot for a new file that stays visibly different from the slots already
 * taken: uniformly among the free slots that are clearly separable from every taken one,
 * or, when there is no such slot, the free slot that is furthest from its nearest neighbor.
 * Once all eight are taken, the least-used slots are drawn from.
 */
export function pickSeriesSlot(taken: readonly number[], random: () => number = Math.random): number {
  const all = Array.from({ length: SERIES_COUNT }, (_, slot) => slot);
  const uses = all.map((slot) => taken.filter((t) => t === slot).length);
  const fewest = Math.min(...uses);
  const candidates = all.filter((slot) => uses[slot] === fewest);
  if (taken.length === 0 || fewest > 0) return pickRandom(candidates, random);

  const nearest = (slot: number) => Math.min(...taken.map((t) => separation(slot, t)));
  const clear = candidates.filter((slot) => nearest(slot) >= 1);
  if (clear.length > 0) return pickRandom(clear, random);

  const best = Math.max(...candidates.map(nearest));
  return pickRandom(
    candidates.filter((slot) => nearest(slot) === best),
    random,
  );
}

/** Random, mutually distinguishable slots for `count` files. */
export function pickSeriesSlots(count: number, random: () => number = Math.random): number[] {
  const slots: number[] = [];
  for (let i = 0; i < count; i++) slots.push(pickSeriesSlot(slots, random));
  return slots;
}

/** Stroke patterns that tell series apart when color is already spoken for. */
export const DASH_PATTERNS = ['', '7 4', '2 4', '9 4 2 4'] as const;
