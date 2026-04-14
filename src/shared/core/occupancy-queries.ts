import type { Tower } from "./geometry-types.ts";
import type { Player } from "./player-types.ts";
import { isBalloonCannon, isCannonTile, isTowerTile } from "./spatial.ts";

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
