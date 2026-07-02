import {
  type Cannon,
  type CapturedCannon,
  isBalloonCannon,
} from "../core/battle-types.ts";
import type { CannonIdx, Tower } from "../core/geometry-types.ts";
import type { TileKey } from "../core/grid.ts";
import type { ValidPlayerId } from "../core/player-slot.ts";
import type { Player } from "../core/player-types.ts";
import { isCannonTile, isTowerTile } from "../core/spatial.ts";

/** Pre-built tile-key Sets for fast O(1) occupancy checks.
 *  Build once via `buildOccupancyCache` (board-occupancy.ts), then pass to
 *  `canPlacePiece` to avoid per-tile linear scans over towers/cannons/grunts. */
export interface OccupancyCache {
  readonly towerKeys: ReadonlySet<TileKey>;
  readonly cannonKeys: ReadonlySet<TileKey>;
  readonly gruntKeys: ReadonlySet<TileKey>;
  /** Union of every player's walls. Use for any-wall presence checks
   *  (e.g. wall-overlap validation in `canPlacePiece`); for own-wall checks,
   *  test `player.walls.has(key)` directly. */
  readonly wallKeys: ReadonlySet<TileKey>;
  readonly pitKeys: ReadonlySet<TileKey>;
}

type CapturedCannonState = {
  readonly capturedCannons: readonly CapturedCannon[];
};

export function hasTowerAt(
  state: { readonly map: { readonly towers: readonly Tower[] } },
  r: number,
  c: number,
): boolean {
  return state.map.towers.some((tower) => isTowerTile(tower, r, c));
}

export function hasCannonAt(
  state: { readonly players: readonly Player[] },
  r: number,
  c: number,
  options?: { excludeBalloonCannons?: boolean },
): boolean {
  return state.players.some((player) =>
    player.cannons.some((cannon) => {
      if (options?.excludeBalloonCannons && isBalloonCannon(cannon))
        return false;
      return isCannonTile(cannon, r, c);
    }),
  );
}

/** Resolve a `(playerId, cannonIdx)` pair — the natural identity carried in
 *  `BattleEvent` payloads — to a `Cannon`, or `undefined` if either index
 *  is stale (player slot or cannon slot vacated). */
export function getCannon(
  state: { readonly players: readonly Player[] },
  playerId: ValidPlayerId,
  cannonIdx: CannonIdx,
): Cannon | undefined {
  return state.players[playerId]?.cannons[cannonIdx];
}

/** True if `cannon` is currently captured by any player (its original owner
 *  cannot fire it; the capturer fires it). */
export function isCannonCaptured(
  state: CapturedCannonState,
  cannon: Cannon,
): boolean {
  return state.capturedCannons.some((cc) => cc.cannon === cannon);
}

/** True if `cannon` is currently captured by `capturerId` (so it counts as
 *  that player's gun, not its original owner's). */
export function isCannonCapturedBy(
  state: CapturedCannonState,
  cannon: Cannon,
  capturerId: ValidPlayerId,
): boolean {
  return state.capturedCannons.some(
    (cc) => cc.cannon === cannon && cc.capturerId === capturerId,
  );
}

/** True if `cannon` has been captured FROM `victimId` (i.e. `victimId` is
 *  the original owner and the cannon currently fires for someone else). */
export function isCannonCapturedFrom(
  state: CapturedCannonState,
  cannon: Cannon,
  victimId: ValidPlayerId,
): boolean {
  return state.capturedCannons.some(
    (cc) => cc.cannon === cannon && cc.victimId === victimId,
  );
}
