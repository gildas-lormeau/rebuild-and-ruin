import { deletePlayerWallsBatch } from "../shared/board-occupancy.ts";
import { FID } from "../shared/feature-defs.ts";
import {
  MORTAR_SPEED_MULT,
  RAPID_FIRE_SPEED_MULT,
} from "../shared/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/game-event-bus.ts";
import type { UpgradePickDialogState } from "../shared/interaction-types.ts";
import { type ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  isPlayerEliminated,
  isPlayerSeated,
  type Player,
} from "../shared/player-types.ts";
import {
  computeOutside,
  DIRS_8,
  isCannonAlive,
  packTile,
  unpackTile,
} from "../shared/spatial.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/types.ts";
import {
  IMPLEMENTED_UPGRADES,
  UID,
  type UpgradeId,
} from "../shared/upgrade-defs.ts";
import { ceasefireShouldSkipBattle } from "./upgrades/ceasefire.ts";
import { doubleTimeBuildTimerBonus } from "./upgrades/double-time.ts";
import {
  masterBuilderAllowsBuild,
  masterBuilderOnBuildStart,
  masterBuilderTick,
  masterBuilderTimerBonus,
} from "./upgrades/master-builder.ts";
import { rapidFireOwns } from "./upgrades/rapid-fire.ts";
import { reinforcedWallsShouldAbsorb } from "./upgrades/reinforced-walls.ts";
import { supplyDropCannonSlotsBonus } from "./upgrades/supply-drop.ts";
import { territorialAmbitionScoreMult } from "./upgrades/territorial-ambition.ts";

/** First round that triggers upgrade picks (modern mode). */
const UPGRADE_FIRST_ROUND = 3;
/** Number of upgrade choices offered per pick. */
const OFFER_COUNT = 3;

/** True when this round's battle phase should be skipped entirely. */
export function shouldSkipBattle(state: GameState): boolean {
  return ceasefireShouldSkipBattle(state);
}

/** Whether this player is allowed to build this frame.
 *  Aggregates every upgrade that can gate a player's build tick. */
export function canBuildThisFrame(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  return masterBuilderAllowsBuild(state, playerId);
}

/** Build timer bonus contributed by active upgrades (additive). */
export function buildTimerBonus(state: GameState): number {
  return masterBuilderTimerBonus(state) + doubleTimeBuildTimerBonus(state);
}

/** Cannonball speed multiplier for a firing cannon. Combines upgrade
 *  contributions (Rapid Fire) with cannon-mode effects (mortar). Encodes
 *  the design rule that Rapid Fire + Mortar cancel out to normal speed. */
export function ballSpeedMult(player: Player, isMortar: boolean): number {
  const hasRapidFire = rapidFireOwns(player);
  if (isMortar && hasRapidFire) return 1;
  if (isMortar) return MORTAR_SPEED_MULT;
  if (hasRapidFire) return RAPID_FIRE_SPEED_MULT;
  return 1;
}

/** True when a wall hit should be absorbed (wall survives this shot).
 *  Caller is responsible for emitting WALL_ABSORBED and marking the tile
 *  in damagedWalls via the event dispatch. */
export function shouldAbsorbWallHit(player: Player, tileKey: number): boolean {
  return reinforcedWallsShouldAbsorb(player, tileKey);
}

/** End-of-build territory score multiplier for a player (multiplicative). */
export function territoryScoreMult(player: Player): number {
  return territorialAmbitionScoreMult(player);
}

/** Extra cannon slots granted to a player by active upgrades (additive). */
export function cannonSlotsBonus(player: Player): number {
  return supplyDropCannonSlotsBonus(player);
}

/** Phase-boundary hook: configure upgrade state at the start of a build phase.
 *  Called by phase-setup.ts's build-phase initializer. */
export function onBuildPhaseStart(state: GameState): void {
  masterBuilderOnBuildStart(state);
}

/** Per-frame hook: advance upgrade-effect timers during the build phase.
 *  Called from the engine's tickBuildPhase entry point. */
export function tickBuildUpgrades(state: GameState, dt: number): void {
  masterBuilderTick(state, dt);
}

/** Apply all picked upgrades to player state. */
export function applyUpgradePicks(
  state: GameState,
  dialog: UpgradePickDialogState,
): void {
  let secondWind = false;
  let clearTheField = false;
  let demolition = false;
  const reclamationPlayers: ValidPlayerSlot[] = [];
  for (const entry of dialog.entries) {
    if (entry.choice === null) continue;
    const player = state.players[entry.playerId];
    if (!player) continue;
    player.upgrades.set(entry.choice, 1);
    emitGameEvent(state.bus, GAME_EVENT.UPGRADE_PICKED, {
      playerId: entry.playerId,
      upgradeId: entry.choice,
    });
    if (entry.choice === UID.SECOND_WIND) secondWind = true;
    if (entry.choice === UID.CLEAR_THE_FIELD) clearTheField = true;
    if (entry.choice === UID.DEMOLITION) demolition = true;
    if (entry.choice === UID.RECLAMATION)
      reclamationPlayers.push(entry.playerId);
  }
  if (secondWind) {
    for (let idx = 0; idx < state.towerAlive.length; idx++) {
      state.towerAlive[idx] = true;
    }
    state.towerPendingRevive.clear();
  }
  if (clearTheField) {
    state.grunts.length = 0;
  }
  if (demolition) {
    stripInnerWalls(state);
  }
  for (const pid of reclamationPlayers) {
    const player = state.players[pid];
    if (player) {
      player.cannons = player.cannons.filter(isCannonAlive);
    }
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

  for (let i = 0; i < OFFER_COUNT && pool.length > 0; i++) {
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

/** Strip non-load-bearing walls from all players.
 *  A wall is "inner" (safe to remove) if none of its 8-dir neighbors are
 *  outside (reachable from map edges). Enclosures remain intact; thick walls
 *  are thinned to a single-tile shell. Can merge adjacent castles.
 *  Uses deletePlayerWallsBatch (skips markWallsDirty) — interior is rechecked
 *  at the next piece placement or end-of-build via recheckTerritory. */
function stripInnerWalls(state: GameState): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (player.walls.size === 0) continue;
    const outside = computeOutside(player.walls);
    const inner: number[] = [];
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      let loadBearing = false;
      for (const [dr, dc] of DIRS_8) {
        if (outside.has(packTile(r + dr, c + dc))) {
          loadBearing = true;
          break;
        }
      }
      if (!loadBearing) inner.push(key);
    }
    if (inner.length > 0) deletePlayerWallsBatch(player, inner);
  }
}
