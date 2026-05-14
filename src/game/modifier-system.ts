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
import {
  IMPLEMENTED_MODIFIERS,
  type SerializedModifierTiles,
} from "../shared/core/modifier-defs.ts";
import {
  type GameState,
  hasFeature,
  type ModifierImpl,
} from "../shared/core/types.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";
import { dustStormImpl } from "./modifiers/dust-storm.ts";
import { dryLightningImpl, wildfireImpl } from "./modifiers/fire.ts";
import { fogOfWarImpl } from "./modifiers/fog-of-war.ts";
import { frostbiteImpl } from "./modifiers/frostbite.ts";
import { frozenRiverImpl } from "./modifiers/frozen-river.ts";
import { createGruntSurgeImpl } from "./modifiers/grunt-surge.ts";
import { highTideImpl } from "./modifiers/high-tide.ts";
import { lowWaterImpl } from "./modifiers/low-water.ts";
import { rubbleClearingImpl } from "./modifiers/rubble-clearing.ts";
import { sapperImpl } from "./modifiers/sapper.ts";
import { sinkholeImpl } from "./modifiers/sinkhole.ts";
import { supplyShipImpl } from "./modifiers/supply-ship.ts";

/** Compile-time exhaustiveness: every ModifierId must have an impl entry. */
const MODIFIER_IMPLS = {
  wildfire: wildfireImpl,
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
  sapper: sapperImpl,
  supply_ship: supplyShipImpl,
} as const satisfies Record<ModifierId, ModifierImpl>;
/** Registry map for dispatching modifier lifecycle hooks by id. */
export const MODIFIER_REGISTRY = new Map<ModifierId, ModifierImpl>(
  Object.entries(MODIFIER_IMPLS) as [ModifierId, ModifierImpl][],
);

/** Roll a modifier for the current round. Returns null if no modifier fires.
 *  Must be called at a deterministic point using state.rng for online sync.
 *
 *  Test-only escape hatches (consumed from `state.testHooks`):
 *    - `forceModifier` set → returns that value (or null) immediately, no
 *      RNG consumption. Tests use this to pin a specific modifier.
 *    - `disabledModifiers` → those IDs are removed from the candidate pool
 *      before the weighted draw. RNG is still consumed (bool + draw on
 *      the reduced pool), so the surrounding RNG sequence is preserved
 *      modulo the smaller pool. */
export function rollModifier(state: GameState): ModifierId | null {
  if (!hasFeature(state, FID.MODIFIERS)) return null;
  if (state.round < MODIFIER_FIRST_ROUND) return null;
  if (state.testHooks?.forceModifier !== undefined) {
    return state.testHooks.forceModifier;
  }
  if (!state.rng.bool(MODIFIER_ROLL_CHANCE)) return null;

  const disabled = state.testHooks?.disabledModifiers;
  const candidates = IMPLEMENTED_MODIFIERS.filter(
    (mod) =>
      mod.id !== state.modern?.lastModifierId && !disabled?.includes(mod.id),
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
 *  Skips `instant` impls (they have no persistent state to restore).
 *  No-op if the modifiers feature is not active for this match. */
export function applyCheckpointModifierTiles(
  state: GameState,
  data: SerializedModifierTiles,
): void {
  if (!hasFeature(state, FID.MODIFIERS)) return;
  for (const impl of MODIFIER_REGISTRY.values()) {
    if (impl.lifecycle === "instant") continue;
    impl.restore?.(state, data);
  }
}

/** Clear the active instant modifier at BATTLE_END. Called from
 *  `finalizeBattle` to let battle-only modifiers (dust-storm's jitter
 *  buffer, rubble-clearing's held snapshot) drop their state before the
 *  WALL_BUILD + next-CANNON_PLACE checkpoints carry it. No-op for
 *  modifiers without a `clear` or when the modifiers feature is inactive.
 *  Round-scoped clears fire later, via `clearActiveModifiers`. */
export function clearActiveInstantModifier(state: GameState): void {
  if (!hasFeature(state, FID.MODIFIERS)) return;
  const activeMod = state.modern?.activeModifier;
  if (!activeMod) return;
  const impl = MODIFIER_REGISTRY.get(activeMod);
  if (impl?.lifecycle === "instant") impl.clear?.(state);
}

/** Clear all round-scoped modifier state (frozen tiles, high tide, low
 *  water). Called from `prepareBattleState` (next round's CANNON_PLACE-done,
 *  just before `rollModifier`) so each round-scoped modifier is active for
 *  exactly one round (its battle through next CANNON_PLACE). Instant +
 *  permanent modifiers are skipped — instant clears fire at BATTLE_END via
 *  `clearActiveInstantModifier`, permanent modifiers never clear. Each
 *  clear function is idempotent. */
export function clearActiveModifiers(state: GameState): void {
  for (const impl of MODIFIER_REGISTRY.values()) {
    if (impl.lifecycle === "round-scoped") impl.clear(state);
  }
}
