import type { EntityOverlay } from "./overlay-types.ts";
import { type CastleData, type GameState, Phase } from "./types.ts";
import { fireOnce } from "./utils.ts";

export interface BannerState {
  active: boolean;
  progress: number;
  text: string;
  subtitle?: string;
  callback: (() => void) | null;
  /** Scene snapshots for banner crossfade animation:
   *  prev* = frozen before checkpoint applies, new* = revealed after banner lifts. */
  prevCastles?: CastleData[];
  prevTerritory?: Set<number>[];
  prevWalls?: Set<number>[];
  /** Snapshot of all map entities at banner start — used to keep the scene
   *  stable while applyCheckpoint mutates live state behind the banner. */
  prevEntities?: EntityOverlay;
  newTerritory?: Set<number>[];
  newWalls?: Set<number>[];
  /** Pre-sweep wall snapshot; consumed by showBannerTransition for the old scene. */
  wallsBeforeSweep?: Set<number>[];
}

interface ShowBannerDeps {
  banner: BannerState;
  state: GameState;
  battleAnim: { territory: Set<number>[]; walls: Set<number>[] };
  text: string;
  subtitle?: string;
  onDone: () => void;
  /** When true, snapshot old castles/territory/walls before transitioning
   *  so the banner can show a before/after visual comparison. */
  preservePrevScene?: boolean;
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] };
  setModeBanner: () => void;
}

export type BannerShow = (
  text: string,
  onDone: () => void,
  preservePrevScene?: boolean,
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
  subtitle?: string,
) => void;

export const BANNER_PLACE_CANNONS = "Place Cannons";
export const BANNER_PLACE_CANNONS_SUB = "Position inside fort walls";
export const BANNER_BATTLE = "Prepare for Battle";
export const BANNER_BATTLE_SUB = "Shoot at enemy walls";
export const BANNER_BUILD = "Build & Repair";
export const BANNER_BUILD_SUB = "Surround castles, repair walls";
export const BANNER_SELECT = "Select your home castle";
/** Online-specific variants — shorter text for multi-player context. */
export const BANNER_BATTLE_ONLINE = "Battle!";
export const BANNER_REPAIR_ONLINE = "Repair!";

export function createBannerState(): BannerState {
  return {
    active: false,
    progress: 0,
    text: "",
    callback: null,
  };
}

export function showBannerTransition(deps: ShowBannerDeps): void {
  const {
    banner,
    state,
    battleAnim,
    text,
    subtitle,
    onDone,
    preservePrevScene = false,
    newBattle,
    setModeBanner,
  } = deps;

  // Consume pre-sweep wall snapshot if stashed before finalizeBuildPhase
  const pendingWalls = banner.wallsBeforeSweep;
  banner.wallsBeforeSweep = undefined;

  if (preservePrevScene) {
    banner.prevCastles ??= snapshotCastles(state, pendingWalls);
    banner.prevTerritory ??=
      state.phase === Phase.BATTLE
        ? battleAnim.territory?.map((territory) => new Set(territory))
        : undefined;
    banner.prevWalls ??=
      state.phase === Phase.BATTLE
        ? battleAnim.walls?.map((wall) => new Set(wall))
        : undefined;
    banner.prevEntities ??= snapshotEntities(state);
  } else {
    banner.prevCastles = undefined;
    banner.prevTerritory = undefined;
    banner.prevWalls = undefined;
    banner.prevEntities = undefined;
  }

  banner.newTerritory = newBattle?.territory;
  banner.newWalls = newBattle?.walls;
  banner.active = true;
  banner.progress = 0;
  banner.text = text;
  banner.subtitle = subtitle;
  banner.callback = onDone;
  setModeBanner();
}

/** Pre-capture old battle scene into banner state before nextPhase/checkpoint
 *  mutates the game state.  Must be called while state.phase is still BATTLE.
 *  showBannerTransition uses ??= so these pre-set values survive intact. */
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
  };
}

export function tickBannerTransition(
  banner: BannerState,
  dt: number,
  bannerDuration: number,
  render: () => void,
): void {
  banner.progress = Math.min(1, banner.progress + dt / bannerDuration);
  render();

  if (banner.progress < 1) return;

  banner.prevCastles = undefined;
  banner.prevTerritory = undefined;
  banner.prevWalls = undefined;
  banner.prevEntities = undefined;
  banner.newTerritory = undefined;
  banner.newWalls = undefined;
  banner.active = false;
  fireOnce(banner, "callback", "banner.callback");
}
