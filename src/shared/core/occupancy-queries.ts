import type { CannonIdx } from "./battle-events.ts";
import { type Cannon, isBalloonCannon } from "./battle-types.ts";
import type { Tower } from "./geometry-types.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { Player } from "./player-types.ts";
import { isCannonTile, isTowerTile } from "./spatial.ts";

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
