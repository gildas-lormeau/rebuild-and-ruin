import type {
  BurningPit,
  Cannon,
  Crosshair,
  Grunt,
  Impact,
} from "../battle-types.ts";
import type { GameMap, House, TilePos, Viewport } from "../geometry-types.ts";
import type {
  CannonPhantom as RenderCannonPhantom,
  PiecePhantom as RenderPiecePhantom,
} from "../net/phantom-types.ts";
import type { ValidPlayerSlot } from "../player-slot.ts";
import type { FreshInterior } from "../player-types.ts";
import type { GameOverFocus, LifeLostChoice } from "./interaction-types.ts";
import type { RGB } from "./theme.ts";

export type { RenderCannonPhantom, RenderPiecePhantom };

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
    piecePhantoms?: RenderPiecePhantom[];
    cannonPhantoms?: RenderCannonPhantom[];
    defaultFacings?: ReadonlyMap<number, number>;
  };
  announcement?: string;
  gameOver?: GameOverOverlay;
}

/** Upgrade pick card data for rendering. */
export interface UpgradePickCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly focused: boolean;
  readonly picked: boolean;
  /** Seconds since this card was picked. 0 if not picked. Drives the
   *  reveal pulse in drawUpgradeCard. */
  readonly pulseAge: number;
}

/** Per-player upgrade pick entry for rendering. */
export interface UpgradePickPlayerEntry {
  readonly playerName: string;
  readonly color: RGB;
  readonly cards: UpgradePickCard[];
  readonly resolved: boolean;
  /** True for the entry that accepts local input (focus flash, keyboard hint). */
  readonly interactive: boolean;
}

/** Upgrade pick dialog overlay data. */
export interface UpgradePickOverlay {
  entries: UpgradePickPlayerEntry[];
  timer: number;
  maxTimer: number;
}

/** Life-lost dialog overlay data shared by UIOverlay and render-composition. */
export interface LifeLostDialogOverlay {
  entries: {
    playerId: ValidPlayerSlot;
    name: string;
    lives: number;
    color: RGB;
    choice: LifeLostChoice;
    focusedButton: number;
    px: number;
    py: number;
  }[];
  timer: number;
  maxTimer: number;
}

/** Castle selection phase — tower highlighting and confirmation. */
export interface SelectionOverlay {
  /** Tower index in map.towers to highlight (cursor hover). */
  highlighted: number | null;
  /** Tower index in map.towers that is selected (confirmed). */
  selected: number | null;
  /** Per-player tower highlights for parallel castle selection. */
  highlights?: {
    towerIdx: number;
    playerId: ValidPlayerSlot;
    confirmed?: boolean;
  }[];
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
  /** Frozen river tiles for rendering ice overlay. */
  frozenTiles?: ReadonlySet<number>;
  /** Sinkhole tiles for rendering dark pool overlay. */
  sinkholeTiles?: ReadonlySet<number>;
}

/** Build/cannon phase — piece and cannon placement previews.
 *
 *  `valid` field (on all phantom types):
 *  true = placement is legal (rendered at normal color/alpha).
 *  false = illegal placement (rendered dark gray at reduced alpha). */
export interface PhantomOverlay {
  piecePhantoms?: RenderPiecePhantom[];
  cannonPhantoms?: RenderCannonPhantom[];
  /** Default cannon facing per player — used by cannon phantom rendering. */
  defaultFacings?: ReadonlyMap<number, number>;
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
    mortar?: boolean;
  }[];
  crosshairs?: {
    x: number;
    y: number;
    playerId: ValidPlayerSlot;
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
  /** Master Builder lockout countdown (seconds remaining) shown center-screen.
   *  Set when the POV player is locked out; undefined/0 when inactive. */
  masterBuilderLockout?: number;
  banner?: {
    text: string;
    subtitle?: string;
    y: number;
    /** Modifier reveal diff — when set, the banner is a modifier reveal and
     *  the renderer should progressively highlight changed tiles. */
    modifierDiff?: {
      id: string;
      changedTiles: readonly number[];
      gruntsSpawned: number;
    };
  };
  /** Snapshot of castle state captured at banner start — immutable during animation.
   *  Used to render the "old" scene behind the banner while live state updates. */
  bannerPrevCastles?: CastleData[];
  /** Territory snapshot at banner start — do not mutate during animation. */
  bannerPrevTerritory?: Set<number>[];
  /** Walls snapshot at banner start — do not mutate during animation. */
  bannerPrevWalls?: Set<number>[];
  /** Entity state snapshot at banner start — do not mutate during animation. */
  bannerPrevEntities?: EntityOverlay;
  gameOver?: GameOverOverlay;
  timer?: number;
  scoreDeltas?: {
    playerId: ValidPlayerSlot;
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
    /** Active environmental modifier label (modern mode). */
    modifier?: string;
    /** Local player's active upgrade labels (modern mode). */
    upgrades?: string[];
    players: {
      score: number;
      cannons: number;
      lives: number;
      color: RGB;
      eliminated: boolean;
    }[];
  };
  comboFloats?: readonly { text: string; age: number }[];
  lifeLostDialog?: LifeLostDialogOverlay;
  upgradePick?: UpgradePickOverlay;
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
  /** Draw one frame using whatever rendering backend is active.
   *  @param now — Frame timestamp from `performance.now()`. Threaded through to all
   *    render functions for animations (flashing, waves, cursors). Never call
   *    `Date.now()` or `performance.now()` inside render code — use this value. */
  drawFrame(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ): void;
  /** Pre-compute terrain image caches so the first render of a new map
   *  doesn't stall the frame. Call after generating/receiving a map. */
  warmMapCache(map: GameMap): void;
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

/** Test seam: structured callbacks fired at high-level draw points so tests
 *  can assert on *what* was rendered (which `GameMap` reference, which target
 *  canvas) without inspecting pixel buffers. Threaded into the render-map
 *  factory via deps; production callers omit it.
 *
 *  - `terrainDrawn` fires right after `drawTerrain` runs. `target` is `"main"`
 *    for the live scene and `"banner"` for the cached banner prev-scene canvas.
 *    `mapRef` is the exact `GameMap` object passed to drawTerrain — for
 *    modifier reveal banners this is the snapshot map produced by
 *    `buildModifierSnapshotMap`, a *different* reference than the live map.
 */
export interface RenderObserver {
  terrainDrawn?(target: "main" | "banner", mapRef: GameMap): void;
}

export interface LoupeHandle {
  /** Update the loupe content — call from render(). */
  update: (visible: boolean, worldX: number, worldY: number) => void;
}

/** A cannon captured by a propaganda balloon — fires for the balloon owner during battle. */
export interface CastleData {
  /** Wall tile positions encoded as row*GRID_COLS+col. */
  walls: ReadonlySet<number>;
  /** Enclosed territory: grass tiles fully surrounded by walls (inverse flood-fill).
   *  Encoded as row*GRID_COLS+col. Used for cannon eligibility, grunt blocking, and scoring. */
  interior: FreshInterior;
  /** Cannon positions (top-left of 2×2 or 3×3 super) with HP. */
  cannons: Cannon[];
  /** Player index (for color). */
  playerId: ValidPlayerSlot;
  /** Wall tiles that absorbed one hit from Reinforced Walls upgrade.
   *  Rendered with a crack overlay so players can see which walls are weakened. */
  damagedWalls?: ReadonlySet<number>;
}

export interface PlayerStats {
  wallsDestroyed: number;
  cannonsKilled: number;
}

/** Create a fresh FrameData, preserving sticky fields from a previous frame.
 *  Sticky fields (gameOver) survive frame clears because they outlive a single tick.
 *  If you add a sticky field to FrameData, preserve it here. */
export function createEmptyFrameData(prev?: FrameData): FrameData {
  return {
    crosshairs: [],
    phantoms: {},
    ...(prev?.gameOver !== undefined ? { gameOver: prev.gameOver } : {}),
  };
}
