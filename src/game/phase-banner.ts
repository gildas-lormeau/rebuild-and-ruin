import type { GameState } from "../shared/types.ts";
import type { CastleData, EntityOverlay } from "../shared/ui/overlay-types.ts";

/** Pre-capture old battle scene into banner state before nextPhase/checkpoint
 *  mutates the game state.  Must be called while state.phase is still BATTLE.
 *  showBannerTransition (runtime-banner.ts) uses ??= so these pre-set values survive intact. */
export function capturePrevBattleScene(
  banner: {
    prevCastles?: CastleData[];
    prevTerritory?: Set<number>[];
    prevWalls?: Set<number>[];
    prevEntities?: EntityOverlay;
  },
  state: GameState,
  battleTerritory: Set<number>[] | undefined,
  battleWalls: Set<number>[] | undefined,
): void {
  banner.prevCastles = snapshotCastles(state);
  banner.prevTerritory = battleTerritory?.map(
    (territory) => new Set(territory),
  );
  banner.prevWalls = battleWalls?.map((wall) => new Set(wall));
  banner.prevEntities = snapshotEntities(state);
}

/** Snapshot castle data for all players with a castle.
 *  @param wallOverrides — Per-player wall sets (e.g. pre-sweep walls); falls
 *    back to player.walls when the slot is missing or the array is undefined. */
export function snapshotCastles(
  state: GameState,
  wallOverrides?: readonly Set<number>[],
): CastleData[] {
  return state.players
    .filter((player) => player.castle)
    .map((player) => ({
      walls: wallOverrides?.[player.id] ?? new Set(player.walls),
      interior: player.interior,
      cannons: player.cannons.map((c) => ({ ...c })),
      playerId: player.id,
    }));
}

/** Shallow-clone all map entities so the banner scene stays frozen while
 *  applyCheckpoint mutates the live state behind it. */
export function snapshotEntities(state: GameState): EntityOverlay {
  return {
    houses: state.map.houses.map((house) => ({ ...house })),
    grunts: state.grunts.map((grunt) => ({ ...grunt })),
    towerAlive: [...state.towerAlive],
    burningPits: state.burningPits.map((pit) => ({ ...pit })),
    bonusSquares: state.bonusSquares.map((bonus) => ({ ...bonus })),
    frozenTiles: state.modern?.frozenTiles
      ? new Set(state.modern.frozenTiles)
      : undefined,
    sinkholeTiles: state.modern?.sinkholeTiles
      ? new Set(state.modern.sinkholeTiles)
      : undefined,
  };
}
