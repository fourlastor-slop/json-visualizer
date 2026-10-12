/**
 * The current time, never the same twice. Things are listed in the order they were
 * created, and a batch of small uploads can be created within a single millisecond.
 */
let last = 0;

export function timestamp(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}
