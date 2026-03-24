import type { House, TilePos } from "./geometry-types.ts";
import type { CastleData } from "./render-types.ts";
import type { GameState } from "./types.ts";
import { Phase } from "./types.ts";

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
}

export function createBannerState(): BannerState {
  return {
    active: false,
    progress: 0,
    text: "",
    callback: null,
  };
}

interface ShowBannerDeps {
  banner: BannerState;
  state: GameState;
  battleAnim: { territory: Set<number>[]; walls: Set<number>[] };
  text: string;
  subtitle?: string;
  onDone: () => void;
  reveal?: boolean;
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] };
  setModeBanner: () => void;
}

export function showBannerTransition(deps: ShowBannerDeps): void {
  const {
    banner,
    state,
    battleAnim,
    text,
    onDone,
    reveal = false,
    newBattle,
    setModeBanner,
  } = deps;

  if (reveal) {
    banner.oldCastles = state.players
      .filter((p) => p.castle)
      .map((p) => ({
        walls: new Set(p.walls),
        interior: new Set(p.interior),
        cannons: p.cannons.map((c) => ({ ...c })),
        playerId: p.id,
      }));
    banner.oldTerritory =
      state.phase === Phase.BATTLE
        ? battleAnim.territory?.map((s) => new Set(s))
        : undefined;
    banner.oldWalls =
      state.phase === Phase.BATTLE
        ? battleAnim.walls?.map((s) => new Set(s))
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
  banner.subtitle = deps.subtitle;
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
  const cb = banner.callback;
  banner.callback = null;
  if (cb) cb();
}
