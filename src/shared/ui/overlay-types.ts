import type {
  BurningPit,
  Cannon,
  Crosshair,
  Grunt,
  Impact,
  ThawingTile,
  WallBurn,
} from "../core/battle-types.ts";
import type { ModifierDiff } from "../core/game-constants.ts";
import type { BannerKind } from "../core/game-event-bus.ts";
import type { Phase } from "../core/game-phase.ts";
import type {
  GameMap,
  House,
  TilePos,
  Viewport,
} from "../core/geometry-types.ts";
import type {
  CannonPhantom as RenderCannonPhantom,
  PiecePhantom as RenderPiecePhantom,
} from "../core/phantom-types.ts";
import type { ValidPlayerSlot } from "../core/player-slot.ts";
import type { FreshInterior } from "../core/player-types.ts";
import type { GameOverFocus, LifeLostChoice } from "./interaction-types.ts";
import type { RGB } from "./theme.ts";

export type { RenderCannonPhantom, RenderPiecePhantom };

/** A renderer-produced scene snapshot used for the banner prev-scene
 *  cross-fade. Wraps the raw pixels only. */
export interface SceneCapture {
  readonly image: ImageData;
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
  houses?: readonly House[];
  grunts?: readonly Grunt[];
  towerAlive?: readonly boolean[];
  burningPits?: readonly BurningPit[];
  bonusSquares?: readonly TilePos[];
  /** Tower index → owner player id. Covers both a player's original home
   *  tower and any secondary towers they've enclosed. */
  ownedTowers?: Map<number, number>;
  /** Indices of the towers that are a player's *original* home tower.
   *  Used to pick the `home_tower` vs `secondary_tower` geometry; the
   *  ownership tint comes from `ownedTowers`. */
  homeTowerIndices?: ReadonlySet<number>;
  /** Frozen river tiles for rendering ice overlay. */
  frozenTiles?: ReadonlySet<number>;
  /** Recently thawed tiles — drives the crack-and-fade break animation. */
  thawingTiles?: readonly ThawingTile[];
  /** Sinkhole tiles for rendering dark pool overlay. */
  sinkholeTiles?: ReadonlySet<number>;
}

/** Build/cannon phase — piece and cannon placement previews.
 *
 *  `valid` field (on all phantom types):
 *  true = placement is legal (rendered at normal color/alpha).
 *  false = illegal placement (rendered dark gray at reduced alpha). */
export interface PhantomOverlay {
  piecePhantoms?: readonly RenderPiecePhantom[];
  cannonPhantoms?: readonly RenderCannonPhantom[];
  /** Default cannon facing per player — used by cannon phantom rendering. */
  defaultFacings?: ReadonlyMap<number, number>;
}

/** Cannonball in flight — overlay payload with animation progress. */
export interface OverlayCannonball {
  x: number;
  y: number;
  /** Launch point (world-pixel coords). Lets the 3D renderer size
   *  the arc apex proportionally to total flight distance. */
  startX: number;
  startY: number;
  /** Target tile center (world-pixel coords). Lets the 3D renderer
   *  compute target elevation so balls can arc onto wall tops
   *  instead of passing through the wall to the ground plane. */
  targetX: number;
  targetY: number;
  progress: number;
  incendiary?: boolean;
  mortar?: boolean;
}

/** Propaganda balloon flight — overlay payload with animation progress. */
export interface OverlayBalloon {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  progress: number;
}

/** Battle phase — projectiles, effects, territory state. */
export interface BattleOverlay {
  /** True when battle visuals should render (battle phase or banner with battle snapshot).
   *  Use this instead of duck-typing `!!battleTerritory`. */
  inBattle?: boolean;
  cannonballs?: readonly OverlayCannonball[];
  crosshairs?: readonly Crosshair[];
  impacts?: readonly Impact[];
  wallBurns?: readonly WallBurn[];
  balloons?: readonly OverlayBalloon[];
  battleTerritory?: readonly Set<number>[];
  battleWalls?: readonly Set<number>[];
  /** True when Fog of War is active — renderer blankets each castle's
   *  walls + interior with an animated fog layer so players must aim
   *  from memory. */
  fogOfWar?: boolean;
}

/** Banner sweep UI — shared shape returned by `createBannerUi` and
 *  used verbatim as `UIOverlay.banner`. */
export interface BannerUi {
  kind: BannerKind;
  text: string;
  subtitle?: string;
  /** Top edge of the banner strip (map-pixel coords, integer-rounded
   *  by `createBannerUi`). Consumers that need to clip above the
   *  sweep line use this. */
  top: number;
  /** Bottom edge of the banner strip (map-pixel coords, integer-rounded
   *  by `createBannerUi`). Consumers that need to clip below the
   *  sweep line use this. */
  bottom: number;
  /** Modifier-reveal diff — when set, the banner is a modifier reveal.
   *  Drives the recolored chrome (`render-ui.ts` palette) and the
   *  progressive tile-highlight animation in `drawModifierRevealHighlight`. */
  modifierDiff?: ModifierDiff;
  /** Pixel snapshot of the scene composited below the sweep line
   *  during the banner animation. */
  prevScene?: SceneCapture;
}

/** UI overlays — banners, announcements, game over, player select. */
export interface UIOverlay {
  announcement?: string;
  /** Master Builder lockout countdown (seconds remaining) shown center-screen.
   *  Set when the POV player is locked out; undefined/0 when inactive. */
  masterBuilderLockout?: number;
  banner?: BannerUi;
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
  /** Current game phase — surfaced here so renderers can pick view
   *  modes per phase without plumbing state through another channel. */
  phase?: Phase;
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
    pitch?: number,
  ): void;
  /** Pre-compute terrain image caches so the first render of a new map
   *  doesn't stall the frame. Call after generating/receiving a map. */
  warmMapCache(map: GameMap): void;
  /** Opt specific drawing layers in or out of `drawFrame`. Used by the 3D
   *  renderer to progressively take over the world-layer responsibilities
   *  the 2D renderer owned: Phase 2 flips off `terrain`, later phases flip
   *  off more. Omitted fields keep their current state. By default every
   *  layer is enabled, so 2D-mode behaviour is unchanged.
   *
   *  Layer semantics:
   *    - `terrain` — base grass/water pixels, water animation, frozen tiles,
   *      sinkhole overlays, bonus squares, and burning-pit glyphs. These are
   *      the tile-level visuals the 3D terrain mesh is taking over. Castle
   *      walls, interiors, and entity sprites are NOT part of `terrain`.
   *    - `walls` — castle wall tiles (stone brick pattern + bevels +
   *      reinforced-wall cracks) and wall-debris tiles (tiles in the
   *      original wall set but not in the current one). Phase 3 flips
   *      this off so the 3D wall meshes can take over. Interiors,
   *      cannons, and debris outside the wall set stay on the 2D path.
   *    - `interiors` — per-player checkered interior tiles out of
   *      battle and cobblestone tiles during battle. The 3D renderer
   *      flips this off so the terrain mesh can paint the interior
   *      colors into its vertex-color pass directly.
   *    - `towers` — live tower sprites only (neutral + home + selection
   *      highlights + player-name labels). Phase 3 flips this off so
   *      the 3D tower meshes can take over. Dead towers are NOT part
   *      of this layer — they render under `debris`.
   *    - `houses` — civilian dwelling sprites. Phase 3 flips this off
   *      so the 3D house meshes can take over. Destroyed houses are
   *      filtered in both 2D and 3D paths (the `alive` flag gates
   *      rendering).
   *    - `debris` — dead-wall rubble, dead-cannon debris, dead-tower
   *      rubble. A single flag covers all three rubble classes because
   *      they share one 3D scene builder and one entity manager. Phase
   *      3 flips this off so the 3D debris meshes can take over. The
   *      live-entity layers (`walls`, `towers`) are unaffected.
   *    - `cannons` — LIVE cannon sprites (normal/super/mortar/rampart,
   *      plus shield-aura overlays). Phase 4 flips this off so the 3D
   *      cannon meshes can take over. Dead cannons are NOT part of
   *      this layer — they render under `debris`. Balloon cannons are
   *      NOT part of this layer either — they render under `balloons`.
   *    - `grunts` — 1×1 neutral tank sprites. Phase 4 flips this off
   *      so the 3D grunt meshes can take over. Grunts are ownerless
   *      hazards; the 3D path rotates a single base variant by the
   *      grunt's facing (same convention as cannons).
   *    - `cannonballs` — in-flight projectile sprites (iron / fire /
   *      mortar). Phase 4 flips this off so the 3D cannonball meshes
   *      can take over. The 3D path mirrors the 2D parabolic arc:
   *      sprite grows/rises toward the apex, shrinks/falls back to
   *      ground by impact. Variant by type flags (mortar > incendiary
   *      > iron).
   *    - `pits` — burning-pit sprites (3-stage fresh/dim/embers
   *      variant swap driven by the pit's `roundsLeft` counter).
   *      Phase 4 flips this off so the 3D pit meshes can take over.
   *      The terrain mesh's brown "pit marker" tint stays on in both
   *      modes — it's framing beneath the sprite, not the sprite
   *      itself.
   *    - `balloons` — balloon cannon sprites in both states: the 2×2
   *      grounded `balloon_base` mooring and the 2×2 × 3-tall
   *      `balloon_flight` envelope. Phase 4 flips this off so the 3D
   *      balloon meshes can take over. A balloon is grounded by default
   *      and flight-only during the brief inter-round capture
   *      animation; both cases live under the same flag.
   *    - `impacts` — per-impact flash/ring/spark/smoke overlays drawn
   *      at the 2D `drawImpacts` site. Phase 6 flips this off so the
   *      3D impacts manager owns the visual. Impact timeline data
   *      (`Impact.age`) is unchanged — both renderers read the same
   *      game state.
   *    - `crosshairs` — per-player aim indicators drawn at the 2D
   *      `drawCrosshairs` site. Phase 6 flips this off so the 3D
   *      crosshairs manager owns the visual. Pulse + color math is
   *      identical; the 3D path renders each crosshair as ground-plane
   *      flat arms.
   *    - `fog` — fog-of-war blanket when `overlay.battle.fogOfWar`
   *      is set. Phase 6 flips this off so the 3D fog manager owns
   *      the visual.
   *    - `thawingTiles` — ice-thaw crack-and-fade animation over
   *      recently thawed tiles (`overlay.entities.thawingTiles`).
   *      Phase 6 flips this off so the 3D thawing manager owns the
   *      visual. Base ICE_COLOR on still-frozen tiles is owned by
   *      `terrain` (Phase 2).
   *    - `phantoms` — tetris-piece cell previews during `WALL_BUILD`
   *      and cannon footprint previews during `CANNON_PLACE`
   *      (`overlay.phantoms`). Phase 9 of the 3D migration flips this
   *      off so the 3D phantoms manager owns the visual. */
  setLayersEnabled(layers: {
    terrain?: boolean;
    walls?: boolean;
    interiors?: boolean;
    towers?: boolean;
    houses?: boolean;
    debris?: boolean;
    cannons?: boolean;
    grunts?: boolean;
    cannonballs?: boolean;
    pits?: boolean;
    balloons?: boolean;
    impacts?: boolean;
    crosshairs?: boolean;
    fog?: boolean;
    thawingTiles?: boolean;
    phantoms?: boolean;
  }): void;
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
  /** Capture the current offscreen scene as ImageData for banner prev-scene.
   *  Returns undefined when the scene canvas hasn't been initialized. */
  captureScene(): ImageData | undefined;
  /** True when the renderer is currently animating a cannon-facing ease
   *  (e.g. the post-battle rotation back to `defaultFacing`). The runtime
   *  polls this to gate the battle-end transition on the ease completing
   *  — frame-synced with render, unlike a wall-clock timer. Renderers
   *  that don't ease facings (2D, headless stubs) return `false`. */
  isCannonRotationEasing(): boolean;
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
 *  canvas, at what clip offset) without inspecting pixel buffers. Threaded
 *  into the render-map factory via deps; production callers omit it.
 *
 *  - `terrainDrawn` fires right after `drawTerrain` runs. `target` is `"main"`
 *    for the live scene and `"banner"` for the cached banner prev-scene canvas.
 *    `mapRef` is the exact `GameMap` object passed to drawTerrain — for
 *    modifier reveal banners this is the snapshot map produced by
 *    `buildModifierSnapshotMap`, a *different* reference than the live map.
 *
 *  - `bannerComposited` fires on every frame the banner prev-scene is
 *    composited onto the main scene canvas (inside `drawBannerPrevScene`,
 *    before `ctx.restore()`). Reports the exact `clipY` passed to the clip
 *    rect — the cutoff between "new scene above" and "old scene below".
 *    Fires after the cached banner canvas has been drawn, so tests can
 *    reconstruct the on-screen pixel grid by combining `clipY` with the
 *    two `GameMap` references captured via `terrainDrawn`.
 */
export interface RenderObserver {
  terrainDrawn?(target: "main" | "banner", mapRef: GameMap): void;
  bannerComposited?(info: {
    /** Y coordinate of the top edge of the OLD-scene clip region. Tiles
     *  whose full extent is below this line render from the banner canvas
     *  (snapshot map); tiles above it render from the main canvas (live
     *  map). Equals `banner.top` — the sweep-strip top edge is the
     *  clip boundary. */
    readonly clipY: number;
    /** Map pixel height (H) used by the renderer. Combine with `clipY` to
     *  compute which rows fall in the old vs new region. */
    readonly H: number;
    /** Map pixel width (W). Mirrors the clip-rect width. */
    readonly W: number;
    /** Banner height in pixels (`Math.round(H * BANNER_HEIGHT_RATIO)`). */
    readonly bannerH: number;
  }): void;
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
