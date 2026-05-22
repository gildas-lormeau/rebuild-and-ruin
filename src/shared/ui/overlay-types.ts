import type {
  BurningPit,
  Cannon,
  CannonDestroy,
  CannonMode,
  Crosshair,
  DestroyedWall,
  Grunt,
  GruntKill,
  HouseDestroy,
  Impact,
  ShieldFlash,
  ThawingTile,
} from "../core/battle-types.ts";
import type { ModifierId } from "../core/game-constants.ts";
import { Phase } from "../core/game-phase.ts";
import type {
  GameMap,
  TilePos,
  TowerIdx,
  Viewport,
} from "../core/geometry-types.ts";
import type { TileKey } from "../core/grid.ts";
import type { SupplyBonusId } from "../core/modifier-defs.ts";
import type {
  CannonPhantom as RenderCannonPhantom,
  PiecePhantom as RenderPiecePhantom,
} from "../core/phantom-types.ts";
import type { ValidPlayerId } from "../core/player-slot.ts";
import type { FreshInterior } from "../core/player-types.ts";
import type { BannerContent, SceneCapture } from "./banner-content.ts";
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
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly focused: boolean;
  readonly picked: boolean;
  /** Seconds since this card was picked. 0 if not picked. Drives the
   *  reveal pulse in drawUpgradeCard. */
  readonly pulseAge: number;
}

interface UpgradePickPlayerEntry {
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
    playerId: ValidPlayerId;
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
interface SelectionOverlay {
  /** Tower index in map.towers to highlight (cursor hover). */
  highlighted: TowerIdx | null;
  /** Tower index in map.towers that is selected (confirmed). */
  selected: TowerIdx | null;
  /** Per-player tower highlights for parallel castle selection. */
  highlights?: {
    towerIdx: TowerIdx;
    playerId: ValidPlayerId;
    confirmed?: boolean;
  }[];
}

/** Map entities — present in all phases. */
interface EntityOverlay {
  grunts?: readonly Grunt[];
  towerAlive?: readonly boolean[];
  burningPits?: readonly BurningPit[];
  bonusSquares?: readonly TilePos[];
  /** Tower index → owner player id. Covers both a player's original home
   *  tower and any secondary towers they've enclosed. */
  ownedTowers?: Map<TowerIdx, ValidPlayerId>;
  /** Indices of the towers that are a player's *original* home tower.
   *  Used to pick the `home_tower` vs `secondary_tower` geometry; the
   *  ownership tint comes from `ownedTowers`. */
  homeTowerIndices?: ReadonlySet<TowerIdx>;
  /** Frozen river tiles for rendering ice overlay. */
  frozenTiles?: ReadonlySet<TileKey>;
  /** Recently thawed tiles — drives the crack-and-fade break animation. */
  thawingTiles?: readonly ThawingTile[];
  /** High-tide flooded tiles for rendering water over grass. Computed
   *  by the overlay builder from the static map when the modifier is
   *  active (see `computeFloodedTiles`); not stored on state.modern,
   *  not serialized. */
  floodedTiles?: ReadonlySet<TileKey>;
  /** Low-water exposed riverbed tiles for rendering bank/grass over
   *  water. Read from `state.modern.exposedRiverbedTiles` (RNG-shuffled
   *  per draw, so it is stored, not derived). */
  exposedRiverbedTiles?: ReadonlySet<TileKey>;
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
  defaultFacings?: ReadonlyMap<ValidPlayerId, number>;
  /** Current cannon tier per player — lets the 3D cannon-phantom picker
   *  match the authored sprite of the actual cannon that will be placed. */
  cannonTiers?: ReadonlyMap<ValidPlayerId, 1 | 2 | 3>;
}

/** Cannonball in flight — overlay payload with animation progress. */
export interface OverlayCannonball {
  x: number;
  y: number;
  /** Launch point (world-pixel coords). Lets the 3D renderer size
   *  the arc apex proportionally to total flight distance. */
  startX: number;
  startY: number;
  progress: number;
  /** Altitude (world units) on the ballistic arc. The sim writes this
   *  directly each tick from the pinned trajectory — the renderer reads
   *  it rather than faking a sin-based arc. */
  altitude: number;
  incendiary?: true;
  mortar?: true;
}

/** Propaganda balloon flight — overlay payload with animation progress. */
export interface OverlayBalloon {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  progress: number;
}

/** Supply-ship render projection. `bonus` is populated only when the
 *  ship is sinking — alive ships keep their bonus hidden from the
 *  renderer (and therefore from the player). The 3D manager reads
 *  position + facing each frame, drives idle bob, and runs the sink
 *  animation when `sinking` is present. The 2D UI layer reads `bonus`
 *  during the sink to render a floating reveal label. */
export interface OverlaySupplyShip {
  readonly id: number;
  /** World-pixel position (col * TILE_SIZE + offset). */
  readonly x: number;
  /** World-pixel position (row * TILE_SIZE + offset). Maps to scene Z. */
  readonly y: number;
  /** Facing direction in radians; 0 = +X. */
  readonly headingRad: number;
  /** Remaining HP as a fraction (1 = pristine, 0.5 = damaged, 0 = sinking). */
  readonly hpFrac: number;
  /** Sink animation progress (0 → 1). Absent while alive. */
  readonly sinking?: { readonly progress: number };
  /** Awarded bonus, revealed when the ship is sinking. Absent while alive
   *  so the cargo stays hidden through gameplay. */
  readonly bonus?: SupplyBonusId;
}

/** Battle phase — projectiles, effects, territory state. */
export interface BattleOverlay {
  cannonballs?: readonly OverlayCannonball[];
  crosshairs?: readonly Crosshair[];
  impacts?: readonly Impact[];
  destroyedWalls?: readonly DestroyedWall[];
  cannonDestroys?: readonly CannonDestroy[];
  gruntKills?: readonly GruntKill[];
  houseDestroys?: readonly HouseDestroy[];
  /** Tiles where a defensive shield (rampart radius or Shield Battery)
   *  just absorbed an incoming hit — drives the cyan absorb-ring ping. */
  shieldFlashes?: readonly ShieldFlash[];
  balloons?: readonly OverlayBalloon[];
  battleTerritory?: readonly Set<TileKey>[];
  battleWalls?: readonly ReadonlySet<TileKey>[];
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
  /** True when Dust Storm is active — renderer blankets the playfield
   *  with a translucent sand-tinted haze and shader-driven streaks
   *  that oscillate left-right to telegraph the symmetric ±15° launch
   *  jitter. */
  dustStorm?: boolean;
  /** Sway-amplitude multiplier for the dust-storm streak oscillation
   *  during the modifier reveal, in [0, ~1]. Computed runtime-side in
   *  `deriveDustStormSwayAmplitude` (cosine bell `PEAK · sin²(t·π)`:
   *  0 → peak → 0 across the reveal window so the streaks are settled
   *  at the BATTLE-banner snapshot moment). Steady-state (no reveal
   *  in flight) is `undefined` — the manager treats undefined as 1
   *  and lerps to it, giving a smooth ramp-in to full battle swing. */
  dustStormSwayAmplitude?: number;
  /** Sway phase (radians) during the dust-storm modifier reveal —
   *  advances linearly 0 → π across the reveal window via
   *  `deriveDustStormSwayPhaseRad`. Locked to the same `revealTimeMs`
   *  source as the amplitude so the two stay synchronized; the
   *  manager assigns this directly to its phase accumulator while
   *  the field is defined. Once it goes `undefined` (battle), the
   *  manager continues advancing its accumulator at the same angular
   *  speed from wherever reveal left off. */
  dustStormSwayPhaseRad?: number;
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
    ownerId: ValidPlayerId;
    col: number;
    row: number;
    mode: CannonMode;
    mortar?: true;
    tier: 1 | 2 | 3;
  }[];
  /** Frostbite-reveal tint intensity in `[0, 1]` while the modifier
   *  reveal is in flight. `0` = grunts at authored color, `1` = full
   *  frostbite tint. `undefined` outside the reveal window — the
   *  grunt manager falls back to the binary `frostbite` flag. */
  frostbiteRevealProgress?: number;
  /** True when Frostbite is active — renderer tints all grunts pale cyan
   *  to read as ice cubes (immobile, two hits to break). */
  frostbite?: boolean;
  /** Sapper threat-tint mix factor [0, 1] during the modifier reveal —
   *  walls in `sapperTargetedWalls` lerp toward copper by this amount.
   *  Undefined outside the reveal window. */
  sapperRevealIntensity?: number;
  /** Wall tile keys grunts will attack this battle (sapper modifier).
   *  Exposed alongside `sapperRevealIntensity` so the walls manager
   *  knows which slots to tint. Undefined outside the reveal. */
  sapperTargetedWalls?: readonly TileKey[];
  /** Grunt-surge fresh-grunt tint mix factor [0, 1] during the
   *  modifier reveal — grunts whose tile is in `gruntSurgeSpawnTiles`
   *  lerp toward red by this amount. Undefined outside the reveal. */
  gruntSurgeRevealIntensity?: number;
  /** Tile keys where surge grunts spawned this round. Exposed
   *  alongside `gruntSurgeRevealIntensity` so the grunt manager knows
   *  which slots to tint. Stable across the MODIFIER_REVEAL phase
   *  (grunts don't move pre-battle). */
  gruntSurgeSpawnTiles?: readonly TileKey[];
  /** Supply ships sailing the Y-river during battle. Undefined when no
   *  supply_ship modifier is active or when the ship list is empty. */
  supplyShips?: readonly OverlaySupplyShip[];
}

/** Banner sweep UI — shared shape returned by `createBannerUi` and
 *  used verbatim as `UIOverlay.banner`. */
export interface BannerUi extends BannerContent {
  /** Top edge of the banner strip (map-pixel coords, integer-rounded
   *  by `createBannerUi`). Consumers that need to clip above the
   *  sweep line use this. */
  top: number;
  /** Bottom edge of the banner strip (map-pixel coords, integer-rounded
   *  by `createBannerUi`). Consumers that need to clip below the
   *  sweep line use this. */
  bottom: number;
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
   *  `refreshOverlay` from `state.modern` plus the resolved
   *  `revealTimeMs` scalar; undefined otherwise. The single banner-aware
   *  resolution lives in `modifier-reveal-time.ts`. */
  modifierReveal?: {
    /** Active modifier id — burst managers gate on this. */
    modifierId: ModifierId;
    /** Reveal time in ms — `0` during the snapshot window, `>0` during
     *  the playing window. See `modifier-reveal-time.ts`. The single
     *  banner-aware site computes this; consumers see only the number. */
    revealTimeMs: number;
    /** Tile keys (row * GRID_COLS + col) the modifier touched. */
    tiles: readonly TileKey[];
  };
  gameOver?: GameOverOverlay;
  timer?: number;
  scoreDeltas?: {
    playerId: ValidPlayerId;
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
  lobby?: {
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
    playerIdx: ValidPlayerId;
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
    /** When true, skip the 3D scene pipeline (entity updates + WebGL
     *  render) and only draw the 2D canvas. Set during banners — the
     *  2D canvas composites a pre-captured scene snapshot over
     *  everything below the banner strip, so a live 3D re-render
     *  would be fully occluded anyway. The 2D-only renderer ignores
     *  this flag (nothing to skip). */
    skip3DScene?: boolean,
    /** Battle-progress sun parameter ∈ [0, 1] when the active phase is
     *  BATTLE; `undefined` otherwise. Drives the sun's direction arc
     *  (dawn-east → near-zenith → dusk-west) via `updateSunDirection`
     *  in `lights.ts`. The shadow show/hide intensity is driven by
     *  camera pitch, not by this parameter. 2D and headless renderers
     *  ignore this. */
    sunT?: number,
    /** Maximum pitch (radians) the camera reaches when fully tilted.
     *  3D renderer normalizes the per-frame `pitch` into a tilt-
     *  progress factor `pitch / pitchMax` ∈ [0, 1], used for the sun-
     *  rig fade-in/out around the camera's tilt animation. 2D and
     *  headless renderers ignore this. */
    pitchMax?: number,
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
    /** Battle-progress sun parameter. See `drawFrame` `sunT`. */
    sunT?: number,
    /** Camera max-pitch in radians. See `drawFrame` `pitchMax`. */
    pitchMax?: number,
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

export interface LoupeHandle {
  /** Update the loupe content — call from render(). */
  update: (visible: boolean, worldX: number, worldY: number) => void;
}

/** A cannon captured by a propaganda balloon — fires for the balloon owner during battle. */
export interface CastleData {
  /** Wall tile positions encoded as row*GRID_COLS+col. */
  walls: ReadonlySet<TileKey>;
  /** Enclosed territory: grass tiles fully surrounded by walls (inverse flood-fill).
   *  Encoded as row*GRID_COLS+col. Used for cannon eligibility, grunt blocking, and scoring. */
  interior: FreshInterior;
  /** Cannon positions (top-left of 2×2 or 3×3 super) with HP. */
  cannons: Cannon[];
  /** Player index (for color). */
  playerId: ValidPlayerId;
  /** Wall tiles that absorbed one hit from Reinforced Walls upgrade.
   *  Rendered with a crack overlay so players can see which walls are weakened. */
  damagedWalls?: ReadonlySet<TileKey>;
  /** Current cannon tier for this player (derived from lives lost — 1 at
   *  full lives, 2 after one loss, 3 on the last life). The 3D renderer
   *  swaps regular cannons to the matching `tier_N` sprite; the 2D path
   *  uses a single sprite and ignores this field. */
  cannonTier: 1 | 2 | 3;
}
