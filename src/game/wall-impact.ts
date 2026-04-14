/**
 * Wall impact helpers — decides whether a wall hit is absorbed by
 * Reinforced Walls (upgrade) or a nearby allied Rampart, and (for
 * non-event-driven callers) applies the resulting side effects.
 *
 * Cannonball path: resolveWallShield → caller emits WALL_* events →
 *   applyImpactEvent applies mutations.
 * Grunt path: resolveWallShield → applyWallShield applies mutations
 *   directly (no bus events, matching today's silent wall removal).
 */

import type { Cannon } from "../shared/core/battle-types.ts";
import { RAMPART_SHIELD_RADIUS } from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { isCannonAlive, isRampartCannon } from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import { shouldAbsorbWallHit } from "./upgrade-system.ts";

export enum ShieldKind {
  Reinforced = "reinforced",
  Rampart = "rampart",
}

type WallShieldResult =
  | {
      absorbed: true;
      kind: ShieldKind.Reinforced;
      playerId: ValidPlayerSlot;
      tileKey: number;
    }
  | {
      absorbed: true;
      kind: ShieldKind.Rampart;
      playerId: ValidPlayerSlot;
      cannonIdx: number;
      newShieldHp: number;
    }
  | { absorbed: false; playerId: ValidPlayerSlot }
  | null;

/** Look up whether the wall at (row, col) is protected. Pure — no mutation. */
export function resolveWallShield(
  state: GameState,
  row: number,
  col: number,
  key: number,
): WallShieldResult {
  for (const player of state.players) {
    if (!player.walls.has(key)) continue;
    if (shouldAbsorbWallHit(player, key)) {
      return {
        absorbed: true,
        kind: ShieldKind.Reinforced,
        playerId: player.id,
        tileKey: key,
      };
    }
    const rampart = findShieldingRampart(player, row, col);
    if (rampart) {
      return {
        absorbed: true,
        kind: ShieldKind.Rampart,
        playerId: player.id,
        cannonIdx: rampart.idx,
        newShieldHp: (rampart.cannon.shieldHp ?? 0) - 1,
      };
    }
    return { absorbed: false, playerId: player.id };
  }
  return null;
}

/** Apply the state mutations implied by an absorbed hit (grunt path).
 *  No-op for unabsorbed or missing results — caller destroys the wall. */
export function applyWallShield(
  state: GameState,
  result: WallShieldResult,
): void {
  if (!result || !result.absorbed) return;
  if (result.kind === ShieldKind.Reinforced) {
    state.players[result.playerId]?.damagedWalls.add(result.tileKey);
    return;
  }
  const cannon = state.players[result.playerId]?.cannons[result.cannonIdx];
  if (cannon)
    cannon.shieldHp = result.newShieldHp > 0 ? result.newShieldHp : undefined;
}

function findShieldingRampart(
  wallOwner: Player,
  wallRow: number,
  wallCol: number,
): { cannon: Cannon; idx: number } | null {
  for (let idx = 0; idx < wallOwner.cannons.length; idx++) {
    const cannon = wallOwner.cannons[idx]!;
    if (!isCannonAlive(cannon) || !isRampartCannon(cannon)) continue;
    if ((cannon.shieldHp ?? 0) <= 0) continue;
    // Chebyshev distance from rampart center (2×2 → center at +1,+1) to wall tile
    const dist = Math.max(
      Math.abs(wallRow - (cannon.row + 1)),
      Math.abs(wallCol - (cannon.col + 1)),
    );
    if (dist <= RAMPART_SHIELD_RADIUS) return { cannon, idx };
  }
  return null;
}
