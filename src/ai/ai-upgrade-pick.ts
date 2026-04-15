/**
 * AI upgrade-pick logic: per-entry auto-resolve tick (cycle → lock-in →
 * commit) and the contextual decision heuristic it uses.
 *
 * Exported surface:
 *   - tickAiUpgradePickEntry: per-entry animation tick (cycle → lock-in →
 *     commit). Called by AiController.tickUpgradePick (inherited by
 *     AssistedHumanController, which broadcasts the resulting pick).
 *
 * The decision function (aiPickUpgrade) stays file-local — the animation
 * tick invokes it at lock-in and caches the result in `entry.plannedChoice`.
 * Max-timer force-pick fallback (`plannedChoice ?? random`) lives on
 * BaseController.forceUpgradePick — pure arithmetic, no AI knowledge.
 */

import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isGrass } from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import { UID, type UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { UpgradePickEntry } from "../shared/ui/interaction-types.ts";
import { secondsToTicks } from "./ai-constants.ts";

const SMALL_PIECES_TERRITORY_RATIO = 0.8;
/** Extra delay per auto-resolving entry (by entry index) so AI picks land
 *  one at a time instead of all snapping on the same frame (ticks). */
const UPGRADE_PICK_STAGGER = secondsToTicks(0.5);
/** Ticks between focus "steps" while an AI entry cycles through its offers
 *  during the delay. */
const UPGRADE_PICK_CYCLE_STEP = secondsToTicks(0.22);
/** Window at the end of the delay where the AI stops cycling and locks
 *  focus onto its final pick, so the reveal isn't a random-looking snap (ticks). */
const UPGRADE_PICK_LOCK_IN = secondsToTicks(0.35);

/** Per-frame auto-resolve tick for one upgrade-pick dialog entry.
 *  Called by `game/upgrade-pick.ts` via an injected callback (the game
 *  layer may not import ai/, so the runtime/entry wiring closes over state
 *  and passes this function down).
 *
 *  Phases of the animation:
 *    1. Cycling — focus steps through offers while autoTimer < lockInStart.
 *    2. Lock-in — resolves plannedChoice via aiPickUpgrade and freezes focus
 *                 on it for the final LOCK_IN window.
 *    3. Commit — applies plannedChoice to entry.choice, records pickedAtTimer. */
export function tickAiUpgradePickEntry(
  entry: UpgradePickEntry,
  entryIdx: number,
  autoDelayTicks: number,
  dialogTimer: number,
  state: GameState,
): void {
  entry.autoTimer++;
  const effectiveDelay = autoDelayTicks + entryIdx * UPGRADE_PICK_STAGGER;
  // Clamp at 0 so shrinking autoDelay below LOCK_IN doesn't produce a
  // negative window that silently skips the cycling phase.
  const lockInStart = Math.max(0, effectiveDelay - UPGRADE_PICK_LOCK_IN);

  if (entry.autoTimer >= effectiveDelay) {
    const pick =
      entry.plannedChoice ?? aiPickUpgrade(entry.offers, state, entry.playerId);
    entry.choice = pick;
    entry.focusedCard = entry.offers.indexOf(pick);
    entry.pickedAtTimer = dialogTimer;
    return;
  }

  if (entry.autoTimer >= lockInStart) {
    if (entry.plannedChoice === null) {
      entry.plannedChoice = aiPickUpgrade(entry.offers, state, entry.playerId);
    }
    entry.focusedCard = entry.offers.indexOf(entry.plannedChoice);
    return;
  }

  const len = entry.offers.length;
  const dir = (entry.playerId & 1) === 0 ? 1 : -1;
  const start = entryIdx % len;
  const cycleStep = UPGRADE_PICK_CYCLE_STEP * (1 + (entryIdx % 3) * 0.17);
  const rawStep = Math.floor(entry.autoTimer / cycleStep);
  entry.focusedCard = (((start + dir * rawStep) % len) + len) % len;
}

/** AI-aware pick: contextual upgrade selection based on game state.
 *  File-local — invoked by tickAiUpgradePickEntry at lock-in/commit. */
function aiPickUpgrade(
  offers: readonly [UpgradeId, UpgradeId, UpgradeId],
  state: GameState,
  playerId: ValidPlayerSlot,
): UpgradeId {
  const hasDeadTowers = playerHasDeadTowers(state, playerId);
  if (hasDeadTowers && offers.includes(UID.SECOND_WIND)) {
    return UID.SECOND_WIND;
  }
  const hasGruntsInZone = playerHasGruntsInZone(state, playerId);
  if (hasGruntsInZone && offers.includes(UID.CLEAR_THE_FIELD)) {
    return UID.CLEAR_THE_FIELD;
  }
  const hasPits = playerHasBurningPitsInZone(state, playerId);
  if (hasPits && offers.includes(UID.FOUNDATIONS)) {
    return UID.FOUNDATIONS;
  }
  const hasDeadCannons = playerHasDeadCannons(state, playerId);
  if (hasDeadCannons && offers.includes(UID.RECLAMATION)) {
    return UID.RECLAMATION;
  }
  // Mortar is strong when player has few cannons (catch-up mechanic)
  if (offers.includes(UID.MORTAR) && playerCannonCount(state, playerId) <= 3) {
    return UID.MORTAR;
  }
  const largeTerritory =
    playerTerritoryRatio(state, playerId) >= SMALL_PIECES_TERRITORY_RATIO;
  if (largeTerritory && offers.includes(UID.SMALL_PIECES)) {
    return UID.SMALL_PIECES;
  }
  // Exclude contextual upgrades when conditions aren't met
  const excluded = new Set<UpgradeId>();
  if (!hasDeadTowers) excluded.add(UID.SECOND_WIND);
  if (!hasGruntsInZone) excluded.add(UID.CLEAR_THE_FIELD);
  if (!hasPits) excluded.add(UID.FOUNDATIONS);
  if (!hasDeadCannons) excluded.add(UID.RECLAMATION);
  if (!largeTerritory) excluded.add(UID.SMALL_PIECES);
  // Demolition: exclude when AI has thin walls (nothing to gain from stripping)
  if (!playerHasThickWalls(state, playerId)) excluded.add(UID.DEMOLITION);
  const viable = offers.filter((id) => !excluded.has(id));
  const pool = viable.length > 0 ? viable : offers;
  return pool[Math.floor(state.rng.next() * pool.length)]!;
}

function playerTerritoryRatio(
  state: GameState,
  playerId: ValidPlayerSlot,
): number {
  const player = state.players[playerId];
  if (!player?.homeTower || player.interior.size === 0) return 0;
  const zone = player.homeTower.zone;
  let zoneGrassCount = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (
        isGrass(state.map.tiles, row, col) &&
        state.map.zones[row]![col] === zone
      ) {
        zoneGrassCount++;
      }
    }
  }
  return zoneGrassCount > 0 ? player.interior.size / zoneGrassCount : 0;
}

function playerHasDeadTowers(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return player.ownedTowers.some((tower) => !state.towerAlive[tower.index]);
}

function playerHasGruntsInZone(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  const player = state.players[playerId];
  if (!player?.homeTower) return false;
  const zone = player.homeTower.zone;
  return state.grunts.some(
    (grunt) => state.map.zones[grunt.row]?.[grunt.col] === zone,
  );
}

function playerHasBurningPitsInZone(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  const player = state.players[playerId];
  if (!player?.homeTower) return false;
  const zone = player.homeTower.zone;
  return state.burningPits.some(
    (pit) => state.map.zones[pit.row]?.[pit.col] === zone,
  );
}

function playerHasDeadCannons(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return player.cannons.some((cannon) => cannon.hp <= 0);
}

/** True if the player has many non-load-bearing (inner) walls — Demolition would hurt them. */
function playerHasThickWalls(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  const player = state.players[playerId];
  if (!player || player.walls.size === 0) return false;
  // Rough heuristic: if walls outnumber interior tiles, walls are thick
  return player.walls.size > player.interior.size;
}

function playerCannonCount(
  state: GameState,
  playerId: ValidPlayerSlot,
): number {
  const player = state.players[playerId];
  if (!player) return 0;
  return player.cannons.filter(
    (cannon) => cannon.hp > 0 && cannon.mode !== "balloon",
  ).length;
}
