/**
 * Environmental round modifiers — modern mode only.
 *
 * Registry + orchestration layer. Per-modifier implementations live in
 * sibling files (wildfire.ts, sinkhole.ts, etc.), mirroring the upgrades/ layout.
 * Selection uses the synced RNG for online determinism.
 */

import { FID } from "../shared/core/feature-defs.ts";
import {
  MODIFIER_FIRST_ROUND,
  MODIFIER_ROLL_CHANCE,
  type ModifierId,
} from "../shared/core/game-constants.ts";
import { IMPLEMENTED_MODIFIERS } from "../shared/core/modifier-defs.ts";
import { type GameState, hasFeature } from "../shared/core/types.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";
import { crumblingWallsImpl } from "./modifiers/crumbling-walls.ts";
import { dustStormImpl } from "./modifiers/dust-storm.ts";
import { dryLightningImpl, wildfireImpl } from "./modifiers/fire.ts";
import { fogOfWarImpl } from "./modifiers/fog-of-war.ts";
import { frostbiteImpl } from "./modifiers/frostbite.ts";
import { frozenRiverImpl } from "./modifiers/frozen-river.ts";
import { createGruntSurgeImpl } from "./modifiers/grunt-surge.ts";
import { highTideImpl } from "./modifiers/high-tide.ts";
import { lowWaterImpl } from "./modifiers/low-water.ts";
import type {
  ModifierImpl,
  ModifierTileData,
} from "./modifiers/modifier-types.ts";
import { rubbleClearingImpl } from "./modifiers/rubble-clearing.ts";
import { sinkholeImpl } from "./modifiers/sinkhole.ts";

export { applyDustStormJitter } from "./modifiers/dust-storm.ts";

/** Compile-time exhaustiveness: every ModifierId must have an impl entry. */
const MODIFIER_IMPLS = {
  wildfire: wildfireImpl,
  crumbling_walls: crumblingWallsImpl,
  grunt_surge: createGruntSurgeImpl(spawnGruntSurgeOnZone),
  frozen_river: frozenRiverImpl,
  sinkhole: sinkholeImpl,
  high_tide: highTideImpl,
  dust_storm: dustStormImpl,
  rubble_clearing: rubbleClearingImpl,
  low_water: lowWaterImpl,
  dry_lightning: dryLightningImpl,
  fog_of_war: fogOfWarImpl,
  frostbite: frostbiteImpl,
} as const satisfies Record<ModifierId, ModifierImpl>;
/** Registry map for dispatching modifier lifecycle hooks by id. */
export const MODIFIER_REGISTRY = new Map<ModifierId, ModifierImpl>(
  Object.entries(MODIFIER_IMPLS) as [ModifierId, ModifierImpl][],
);

/** Roll a modifier for the current round. Returns null if no modifier fires.
 *  Must be called at a deterministic point using state.rng for online sync. */
export function rollModifier(state: GameState): ModifierId | null {
  if (!hasFeature(state, FID.MODIFIERS)) return null;
  if (state.round < MODIFIER_FIRST_ROUND) return null;
  if (!state.rng.bool(MODIFIER_ROLL_CHANCE)) return null;

  const candidates = IMPLEMENTED_MODIFIERS.filter(
    (mod) => mod.id !== state.modern?.lastModifierId,
  );
  if (candidates.length === 0) return null;

  const totalWeight = candidates.reduce((sum, mod) => sum + mod.weight, 0);
  let roll = state.rng.next() * totalWeight;
  for (const mod of candidates) {
    roll -= mod.weight;
    if (roll <= 0) return mod.id;
  }
  return candidates[candidates.length - 1]!.id;
}

/** Restore tile-mutating modifier state from checkpoint data (watcher +
 *  host-promotion path). Sets frozenTiles / highTideTiles / sinkholeTiles on
 *  state.modern from the checkpoint, then re-mutates the map tiles (which
 *  are regenerated from seed and thus need the modifier tiles reapplied).
 *
 *  No-op if the modifiers feature is not active for this match. */
export function applyCheckpointModifierTiles(
  state: GameState,
  data: ModifierTileData,
): void {
  if (!hasFeature(state, FID.MODIFIERS)) return;
  for (const impl of MODIFIER_REGISTRY.values()) {
    impl.restore?.(state, data);
  }
}

/** Clear all modifier temporary state (frozen tiles, high tide, low water).
 *  Called before each battle start. Each clear function is idempotent. */
export function clearActiveModifiers(state: GameState): void {
  for (const impl of MODIFIER_REGISTRY.values()) {
    impl.clear?.(state);
  }
}

/** Revert modifier tiles belonging to a specific zone during zone reset. */
export function resetModifierTilesForZone(
  state: GameState,
  zone: number,
): void {
  for (const impl of MODIFIER_REGISTRY.values()) {
    impl.zoneReset?.(state, zone);
  }
}
