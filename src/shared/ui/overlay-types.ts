import type {
  BurningPit,
  Cannon,
  CannonDestroy,
  CannonMode,
  Crosshair,
  Grunt,
  GruntKill,
  HouseDestroy,
  Impact,
  ThawingTile,
  WallBurn,
} from "../core/battle-types.ts";
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

/** A renderer-produced scene snapshot used for the banner prev/new-scene
 *  sweep. Wraps a dedicated offscreen canvas owned by the renderer — not
 *  raw pixels — so the banner sweep can drawImage from it directly at
 *  display resolution without a getImageData/putImageData round-trip. */
export interface SceneCapture {
  readonly canvas: HTMLCanvasElement;
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
  /** Progressive-reveal clip rect, set by the overlay builder when a banner
   *  is sweeping past the dialog. When present, the renderer clips to
   *  `(0, rectTop, W, rectBottom - rectTop)` and suppresses interactive UI
   *  (timer bar + keyboard hint). When absent, the dialog paints fullscreen
   *  with interactive UI shown. The semantic mapping from banner kind to
   *  reveal direction (upgrade-pick banner reveals above the strip, build
   *  banner hides below) lives in the builder, not the renderer. */
  fadeMask?: { rectTop: number; rectBottom: number };
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
  /** Current cannon tier per player — lets the 3D cannon-phantom picker
   *  match the authored sprite of the actual cannon that will be placed. */
  cannonTiers?: ReadonlyMap<number, 1 | 2 | 3>;
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
  /** Altitude (world units) on the ballistic arc. The sim writes this
   *  directly each tick from the pinned trajectory — the renderer reads
   *  it rather than faking a sin-based arc. */
  altitude: number;
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
  cannonDestroys?: readonly CannonDestroy[];
  gruntKills?: readonly GruntKill[];
  houseDestroys?: readonly HouseDestroy[];
  balloons?: readonly OverlayBalloon[];
  battleTerritory?: readonly Set<number>[];
  battleWalls?: readonly Set<number>[];
  /** True when Fog of War is active — renderer blankets each castle's
   *  walls + interior with an animated fog layer so players must aim
   *  from memory. */
  fogOfWar?: boolean;
  /** Opacity multiplier for the fog overlay during the modifier reveal,
   *  in [0, 1]. Computed runtime-side in `deriveFogRevealOpacity` and
   *  applied by the fog manager to its base + band material alphas.
   *  Steady-state (no reveal in flight) is `undefined` — the manager
   *  treats undefined as 1 (no override). */
  fogRevealOpacity?: number;
  /** Global opacity multiplier for held rubble-clearing entities (pits +
   *  dead cannon debris) during the modifier reveal, in [0, 1]. `1` =
   *  full opacity (snapshot capture); ramps to `0` (invisible) over the
   *  post-banner window so the entities visibly fade out. `undefined`
   *  outside the rubble_clearing reveal window. Pits and debris managers
   *  also iterate `heldRubblePits` / `heldDeadCannons` to render the
   *  entries that gameplay state has already dropped. */
  rubbleClearingFade?: number;
  /** Held burning pits to keep rendering during the rubble-clearing fade
   *  even though gameplay state has dropped them. Read by the pit
   *  manager alongside `entities.burningPits`; faded by
   *  `rubbleClearingFade`. */
  heldRubblePits?: readonly BurningPit[];
  /** Held dead-cannon footprints for the rubble-clearing fade. Read by
   *  the debris manager alongside the live `player.cannons` dead
   *  entries; faded by `rubbleClearingFade`. */
  heldDeadCannons?: readonly {
    ownerId: ValidPlayerSlot;
    col: number;
    row: number;
    mode: CannonMode;
    mortar?: boolean;
    tier: 1 | 2 | 3;
  }[];
  /** True when Frostbite is active — renderer tints all grunts pale cyan
   *  to read as ice cubes (immobile, two hits to break). */
  frostbite?: boolean;
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
  /** Opaque accent-palette key. The renderer indexes this into its
   *  palette table to recolor the banner chrome (border + title).
   *  Undefined = default palette. The banner system treats this as an
   *  uninterpreted string. */
  paletteKey?: string;
  /** Pixel snapshot of the scene composited below the sweep line
   *  during the banner animation (the old scene, captured before the
   *  phase mutation that the banner is announcing). */
  prevScene?: SceneCapture;
  /** Pixel snapshot of the scene revealed above the sweep line during
   *  the banner animation (the new scene, captured after the phase
   *  mutation). Both snapshots are frozen for the duration of the
   *  sweep — the live renderer does not repaint world contents. */
  newScene?: SceneCapture;
  /** Sweep progress in [0, 1]. Reaches 1 when the sweep finishes; stays
   *  at 1 through the dwell until hideBanner. Read by post-banner
   *  effects (e.g. modifier reveal animations) that wait for sweep
   *  completion. */
  progress: number;
  /** Convenience flag: `progress >= 1`. True once the sweep has fully
   *  revealed the new scene; stays true through the dwell. Effects that
   *  only care about "has the sweep finished?" should read this. */
  swept: boolean;
}

/** UI overlays — banners, announcements, game over, player select. */
export interface UIOverlay {
  announcement?: string;
  /** Master Builder lockout countdown (seconds remaining) shown center-screen.
   *  Set when the POV player is locked out; undefined/0 when inactive. */
  masterBuilderLockout?: number;
  banner?: BannerUi;
  /** Active modifier's reveal data — drives the pulsing tile overlay
   *  during the `MODIFIER_REVEAL` dwell phase. Populated by
   *  `refreshOverlay` from `state.modern` when the phase is active;
   *  undefined otherwise. */
  modifierReveal?: {
    /** Opaque key for `MODIFIER_COLORS` palette lookup in render-ui. */
    paletteKey: string;
    /** Tile keys (row * GRID_COLS + col) the modifier touched. */
    tiles: readonly number[];
  };
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
  /** Zone-by-player-slot mapping. Stable for the entire match (set once at
   *  game start). Renderers use `playerByZone()` to resolve a tile's zone
   *  to its owning player slot — encodes the river-isolation invariant
   *  that each zone has at most one player. */
  playerZones?: readonly number[];
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
    /** When true, skip the 3D scene pipeline (entity updates + WebGL
     *  render) and only draw the 2D canvas. Set during banners — the
     *  2D canvas composites a pre-captured scene snapshot over
     *  everything below the banner strip, so a live 3D re-render
     *  would be fully occluded anyway. The 2D-only renderer ignores
     *  this flag (nothing to skip). */
    skip3DScene?: boolean,
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
  /** Capture the current display's game area into a banner-owned bridge
   *  canvas and return it (banner prev-scene A-snapshot). Returns
   *  undefined when the scene canvas hasn't been initialized. */
  captureScene(): HTMLCanvasElement | undefined;
  /** Flash-free post-mutation capture for the banner's new-scene (B) snapshot.
   *  Runs the full render pipeline against offscreen targets only — the
   *  visible canvas is NEVER written, so the user never sees the
   *  post-mutation scene before the banner's progressive reveal reaches it.
   *  3D mode renders the WebGL scene into an FBO and reads it back via
   *  `readRenderTargetPixels` (skipping the fullscreen-quad blit to the
   *  default framebuffer); 2D mode draws into a hidden sibling canvas.
   *  Result is copied into a banner-owned bridge canvas and returned.
   *  Returns undefined when no scene has been rendered yet (pre-first-frame
   *  or in headless stubs). */
  captureSceneOffscreen(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
    pitch?: number,
  ): HTMLCanvasElement | undefined;
  /** Install the runtime's cannon-facing accessor. Called once during
   *  composition with the cannon-animator's `getDisplayed`; renderers
   *  that ease cannon facings (3D) read displayed values through it,
   *  renderers that don't (2D, headless stub) can omit this method. */
  setCannonFacingProvider?(
    fn: (col: number, row: number) => number | undefined,
  ): void;
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
  /** Current cannon tier for this player (derived from lives lost — 1 at
   *  full lives, 2 after one loss, 3 on the last life). The 3D renderer
   *  swaps regular cannons to the matching `tier_N` sprite; the 2D path
   *  uses a single sprite and ignores this field. */
  cannonTier: 1 | 2 | 3;
}

export interface PlayerStats {
  wallsDestroyed: number;
  cannonsKilled: number;
}

/** Build a tile-key → owning player map from the overlay. Hides the
 *  build/battle source split: in battle the snapshot lives in
 *  `overlay.battle.battleTerritory[pid]`; out of battle the live owners
 *  come from each castle's `interior` set. Renderers iterate the result
 *  per-tile to color castle interiors and owned-sinkhole banks. Walls
 *  are NOT included — callers that need them build a separate set. */
export function interiorOwnersFromOverlay(
  overlay: RenderOverlay | undefined,
): Map<number, ValidPlayerSlot> {
  const owners = new Map<number, ValidPlayerSlot>();
  if (!overlay) return owners;
  if (overlay.battle?.inBattle) {
    const territories = overlay.battle.battleTerritory;
    if (territories) {
      for (let pid = 0; pid < territories.length; pid++) {
        const territory = territories[pid];
        if (!territory) continue;
        const playerSlot = pid as unknown as ValidPlayerSlot;
        for (const key of territory) owners.set(key, playerSlot);
      }
    }
  } else if (overlay.castles) {
    for (const castle of overlay.castles) {
      for (const key of castle.interior) owners.set(key, castle.playerId);
    }
  }
  return owners;
}
