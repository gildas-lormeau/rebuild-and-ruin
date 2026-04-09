/**
 * AI upgrade selection — contextual heuristic for auto-resolving upgrade picks.
 *
 * Evaluates game state to make intelligent picks instead of random selection.
 * Extracted from game/upgrade-pick.ts to keep AI logic in the ai/ domain.
 */

import { GRID_COLS, GRID_ROWS } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isGrass } from "../shared/spatial.ts";
import type { GameState } from "../shared/types.ts";
import { UID, type UpgradeId } from "../shared/upgrade-defs.ts";

const SMALL_PIECES_TERRITORY_RATIO = 0.8;

/** AI-aware pick: contextual upgrade selection based on game state. */
export function aiPickUpgrade(
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
