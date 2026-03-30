/**
 * Shared render overlay types — extracted from render-map.ts to break
 * circular dependencies between render-map and render-effects/towers/ui.
 */

import type {
  Crosshair,
  PiecePlacementPreview,
} from "./controller-interfaces.ts";
import type { House, PixelPos, RGB, TilePos, Tower } from "./geometry-types.ts";
import {
  type BurningPit,
  CannonMode,
  type CastleData,
  type GameOverFocus,
  type Grunt,
  type Impact,
  type LifeLostChoice,
} from "./types.ts";

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

export interface PlayerStats {
  wallsDestroyed: number;
  cannonsKilled: number;
}

/** Game-over overlay data shared by FrameData and UIOverlay. */
export interface GameOverOverlay {
  winner: string;
  scores: {
    name: string;
    score: number;
    color: RGB;
    eliminated: boolean;
    territory?: number;
    stats?: PlayerStats;
  }[];
  focused: GameOverFocus;
}

/** Per-frame data written by tick functions, read by render(). */
export interface FrameData {
  crosshairs: Crosshair[];
  phantoms: {
    aiPhantoms?: {
      offsets: [number, number][];
      row: number;
      col: number;
      playerId: number;
    }[];
    humanPhantoms?: PiecePlacementPreview[];
    aiCannonPhantoms?: {
      row: number;
      col: number;
      valid: boolean;
      mode: CannonMode;
      playerId: number;
      facing?: number;
    }[];
    phantomPiece?: {
      offsets: [number, number][];
      row: number;
      col: number;
      valid: boolean;
      playerId?: number;
    } | null;
  };
  announcement?: string;
  gameOver?: GameOverOverlay;
}

/** Life-lost dialog overlay data shared by UIOverlay and render-composition. */
export interface LifeLostDialogOverlay {
  entries: {
    playerId: number;
    name: string;
    lives: number;
    color: RGB;
    choice: LifeLostChoice;
    focused: number;
    px: number;
    py: number;
  }[];
  timer: number;
  maxTimer: number;
}

export interface MapData {
  tiles: number[][];
  towers: Tower[];
  junction: PixelPos;
}

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

/** Build/cannon phase — piece and cannon placement previews.
 *
 *  `valid` field (on phantomPiece, humanPhantoms, aiCannonPhantoms):
 *  true = placement is legal (rendered at normal color/alpha).
 *  false = illegal placement. Visual feedback differs by phantom type:
 *    - Piece phantoms: rendered with PHANTOM_INVALID_COLOR (red tint)
 *    - Cannon phantoms: rendered with reduced alpha (0.5)
 *  This asymmetry is intentional — cannon phantoms use alpha because they
 *  already have a colored fill that would clash with a red overlay. */
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
    mode: CannonMode;
    playerId: number;
    facing?: number;
  }[];
}

/** Battle phase — projectiles, effects, territory state. */
export interface BattleOverlay {
  /** True when battle visuals should render (battle phase or banner with battle snapshot).
   *  Use this instead of duck-typing `!!battleTerritory`. */
  inBattle?: boolean;
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

/** UI overlays — banners, announcements, game over, player select. */
export interface UIOverlay {
  announcement?: string;
  banner?: { text: string; subtitle?: string; y: number };
  bannerOldCastles?: CastleData[];
  bannerOldBattleTerritory?: Set<number>[];
  bannerOldBattleWalls?: Set<number>[];
  bannerOldHouses?: House[];
  bannerOldBonusSquares?: TilePos[];
  gameOver?: GameOverOverlay;
  timer?: number;
  scoreDeltas?: {
    playerId: number;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
  scoreDeltaProgress?: number;
  statusBar?: {
    round: string;
    phase: string;
    timer: string;
    players: {
      score: number;
      cannons: number;
      lives: number;
      color: RGB;
      eliminated: boolean;
    }[];
  };
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

/**
 * Renderer abstraction — decouples game-runtime from Canvas 2D specifics.
 * Implement this interface to swap in a WebGL / 3D renderer.
 *
 * ### Coordinate spaces (from outermost to innermost)
 *
 * 1. **Client coords** — `MouseEvent.clientX/Y`, relative to browser viewport
 * 2. **Surface (world-pixel) coords** — game world at TILE_SIZE scale (0..GRID_COLS*TILE_SIZE)
 * 3. **Screen-pixel coords** — post-camera transform (viewport zoom/pan applied)
 * 4. **Container-CSS coords** — relative to the container `<div>`, for DOM positioning
 *
 * `clientToSurface` converts 1→2.  `screenToContainerCSS` converts 3→4.
 */
export interface RendererInterface {
  /** Draw one frame using whatever rendering backend is active. */
  drawFrame(
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ): void;
  /** Convert pointer event client coordinates (MouseEvent.clientX/Y) to
   *  surface world-pixel coordinates (tile grid at TILE_SIZE scale).
   *  Accounts for canvas position, letterboxing, and DPR. */
  clientToSurface(clientX: number, clientY: number): { x: number; y: number };
  /**
   * Convert screen-pixel coordinates (post-camera transform) to CSS coordinates
   * relative to the container element. Accounts for letterbox offset and scaling.
   * Used to position floating action buttons over the rendered surface.
   */
  screenToContainerCSS(sx: number, sy: number): { x: number; y: number };
  /** The element that receives pointer/touch events and cursor-style changes. */
  eventTarget: HTMLElement;
  /** Container element — parent of the surface, holds touch panels and overlays. */
  container: HTMLElement;
  /**
   * Optional loupe factory for touch devices.
   * Omit if the renderer handles magnification natively.
   */
  createLoupe?: (container: HTMLElement) => {
    update(visible: boolean, worldX: number, worldY: number): void;
  };
}
