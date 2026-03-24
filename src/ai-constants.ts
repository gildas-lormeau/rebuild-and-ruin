/**
 * Shared AI strategy constants and helpers.
 *
 * Extracted from ai-strategy.ts so that sub-modules (ai-strategy-build,
 * ai-strategy-cannon, ai-strategy-battle) can import these without
 * creating circular dependencies back to the parent module.
 */

/** Look up a value from a 3-element table indexed by a 1-3 trait level. */

/** Interior pockets smaller than this are targeted for wall destruction / penalized in placement. */

export const SMALL_POCKET_MAX_SIZE = 4;

export function traitLookup<T>(level: number, values: readonly [T, T, T]): T {
  return values[level - 1]!;
}
