/**
 * Upgrade dispatcher — registry + orchestration layer.
 *
 * Per-upgrade implementations live in sibling files (upgrades/*.ts),
 * mirroring the modifiers/ layout. Registry-driven dispatch replaces
 * hardcoded per-upgrade imports for all hooks except ballSpeedMult
 * (which has cross-upgrade interaction logic between Rapid Fire and Mortar).
 */

import type { ImpactEvent } from "../shared/core/battle-events.ts";
import { FID } from "../shared/core/feature-defs.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { type ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerSeated, type Player } from "../shared/core/player-types.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/core/types.ts";
import {
  IMPLEMENTED_UPGRADES,
  type UpgradeId,
} from "../shared/core/upgrade-defs.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
import { architectImpl } from "./upgrades/architect.ts";
import { ceasefireImpl } from "./upgrades/ceasefire.ts";
import { clearTheFieldImpl } from "./upgrades/clear-the-field.ts";
import { conscriptionImpl } from "./upgrades/conscription.ts";
import { demolitionImpl } from "./upgrades/demolition.ts";
import { doubleTimeImpl } from "./upgrades/double-time.ts";
import { entombImpl } from "./upgrades/entomb.ts";
import { foundationsImpl } from "./upgrades/foundations.ts";
import { masterBuilderImpl } from "./upgrades/master-builder.ts";
import { mortarImpl, mortarSpeedMult } from "./upgrades/mortar.ts";
import { rapidEmplacementImpl } from "./upgrades/rapid-emplacement.ts";
import {
  rapidFireBallMult,
  rapidFireImpl,
  rapidFireOwns,
} from "./upgrades/rapid-fire.ts";
import { reclamationImpl } from "./upgrades/reclamation.ts";
import { reinforcedWallsImpl } from "./upgrades/reinforced-walls.ts";
import { restorationCrewImpl } from "./upgrades/restoration-crew.ts";
import { ricochetImpl } from "./upgrades/ricochet.ts";
import { salvageImpl } from "./upgrades/salvage.ts";
import { secondWindImpl } from "./upgrades/second-wind.ts";
import { shieldBatteryImpl } from "./upgrades/shield-battery.ts";
import { smallPiecesImpl } from "./upgrades/small-pieces.ts";
import { supplyDropImpl } from "./upgrades/supply-drop.ts";
import { territorialAmbitionImpl } from "./upgrades/territorial-ambition.ts";
import type {
  BattleStartCannonDeps,
  ConscriptionRespawnTarget,
  RicochetApplyBounce,
  UpgradeImpl,
} from "./upgrades/upgrade-types.ts";

/** Compile-time exhaustiveness: every UpgradeId must have an impl entry. */
const UPGRADE_IMPLS = {
  mortar: mortarImpl,
  rapid_fire: rapidFireImpl,
  ricochet: ricochetImpl,
  shield_battery: shieldBatteryImpl,
  reinforced_walls: reinforcedWallsImpl,
  master_builder: masterBuilderImpl,
  small_pieces: smallPiecesImpl,
  double_time: doubleTimeImpl,
  architect: architectImpl,
  foundations: foundationsImpl,
  reclamation: reclamationImpl,
  territorial_ambition: territorialAmbitionImpl,
  conscription: conscriptionImpl,
  salvage: salvageImpl,
  ceasefire: ceasefireImpl,
  supply_drop: supplyDropImpl,
  second_wind: secondWindImpl,
  demolition: demolitionImpl,
  clear_the_field: clearTheFieldImpl,
  restoration_crew: restorationCrewImpl,
  rapid_emplacement: rapidEmplacementImpl,
  entomb: entombImpl,
} as const satisfies Record<UpgradeId, UpgradeImpl>;
/** First round that triggers upgrade picks (modern mode). */
const UPGRADE_FIRST_ROUND = 3;
/** Number of upgrade choices offered per pick. */
const OFFER_COUNT = 3;
/** Registry map for dispatching upgrade lifecycle hooks by id. */
const UPGRADE_REGISTRY = new Map<UpgradeId, UpgradeImpl>(
  Object.entries(UPGRADE_IMPLS) as [UpgradeId, UpgradeImpl][],
);

/** True when this round's battle phase should be skipped entirely. */
export function shouldSkipBattle(state: GameState): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.shouldSkipBattle?.(state)) return true;
  }
  return false;
}

/** Whether this player is allowed to build this frame.
 *  Aggregates every upgrade that can gate a player's build tick. */
export function canBuildThisFrame(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.canBuildThisFrame && !impl.canBuildThisFrame(state, playerId))
      return false;
  }
  return true;
}

/** Build timer bonus contributed by active upgrades (additive). */
export function buildTimerBonus(state: GameState): number {
  let bonus = 0;
  for (const impl of UPGRADE_REGISTRY.values()) {
    bonus += impl.buildTimerBonus?.(state) ?? 0;
  }
  return bonus;
}

/** Cannonball speed multiplier for a firing cannon. Combines upgrade
 *  contributions (Rapid Fire) with cannon-mode effects (mortar). Encodes
 *  the design rule that Rapid Fire + Mortar cancel out to normal speed.
 *  Wired directly — cross-upgrade interaction doesn't fit the registry. */
export function ballSpeedMult(player: Player, isMortar: boolean): number {
  const hasRapidFire = rapidFireOwns(player);
  if (isMortar && hasRapidFire) return 1;
  if (isMortar) return mortarSpeedMult();
  return rapidFireBallMult(player);
}

/** True when a wall hit should be absorbed (wall survives this shot).
 *  Caller is responsible for emitting WALL_ABSORBED and marking the tile
 *  in damagedWalls via the event dispatch. */
export function shouldAbsorbWallHit(player: Player, tileKey: number): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.shouldAbsorbWallHit?.(player, tileKey)) return true;
  }
  return false;
}

/** End-of-build territory score multiplier for a player (multiplicative). */
export function territoryScoreMult(player: Player): number {
  let mult = 1;
  for (const impl of UPGRADE_REGISTRY.values()) {
    mult *= impl.territoryScoreMult?.(player) ?? 1;
  }
  return mult;
}

/** Extra cannon slots granted to a player by active upgrades (additive). */
export function cannonSlotsBonus(player: Player): number {
  let bonus = 0;
  for (const impl of UPGRADE_REGISTRY.values()) {
    bonus += impl.cannonSlotsBonus?.(player) ?? 0;
  }
  return bonus;
}

/** True when this player's build bag should draw from the small-piece
 *  sub-pool this round. Consumed by controller-types.ts's initBag. */
export function useSmallPieces(player: Player): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.useSmallPieces?.(player)) return true;
  }
  return false;
}

/** How many own-wall tiles this player may overlap with a single piece
 *  placement. Aggregates every upgrade that relaxes wall-overlap rules. */
export function wallOverlapAllowance(player: Player): number {
  let allowance = 0;
  for (const impl of UPGRADE_REGISTRY.values()) {
    allowance += impl.wallOverlapAllowance?.(player) ?? 0;
  }
  return allowance;
}

/** True when this player may place pieces on top of burning pits.
 *  Callers should skip the pit-block check when this returns true. */
export function canPlaceOverBurningPit(player: Player): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.canPlaceOverBurningPit?.(player)) return true;
  }
  return false;
}

/** True when this player may place pieces on top of grunts. Takes the
 *  players array because the only implementer (Entomb) is global. */
export function canPlaceOverGrunt(
  players: readonly Player[],
  player: Player,
): boolean {
  for (const impl of UPGRADE_REGISTRY.values()) {
    if (impl.canPlaceOverGrunt?.(players, player)) return true;
  }
  return false;
}

/** Post-placement hook: run upgrade-driven side effects triggered by a
 *  just-placed piece (e.g. Foundations extinguishing covered pits). */
export function onPiecePlaced(
  state: GameState,
  player: Player,
  pieceKeys: ReadonlySet<number>,
): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.onPiecePlaced?.(state, player, pieceKeys);
  }
}

/** Post-impact hook: run any follow-up impacts triggered by upgrades.
 *  Battle-system supplies `applyBounce`, which owns computeImpact +
 *  applyImpactEvent + emit machinery; the upgrade file owns the
 *  RNG-driven bounce geometry. */
export function onImpactResolved(
  state: GameState,
  shooterId: ValidPlayerSlot,
  hitRow: number,
  hitCol: number,
  initialImpactEvents: readonly ImpactEvent[],
  applyBounce: RicochetApplyBounce,
): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.onImpactResolved?.(
      state,
      shooterId,
      hitRow,
      hitCol,
      initialImpactEvents,
      applyBounce,
    );
  }
}

/** Post-grunt-kill hook: query upgrades for a replacement spawn target.
 *  Returns the victim's home-tower anchor so the caller can run
 *  findGruntSpawnNear from there. First non-null wins. */
export function onGruntKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): ConscriptionRespawnTarget | null {
  for (const impl of UPGRADE_REGISTRY.values()) {
    const result = impl.onGruntKilled?.(state, shooterId);
    if (result) return result;
  }
  return null;
}

/** Post-cannon-kill hook: award upgrade effects triggered when a shooter
 *  destroys an enemy cannon. */
export function onCannonKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.onCannonKilled?.(state, shooterId);
  }
}

/** Phase-boundary hook: configure upgrade state at the start of a build phase.
 *  Called by phase-setup.ts's build-phase initializer. */
export function onBuildPhaseStart(state: GameState): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.onBuildPhaseStart?.(state);
  }
}

/** Phase-boundary hook: run battle-start upgrade elections (Mortar picks
 *  one cannon to fire mortar shots, Shield Battery shields cannons inside
 *  the home region). Must be called after setPhase(BATTLE) and before any
 *  RNG-consuming code in the battle-start sequence — the order is part of
 *  the determinism contract. */
export function onBattlePhaseStart(
  state: GameState,
  deps: BattleStartCannonDeps,
): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.onBattlePhaseStart?.(state, deps);
  }
}

/** Per-frame hook: advance upgrade-effect timers during the build phase.
 *  Called from the engine's tickBuildPhase entry point. */
export function tickBuildUpgrades(state: GameState, dt: number): void {
  for (const impl of UPGRADE_REGISTRY.values()) {
    impl.tickBuild?.(state, dt);
  }
}

/** Apply all picked upgrades to player state. Each per-upgrade pick hook
 *  is idempotent, so per-entry dispatch is safe even when multiple players
 *  pick the same global upgrade (second wind, clear the field, demolition). */
export function applyUpgradePicks(
  state: GameState,
  dialog: UpgradePickDialogState,
): void {
  for (const entry of dialog.entries) {
    if (entry.choice === null) continue;
    const player = state.players[entry.playerId];
    if (!player) continue;
    player.upgrades.set(entry.choice, 1);
    emitGameEvent(state.bus, GAME_EVENT.UPGRADE_PICKED, {
      playerId: entry.playerId,
      upgradeId: entry.choice,
    });
    UPGRADE_REGISTRY.get(entry.choice)?.onPick?.(state, player);
  }
}

/** Generate upgrade offers for all alive players. Uses state.rng for determinism.
 *  Called from enterBuildFromBattle so the RNG is consumed before the
 *  BUILD_START checkpoint is sent. Returns null if not applicable. */
export function generateUpgradeOffers(
  state: GameState,
): Map<ValidPlayerSlot, UpgradeOfferTuple> | null {
  if (!hasFeature(state, FID.UPGRADES)) return null;
  if (state.round < UPGRADE_FIRST_ROUND) return null;

  const offers = new Map<ValidPlayerSlot, UpgradeOfferTuple>();
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    offers.set(player.id, drawOffers(state));
  }
  return offers.size > 0 ? offers : null;
}

/** All upgrades last one round — clear damaged-wall markers and upgrade maps. */
export function resetPlayerUpgrades(state: GameState): void {
  for (const player of state.players) {
    player.damagedWalls.clear();
    player.upgrades.clear();
  }
}

/** Draw N unique upgrades from the implemented pool using state.rng. */
function drawOffers(state: GameState): [UpgradeId, UpgradeId, UpgradeId] {
  const pool = [...IMPLEMENTED_UPGRADES];
  const picked: UpgradeId[] = [];

  for (let idx = 0; idx < OFFER_COUNT && pool.length > 0; idx++) {
    const totalWeight = pool.reduce((sum, def) => sum + def.weight, 0);
    let roll = state.rng.next() * totalWeight;
    let chosenIdx = pool.length - 1;
    for (let poolIdx = 0; poolIdx < pool.length; poolIdx++) {
      roll -= pool[poolIdx]!.weight;
      if (roll <= 0) {
        chosenIdx = poolIdx;
        break;
      }
    }
    picked.push(pool[chosenIdx]!.id);
    pool.splice(chosenIdx, 1);
  }

  return picked as [UpgradeId, UpgradeId, UpgradeId];
}
