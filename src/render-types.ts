/**
 * Shared render overlay types — extracted from map-renderer.ts to break
 * circular dependencies between map-renderer and render-effects/towers/ui.
 */

import type { GameOverOverlay, LifeLostDialogOverlay } from "./game-ui-types.ts";
import type { House, PixelPos, TilePos, Tower } from "./geometry-types.ts";
import type { RGB } from "./render-theme.ts";
import type { BurningPit, Cannon, Grunt, Impact } from "./types.ts";

export interface CastleData {
  /** Wall tile positions encoded as row*GRID_COLS+col. */
  walls: Set<number>;
  /** Interior tile positions encoded as row*GRID_COLS+col. */
  interior: Set<number>;
  /** Cannon positions (top-left of 2×2 or 3×3 super) with HP. */
  cannons: Cannon[];
  /** Player index (for color). */
  playerId: number;
}

export interface MapData {
  tiles: number[][];
  towers: Tower[];
  junction: PixelPos;
}

// ---------------------------------------------------------------------------
// Overlay sub-interfaces — grouped by purpose
// ---------------------------------------------------------------------------

/** Castle selection phase — tower highlighting and confirmation. */
export interface SelectionOverlay {
  /** Tower index in map.towers to highlight (cursor hover). */
  highlighted: number | null;
  /** Tower index in map.towers that is selected (confirmed). */
  selected: number | null;
  /** Per-player tower highlights for parallel castle selection. */
  highlights?: { towerIdx: number; playerId: number; confirmed?: boolean }[];
}

/** Map entities — present in all phases. */
export interface EntityOverlay {
  houses?: House[];
  grunts?: Grunt[];
  towerAlive?: boolean[];
  burningPits?: BurningPit[];
  bonusSquares?: TilePos[];
  /** Tower index → owner player id for home towers. */
  homeTowers?: Map<number, number>;
}

/** Build/cannon phase — piece and cannon placement previews. */
export interface PhantomOverlay {
  phantomPiece?: {
    offsets: [number, number][];
    row: number;
    col: number;
    valid: boolean;
    playerId?: number;
  } | null;
  humanPhantoms?: {
    offsets: [number, number][];
    row: number;
    col: number;
    valid: boolean;
    playerId: number;
  }[];
  aiPhantoms?: {
    offsets: [number, number][];
    row: number;
    col: number;
    playerId: number;
  }[];
  aiCannonPhantoms?: {
    row: number;
    col: number;
    valid: boolean;
    isSuper?: boolean;
    isBalloon?: boolean;
    playerId: number;
    facing?: number;
  }[];
}

/** Battle phase — projectiles, effects, territory state. */
export interface BattleOverlay {
  cannonballs?: {
    x: number;
    y: number;
    progress: number;
    incendiary?: boolean;
  }[];
  crosshairs?: {
    x: number;
    y: number;
    playerId: number;
    cannonReady?: boolean;
  }[];
  impacts?: Impact[];
  balloons?: {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    progress: number;
  }[];
  battleTerritory?: Set<number>[];
  battleWalls?: Set<number>[];
}

/** A single row in the options screen. */
export interface OptionEntry {
  name: string;
  value: string;
  editable: boolean;
}

/** A player column in the controls rebinding screen. */
export interface ControlsPlayer {
  name: string;
  color: RGB;
  bindings: string[];
}

/** UI overlays — banners, announcements, game over, player select. */
export interface UIOverlay {
  announcement?: string;
  banner?: { text: string; subtitle?: string; y: number };
  bannerOldCastles?: CastleData[];
  bannerOldBattleTerritory?: Set<number>[];
  bannerOldBattleWalls?: Set<number>[];
  gameOver?: GameOverOverlay;
  timer?: number;
  scoreDeltas?: { playerId: number; delta: number; total: number; cx: number; cy: number }[];
  statusBar?: { round: string; phase: string; timer: string; players: { score: number; cannons: number; lives: number; color: RGB; eliminated: boolean }[] };
  lifeLostDialog?: LifeLostDialogOverlay;
  optionsScreen?: {
    options: OptionEntry[];
    cursor: number;
    readOnly: boolean;
  };
  playerSelect?: {
    players: {
      name: string;
      color: RGB;
      joined: boolean;
      keyHint?: string;
    }[];
    timer: number;
    roomCode?: string;
  };
  controlsScreen?: {
    players: ControlsPlayer[];
    playerIdx: number;
    actionIdx: number;
    rebinding: boolean;
    actionNames: readonly string[];
  };
}

/** Full rendering overlay — composed from sub-interfaces. */
export interface RenderOverlay {
  selection?: SelectionOverlay;
  castles?: CastleData[];
  entities?: EntityOverlay;
  phantoms?: PhantomOverlay;
  battle?: BattleOverlay;
  ui?: UIOverlay;
}

/** Viewport rect in tile-pixel coordinates (before SCALE). null = full map. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}
