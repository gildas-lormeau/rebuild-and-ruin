/**
 * Cyclic-index navigation — pure integer math shared by every "move a
 * selection cursor / cycle a value by ±1 with wraparound" site (options
 * menu cursor, settings value cyclers, controls-grid nav, upgrade-pick
 * focus).
 */

/** Advance a selection index by `delta` (a ±1 nav step) within `[0, count)`
 *  with wraparound. The single source for menu/cursor/value-cycler nav —
 *  replaces the hand-rolled `(index + delta + count) % count`, whose
 *  `+ count` term is easy to drop on the +1 branch (correct there only
 *  because +1 can't underflow), letting the two branches drift apart.
 *  `count` must be > 0 and `delta >= -count` (always true for ±1 steps). */

export function wrapIndex(index: number, delta: number, count: number): number {
  return (index + delta + count) % count;
}
