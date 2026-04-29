/** Shared types for modifier implementations. */

import type { GameState } from "../../shared/core/types.ts";

/** Result shape returned by every modifier's apply function. */
interface ModifierApplyResult {
  readonly changedTiles: readonly number[];
  readonly gruntsSpawned: number;
}

/** Hooks shared across all lifecycle variants. */
interface ModifierImplBase {
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
  /** Number of `state.rng.next()` calls this modifier performs per
   *  cannon fire while active. The host's local fire path (e.g.
   *  `applyDustStormJitter` inside `launchCannonball`) is responsible
   *  for actually consuming these draws to compute its modifier-
   *  specific effect. The wire-applied `applyCannonFired` mirrors the
   *  count via `consumeFireRngForActiveModifier(state)` so peers stay
   *  in lockstep without recomputing the (already wire-delivered)
   *  trajectory. Default 0 — most modifiers don't affect fires.
   *
   *  Contract: the host's local fire path must consume EXACTLY this
   *  many `state.rng.next()` calls per fire while the modifier is
   *  active. A unit test
   *  (`test/scenario.test.ts → modifier-fire-rng-contract`) asserts
   *  this for every modifier with `fireRngDraws > 0`. Currently
   *  declared by: dust_storm (1 draw — the jitter angle). */
  fireRngDraws?: number;
}

/** Instant modifier: side effects flow through normal game state at
 *  apply-time. No persistent modifier-owned state to clean up. */
export interface InstantModifier extends ModifierImplBase {
  readonly lifecycle: "instant";
}

/** Permanent modifier: state survives forever (or until zone reset).
 *  `restore` is required because the watcher rebuilds the map from seed
 *  and must reapply the mutation. */
export interface PermanentModifier extends ModifierImplBase {
  readonly lifecycle: "permanent";
  /** Restore tile-mutating state from checkpoint data and re-apply tile
   *  mutations on a map regenerated from seed. */
  restore(state: GameState, data: ModifierTileData): void;
  /** Revert modifier tiles belonging to a specific zone during zone reset. */
  zoneReset?(state: GameState, zone: number): void;
}

/** Round-scoped modifier: active from this round's BATTLE through next
 *  CANNON_PLACE, cleared just before the next modifier rolls. */
export interface RoundScopedModifier extends ModifierImplBase {
  readonly lifecycle: "round-scoped";
  /** Revert per-modifier state at next round's CANNON_PLACE-done.
   *  Idempotent. */
  clear(state: GameState): void;
  /** Restore tile-mutating state from checkpoint data and re-apply tile
   *  mutations on a map regenerated from seed. Optional — only needed
   *  when the modifier carries serializable state (see `needsCheckpoint`
   *  in modifier-defs.ts). */
  restore?(state: GameState, data: ModifierTileData): void;
  /** Revert modifier tiles belonging to a specific zone during zone reset. */
  zoneReset?(state: GameState, zone: number): void;
}

/** Discriminated union of all modifier impls. The `lifecycle` field
 *  tags each variant and the type system enforces that the right hooks
 *  are present (e.g. `clear` is required iff `lifecycle === "round-scoped"`). */
export type ModifierImpl =
  | InstantModifier
  | PermanentModifier
  | RoundScopedModifier;

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
