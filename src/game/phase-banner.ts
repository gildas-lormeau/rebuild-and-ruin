import { brandFreshInterior } from "../shared/core/player-types.ts";
import type { GameState } from "../shared/core/types.ts";
import type {
  BannerSnapshot,
  CastleData,
  EntityOverlay,
} from "../shared/ui/overlay-types.ts";

export type { BannerSnapshot } from "../shared/ui/overlay-types.ts";

/** Options for `createBannerSnapshot`. All optional — omit fields that don't
 *  apply to the current transition. */
interface SnapshotOpts {
  /** Per-player wall overrides (e.g. pre-sweep walls). Falls back to
   *  `player.walls` when missing. */
  wallOverrides?: readonly Set<number>[];
  /** Battle territory snapshot (cloned). Omit for non-battle transitions. */
  battleTerritory?: readonly Set<number>[];
  /** Battle walls snapshot (cloned). Omit for non-battle transitions. */
  battleWalls?: readonly Set<number>[];
}

/** Atomically capture the full prev-scene for a banner transition.
 *  Call BEFORE any state mutations. Returns an immutable `BannerSnapshot`. */
export function createBannerSnapshot(
  state: GameState,
  opts?: SnapshotOpts,
): BannerSnapshot {
  return {
    castles: snapshotCastles(state, opts?.wallOverrides),
    entities: snapshotEntities(state),
    territory: opts?.battleTerritory?.map((territory) => new Set(territory)),
    walls: opts?.battleWalls?.map((wall) => new Set(wall)),
  };
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

/** Snapshot castle data for all players with a castle.
 *  @param wallOverrides — Per-player wall sets (e.g. pre-sweep walls); falls
 *    back to player.walls when the slot is missing or the array is undefined. */
function snapshotCastles(
  state: GameState,
  wallOverrides?: readonly Set<number>[],
): CastleData[] {
  return state.players
    .filter((player) => player.castle)
    .map((player) => ({
      walls: wallOverrides?.[player.id] ?? new Set(player.walls),
      interior: brandFreshInterior(new Set(player.interior)),
      cannons: player.cannons.map((c) => ({ ...c })),
      playerId: player.id,
    }));
}
