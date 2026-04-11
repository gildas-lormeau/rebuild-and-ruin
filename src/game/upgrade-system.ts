import type { ImpactEvent } from "../shared/battle-events.ts";
import type { Cannon } from "../shared/battle-types.ts";
import { FID } from "../shared/feature-defs.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/game-event-bus.ts";
import type { UpgradePickDialogState } from "../shared/interaction-types.ts";
import { type ValidPlayerSlot } from "../shared/player-slot.ts";
import { isPlayerSeated, type Player } from "../shared/player-types.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/types.ts";
import {
  IMPLEMENTED_UPGRADES,
  type UpgradeId,
} from "../shared/upgrade-defs.ts";
import { architectWallOverlapAllowance } from "./upgrades/architect.ts";
import { ceasefireShouldSkipBattle } from "./upgrades/ceasefire.ts";
import { clearTheFieldOnPick } from "./upgrades/clear-the-field.ts";
import {
  type ConscriptionRespawnTarget,
  conscriptionPickRespawnTarget,
} from "./upgrades/conscription.ts";
import { demolitionOnPick } from "./upgrades/demolition.ts";
import { doubleTimeBuildTimerBonus } from "./upgrades/double-time.ts";
import {
  foundationsExtinguishOnPlace,
  foundationsIgnoresPits,
} from "./upgrades/foundations.ts";
import {
  masterBuilderAllowsBuild,
  masterBuilderOnBuildStart,
  masterBuilderTick,
  masterBuilderTimerBonus,
} from "./upgrades/master-builder.ts";
import { mortarElectAll, mortarSpeedMult } from "./upgrades/mortar.ts";
import { rapidFireBallMult, rapidFireOwns } from "./upgrades/rapid-fire.ts";
import { reclamationOnPick } from "./upgrades/reclamation.ts";
import { reinforcedWallsShouldAbsorb } from "./upgrades/reinforced-walls.ts";
import {
  type RicochetApplyBounce,
  ricochetProcessBounces,
} from "./upgrades/ricochet.ts";
import { salvageOnCannonKilled } from "./upgrades/salvage.ts";
import { secondWindOnPick } from "./upgrades/second-wind.ts";
import { shieldBatteryElectAll } from "./upgrades/shield-battery.ts";
import { supplyDropCannonSlotsBonus } from "./upgrades/supply-drop.ts";
import { territorialAmbitionScoreMult } from "./upgrades/territorial-ambition.ts";

/** Helpers from cannon-system that battle-start hooks need. Injected by
 *  phase-setup.ts so this dispatcher (L6) doesn't have to import from
 *  cannon-system (also L6 — would create a cycle via cannonSlotsBonus). */
interface BattleStartCannonDeps {
  readonly filterActiveFiringCannons: (player: Player) => Cannon[];
  readonly isCannonEnclosed: (cannon: Cannon, player: Player) => boolean;
  readonly homeEnclosedRegion: (player: Player) => Set<number>;
}

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
  if (isMortar) return mortarSpeedMult();
  return rapidFireBallMult(player);
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

/** How many own-wall tiles this player may overlap with a single piece
 *  placement. Aggregates every upgrade that relaxes wall-overlap rules. */
export function wallOverlapAllowance(player: Player): number {
  return architectWallOverlapAllowance(player);
}

/** True when this player may place pieces on top of burning pits.
 *  Callers should skip the pit-block check when this returns true. */
export function canPlaceOverBurningPit(player: Player): boolean {
  return foundationsIgnoresPits(player);
}

/** Post-placement hook: run upgrade-driven side effects triggered by a
 *  just-placed piece (e.g. Foundations extinguishing covered pits). */
export function onPiecePlaced(
  state: GameState,
  player: Player,
  pieceKeys: ReadonlySet<number>,
): void {
  foundationsExtinguishOnPlace(state, player, pieceKeys);
}

/** Phase-boundary hook: configure upgrade state at the start of a build phase.
 *  Called by phase-setup.ts's build-phase initializer. */
export function onBuildPhaseStart(state: GameState): void {
  masterBuilderOnBuildStart(state);
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
  mortarElectAll(state, deps.filterActiveFiringCannons, deps.isCannonEnclosed);
  shieldBatteryElectAll(state, deps.homeEnclosedRegion);
}

/** Per-frame hook: advance upgrade-effect timers during the build phase.
 *  Called from the engine's tickBuildPhase entry point. */
export function tickBuildUpgrades(state: GameState, dt: number): void {
  masterBuilderTick(state, dt);
}

/** Post-impact hook: run any follow-up impacts triggered by upgrades.
 *  Today only Ricochet uses this. Battle-system supplies `applyBounce`,
 *  which owns computeImpact + applyImpactEvent + emit machinery; the
 *  upgrade file owns the RNG-driven bounce geometry. */
export function onImpactResolved(
  state: GameState,
  shooterId: ValidPlayerSlot,
  hitRow: number,
  hitCol: number,
  initialImpactEvents: readonly ImpactEvent[],
  applyBounce: RicochetApplyBounce,
): void {
  ricochetProcessBounces(
    state,
    shooterId,
    hitRow,
    hitCol,
    initialImpactEvents,
    applyBounce,
  );
}

/** Post-grunt-kill hook: query upgrades for a replacement spawn target.
 *  Today only Conscription uses this. Returns the victim's home-tower
 *  anchor so the caller can run findGruntSpawnNear from there. */
export function onGruntKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): ConscriptionRespawnTarget | null {
  return conscriptionPickRespawnTarget(state, shooterId);
}

/** Post-cannon-kill hook: award upgrade effects triggered when a shooter
 *  destroys an enemy cannon. Today only Salvage uses this. */
export function onCannonKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): void {
  salvageOnCannonKilled(state, shooterId);
}

/** Apply all picked upgrades to player state. Each per-upgrade pick hook
 *  is idempotent and guards on its own UID internally, so per-entry
 *  dispatch is safe even when multiple players pick the same global
 *  upgrade (second wind, clear the field, demolition). */
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
    onUpgradePicked(state, player, entry.choice);
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

/** Pick-time hook: route a freshly-picked upgrade to per-upgrade side
 *  effects. Each per-upgrade function no-ops when the choice doesn't
 *  match its UID, so the dispatcher stays UID.*-free. */
function onUpgradePicked(
  state: GameState,
  player: Player,
  choice: UpgradeId,
): void {
  secondWindOnPick(state, choice);
  clearTheFieldOnPick(state, choice);
  demolitionOnPick(state, choice);
  reclamationOnPick(player, choice);
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
