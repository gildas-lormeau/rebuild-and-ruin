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
import { isCannonEnclosed } from "../shared/core/board-occupancy.ts";
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
  | {
      absorbed: false;
      playerId: ValidPlayerSlot;
      // Heavy hit blew through a shield<2 rampart: wall is destroyed AND the
      // rampart's last point of shield is consumed (drained to 0).
      rampartConsumed?: { cannonIdx: number };
    }
  | null;

/** Look up whether the wall at (row, col) is protected. Pure — no mutation.
 *
 *  `heavy` marks a 2-HP impact (super gun ball / mortar center): bypasses
 *  Reinforced Walls entirely, and consumes 2 shield HP from a rampart
 *  (or destroys the wall + drains the shield when shield<2). */
export function resolveWallShield(
  state: GameState,
  row: number,
  col: number,
  key: number,
  heavy?: boolean,
): WallShieldResult {
  for (const player of state.players) {
    if (!player.walls.has(key)) continue;
    if (!heavy && shouldAbsorbWallHit(player, key)) {
      return {
        absorbed: true,
        kind: ShieldKind.Reinforced,
        playerId: player.id,
        tileKey: key,
      };
    }
    const rampart = findShieldingRampart(player, row, col);
    if (rampart) {
      const shieldHp = rampart.cannon.shieldHp ?? 0;
      if (heavy && shieldHp < 2) {
        return {
          absorbed: false,
          playerId: player.id,
          rampartConsumed: { cannonIdx: rampart.idx },
        };
      }
      return {
        absorbed: true,
        kind: ShieldKind.Rampart,
        playerId: player.id,
        cannonIdx: rampart.idx,
        newShieldHp: shieldHp - (heavy ? 2 : 1),
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
    if (!isCannonEnclosed(cannon, wallOwner)) continue;
    // Chebyshev distance from rampart center (2×2 → center at +1,+1) to wall tile
    const dist = Math.max(
      Math.abs(wallRow - (cannon.row + 1)),
      Math.abs(wallCol - (cannon.col + 1)),
    );
    if (dist <= RAMPART_SHIELD_RADIUS) return { cannon, idx };
  }
  return null;
}
