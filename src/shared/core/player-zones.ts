/**
 * Player ↔ zone mapping helpers — pure reads over the `playerZones` slot
 * array. Consumed by camera framing, touch-UI layout, and crosshair aim
 * (input/ + runtime/), never by the game-rule path. Lives next to the
 * `Player` struct because it operates on the player→zone assignment, but
 * carries no game state of its own. See `zone-id.ts` for the brand and
 * `spatial.ts` for tile↔zone geometry.
 */

import { isPlayerEliminated } from "./player-slot.ts";
import type { ZoneId } from "./zone-id.ts";

/** Return the player slot whose zone matches `zone`, or `undefined` if no
 *  player is assigned to that zone. Encodes the data-model invariant that
 *  zones are exclusive: at most one player per zone (river isolation).
 *  Use this in place of `playerZones.indexOf(zone)`. */
export function playerByZone(
  playerZones: readonly ZoneId[],
  zone: ZoneId,
): number | undefined {
  const pid = playerZones.indexOf(zone);
  return pid >= 0 ? pid : undefined;
}

/** Return the zone owned by player `pid`, or `null` when state is absent or
 *  the slot has no assigned zone. Pure helper consumed by camera and touch-UI
 *  to derive the local human's home zone from a frame snapshot. */
export function zoneByPlayer(
  state: { readonly playerZones: readonly ZoneId[] } | null | undefined,
  pid: number,
): ZoneId | null {
  if (!state) return null;
  return state.playerZones[pid] ?? null;
}

/** Return the distinct zones of all non-eliminated enemies. */
export function enemyZones(
  players: readonly { eliminated: boolean }[],
  playerZones: readonly ZoneId[],
  myPid: number,
): ZoneId[] {
  const zones: ZoneId[] = [];
  for (let i = 0; i < players.length; i++) {
    if (i === myPid || isPlayerEliminated(players[i])) continue;
    const zone = playerZones[i];
    if (zone !== undefined && !zones.includes(zone)) zones.push(zone);
  }
  return zones;
}

/** Return the zone of the highest-scoring non-eliminated enemy, or null. */
export function bestEnemyZone(
  players: readonly { eliminated: boolean; score: number }[],
  playerZones: readonly ZoneId[],
  myPid: number,
): ZoneId | null {
  let bestPid = -1;
  let bestScore = -1;
  for (let i = 0; i < players.length; i++) {
    if (i === myPid || isPlayerEliminated(players[i])) continue;
    if (players[i]!.score > bestScore) {
      bestScore = players[i]!.score;
      bestPid = i;
    }
  }
  if (bestPid < 0) return null;
  return playerZones[bestPid] ?? null;
}
