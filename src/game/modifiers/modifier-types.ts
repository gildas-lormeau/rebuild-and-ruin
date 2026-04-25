/** Shared types for modifier implementations. */

import type { GameState } from "../../shared/core/types.ts";

/** Result shape returned by every modifier's apply function. */
export interface ModifierApplyResult {
  readonly changedTiles: readonly number[];
  readonly gruntsSpawned: number;
}

/** Implementation hooks for a single modifier. Only `apply` is required;
 *  `clear` and `zoneReset` are needed only for modifiers that store
 *  temporary tile state (needsCheckpoint: true in the pool). */
export interface ModifierImpl {
  /** Apply the modifier at battle start. */
  apply(state: GameState): ModifierApplyResult;
  /** Opt-out flag: set `true` ONLY when the modifier provably leaves
   *  walls and tile passability untouched (no map mutation, no wall
   *  destruction, no grunt enclosure changes). The default — recheck —
   *  matches the watcher's `applyBattleStartCheckpoint`, which always
   *  recomputes territory after restoring modifier tiles. Forgetting to
   *  opt out is harmless (one extra recheck); forgetting to opt IN to a
   *  recheck on a tile-mutating modifier would silently desync host vs
   *  watcher territory. Default-on closes that footgun. */
  skipsRecheck?: boolean;
  /** Revert temporary state before the next battle. Idempotent. */
  clear?: (state: GameState) => void;
  /** Revert modifier tiles belonging to a specific zone during zone reset. */
  zoneReset?: (state: GameState, zone: number) => void;
  /** Restore tile-mutating state from checkpoint data and re-apply tile
   *  mutations on a map regenerated from seed. */
  restore?: (state: GameState, data: ModifierTileData) => void;
}

/** Checkpoint data shape — the subset of checkpoint fields this helper reads. */
export interface ModifierTileData {
  readonly frozenTiles?: readonly number[] | null;
  readonly highTideTiles?: readonly number[] | null;
  readonly sinkholeTiles?: readonly number[] | null;
  readonly lowWaterTiles?: readonly number[] | null;
  /** Grunt tile keys that have absorbed one frostbite hit. Not really tile
   *  state, but follows the same checkpoint round-trip as frozenTiles to keep
   *  host/watcher in sync mid-battle. */
  readonly chippedGrunts?: readonly number[] | null;
}
