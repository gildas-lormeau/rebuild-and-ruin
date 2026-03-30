import type { House, TilePos } from "./geometry-types.ts";
import { type CastleData, fireOnce, type GameState, Phase } from "./types.ts";

export interface BannerState {
  active: boolean;
  progress: number;
  text: string;
  subtitle?: string;
  callback: (() => void) | null;
  oldCastles?: CastleData[];
  oldTerritory?: Set<number>[];
  oldWalls?: Set<number>[];
  oldHouses?: House[];
  oldBonusSquares?: TilePos[];
  newTerritory?: Set<number>[];
  newWalls?: Set<number>[];
  /** Pre-sweep wall snapshot; consumed by showBannerTransition for the old scene. */
  pendingOldWalls?: Set<number>[];
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
  preserveOldScene?: boolean;
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] };
  setModeBanner: () => void;
}

export type BannerShow = (
  text: string,
  onDone: () => void,
  preserveOldScene?: boolean,
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
    preserveOldScene = false,
    newBattle,
    setModeBanner,
  } = deps;

  // Consume pre-sweep wall snapshot if stashed before finalizeBuildPhase
  const pendingWalls = banner.pendingOldWalls;
  banner.pendingOldWalls = undefined;

  if (preserveOldScene) {
    banner.oldCastles = state.players
      .filter((player) => player.castle)
      .map((player) => ({
        walls: pendingWalls?.[player.id] ?? new Set(player.walls),
        interior: new Set(player.interior),
        cannons: player.cannons.map((c) => ({ ...c })),
        playerId: player.id,
      }));
    banner.oldTerritory =
      state.phase === Phase.BATTLE
        ? battleAnim.territory?.map((territory) => new Set(territory))
        : undefined;
    banner.oldWalls =
      state.phase === Phase.BATTLE
        ? battleAnim.walls?.map((wall) => new Set(wall))
        : undefined;
    banner.oldHouses ??= state.map.houses.map((h) => ({ ...h }));
    banner.oldBonusSquares ??= state.bonusSquares.map((b) => ({ ...b }));
  } else {
    banner.oldCastles = undefined;
    banner.oldTerritory = undefined;
    banner.oldWalls = undefined;
    banner.oldHouses = undefined;
    banner.oldBonusSquares = undefined;
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

export function tickBannerTransition(
  banner: BannerState,
  dt: number,
  bannerDuration: number,
  render: () => void,
): void {
  banner.progress = Math.min(1, banner.progress + dt / bannerDuration);
  render();

  if (banner.progress < 1) return;

  banner.oldCastles = undefined;
  banner.oldTerritory = undefined;
  banner.oldWalls = undefined;
  banner.oldHouses = undefined;
  banner.oldBonusSquares = undefined;
  banner.newTerritory = undefined;
  banner.newWalls = undefined;
  banner.active = false;
  fireOnce(banner, "callback", "banner.callback");
}
