import type {
  BalloonFlight,
  Crosshair,
  Impact,
  ThawingTile,
  WallBurn,
} from "../shared/core/battle-types.ts";
import type { ModifierDiff } from "../shared/core/game-constants.ts";
import type { BannerKind } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap, WorldPos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type {
  GameState,
  LobbyState,
  SelectionState,
} from "../shared/core/types.ts";
import type { Action } from "../shared/ui/input-action.ts";
import type {
  ControlsState,
  GameOverFocus,
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type {
  BannerUi,
  GameOverOverlay,
  LoupeHandle,
  RendererInterface,
  RenderOverlay,
  SceneCapture,
} from "../shared/ui/overlay-types.ts";
import type {
  GameSettings,
  KeyBindings,
  SeedMode,
} from "../shared/ui/player-config.ts";
import type { RGB } from "../shared/ui/theme.ts";
import type { Mode } from "../shared/ui/ui-mode.ts";

export interface UIContext {
  getState: () => GameState | undefined;
  getOverlay: () => RenderOverlay;
  settings: GameSettings;
  getMode: () => Mode;
  /** Raw field write — assigns runtimeState.mode. Callers (showOptions, closeOptions, etc.)
   *  are responsible for any state-machine side effects around the transition. */
  setMode: (mode: Mode) => void;
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  optionsCursor: { value: number };
  controlsState: ControlsState;
  getOptionsReturnMode: () => Mode | null;
  setOptionsReturnMode: (mode: Mode | null) => void;
  lobby: LobbyState;
  getFrame: () => { announcement?: string };
  getLobbyRemaining: () => number;
  isOnline?: boolean;
  /** True when all player-supplied Rampart sound files are in IndexedDB, so the
   *  "Sound" row in the options screen can render status at a glance. */
  getSoundReady: () => boolean;
}

/** Run `action` with the pointer (local human) controller. Returns `true`
 *  if it actually ran, `false` when there is no human to receive the input
 *  (all-AI, demo, online-watcher). Ignore the return value to preserve the
 *  legacy silent-no-op behavior; inspect it to surface a diagnostic. */
export type WithPointerPlayer = (
  action: (human: PlayerController & InputReceiver) => void,
) => boolean;

export type CreateOptionsOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type CreateControlsOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type CreateLobbyOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type VisibleOptionsFn = (ctx: UIContext) => number[];

export type OptionsScreenHitTestFn = (
  x: number,
  y: number,
  W: number,
  H: number,
  optionCount: number,
) => OptionsHit;

export type ControlsScreenHitTestFn = (
  x: number,
  y: number,
  W: number,
  H: number,
  colCount: number,
  rowCount: number,
) => ControlsHit;

/** Hit-test result for a tap/click on the options screen. */
export type OptionsHit =
  | { type: "close" }
  | { type: "row"; index: number }
  | { type: "arrow"; index: number; dir: -1 | 1 }
  | null;

/** Hit-test result for a tap/click on the controls screen. */
export type ControlsHit =
  | { type: "close" }
  | { type: "cell"; playerIdx: number; actionIdx: number }
  | null;

export type CreateBannerUiFn = (
  active: boolean,
  kind: BannerKind,
  text: string,
  progress: number,
  subtitle?: string,
  modifierDiff?: ModifierDiff,
  prevScene?: SceneCapture,
  newScene?: SceneCapture,
) => BannerUi | undefined;

export type CreateRenderSummaryMessageFn = (
  params: RenderSummaryParams,
) => string;

export interface RenderSummaryParams {
  phaseName: string;
  timer: number;
  crosshairs: Array<{ x: number; y: number; playerId: ValidPlayerSlot }>;
  piecePhantomsCount: number;
  cannonPhantomsCount: number;
  impactsCount: number;
  cannonballsCount: number;
  selectionHighlights?: Array<{
    playerId: ValidPlayerSlot;
    towerIdx: number;
    confirmed?: boolean;
  }>;
}

export type ComputeLobbyLayoutFn = (
  W: number,
  H: number,
  count: number,
) => { gap: number; rectW: number; rectH: number; rectY: number };

export type LobbyClickHitTestFn = (params: {
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  tileSize: number;
  slotCount: number;
  computeLayout: (
    W: number,
    H: number,
    count: number,
  ) => { gap: number; rectW: number; rectH: number; rectY: number };
}) => LobbyHit | null;

/** Result of a lobby click hit-test. */
export type LobbyHit =
  | { type: "gear" }
  | { type: "slot"; slotId: ValidPlayerSlot };

export type CreateOnlineOverlayFn = (
  params: OnlineOverlayParams,
) => RenderOverlay;

/** Parameter object for createOnlineOverlay — extracted so consumers can import the type. */
export interface OnlineOverlayParams {
  previousSelection: RenderOverlay["selection"];
  view: RenderView;
  battleAnim: {
    territory: Set<number>[];
    walls: Set<number>[];
    flights: ReadonlyArray<{ flight: BalloonFlight; progress: number }>;
    impacts: Impact[];
    thawing: ThawingTile[];
    wallBurns: WallBurn[];
  };
  frame: {
    crosshairs: Crosshair[];
    phantoms: RenderOverlay["phantoms"];
    announcement?: string;
    gameOver?: GameOverOverlay;
  };
  bannerUi?: BannerUi;
  lifeLostDialog: LifeLostDialogState | null;
  upgradePickDialog: UpgradePickDialogState | null;
  inBattle: boolean;
  povPlayerId: ValidPlayerSlot;
  hasPointerPlayer: boolean;
  upgradePickInteractiveSlots: ReadonlySet<ValidPlayerSlot>;
  playerNames: ReadonlyArray<string>;
  playerColors: ReadonlyArray<{ wall: RGB }>;
  getLifeLostPanelPos: (playerId: ValidPlayerSlot) => {
    px: number;
    py: number;
  };
}

/** Banner lifecycle state:
 *  - `hidden`: no banner is on screen (and none scheduled).
 *  - `sweeping`: progress animates 0 → 1; banner strip is painted over
 *    prevScene.
 *  - `swept`: progress has reached 1 and the sweep-end callback has
 *    fired. The banner remains visually on screen (its text/subtitle
 *    are still readable) until a caller explicitly hides it or a new
 *    `showBanner` overwrites it. This is the state used by the
 *    "hold" between banners (e.g. the 2s beat after a modifier reveal).
 */
export interface ActiveBannerState {
  status: "sweeping" | "swept";
  progress: number;
  text: string;
  subtitle?: string;
  /** Identity of this banner. Banner events carry this field so
   *  consumers can discriminate without reading `phase` (which lies
   *  during the upgrade-pick flow) or matching text. */
  kind: BannerKind;
  /** Fired once the sweep reaches 1 (or after the optional `holdMs`
   *  expires). Nulled out as it fires, or when a subsequent
   *  `showBanner` / `hideBanner` replaces this banner. */
  callback: (() => void) | null;
  /** Pixel snapshot of the scene composited below the sweep line during
   *  animation — the old scene, captured before the phase mutation that
   *  the banner is announcing. Supplied by the caller (`showBanner` opts)
   *  because the mutation has not yet run at banner-show time. */
  prevScene?: SceneCapture;
  /** Pixel snapshot of the scene revealed above the sweep line during
   *  animation — the new scene, captured by `showBanner` itself after
   *  the phase mutation + `postMutate` + one forced `render()`. Both
   *  snapshots are frozen for the duration of the sweep; the live
   *  renderer does not repaint world contents during a banner. */
  newScene?: SceneCapture;
  /** Set when the active banner is a modifier-reveal (modern mode).
   *  Carries the full diff — `id` drives the banner palette + bannerStart
   *  event, `changedTiles` drives the progressive tile-highlight animation
   *  in `drawModifierRevealHighlight`. Cleared between banners. */
  modifierDiff?: ModifierDiff;
  /** Post-sweep hold duration (sim-ms). When > 0, `callback` is deferred
   *  by this many milliseconds after the sweep completes so SFX / visual
   *  effects can play during the `swept` state. Consumed once on sweep-
   *  end (reset to 0 when the timer fires or the banner is replaced). */
  holdMs: number;
  /** Active hold-timer handle, or `undefined` when no hold is pending.
   *  Cleared on `hideBanner`, on `showBanner` overwrite, and when the
   *  timer fires. */
  holdTimerId?: number;
}

/** Banner state is a discriminated union: `hidden` carries no fields
 *  (no fictional defaults), while the `sweeping` / `swept` variants
 *  share `ActiveBannerState`. Consumers narrow on `status === "hidden"`
 *  before reading identity / progress fields. */
export type BannerState = { readonly status: "hidden" } | ActiveBannerState;

export interface SeedField {
  focus: (currentValue: string) => void;
  blur: () => void;
}

export interface Dpad {
  update(phase: Phase | null, disableRotate?: boolean): void;
  setConfirmValid(valid: boolean): void;
}

export interface FloatingActions {
  update(
    visible: boolean,
    x: number,
    y: number,
    nearTop: boolean,
    leftHanded: boolean,
  ): void;
  setConfirmValid(valid: boolean): void;
}

export interface ZoomButton {
  update(active: boolean): void;
}

export interface QuitButton {
  update(phase: Phase | null): void;
}

export type DispatchPointerMoveFn = (
  x: number,
  y: number,
  state: GameState,
  deps: PointerMoveDeps,
) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterKeyboardHandlersFn = (
  deps: RegisterOnlineInputDeps,
) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterMouseHandlersFn = (deps: RegisterOnlineInputDeps) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterTouchHandlersFn = (deps: RegisterOnlineInputDeps) => void;

export interface OverlayActionDeps {
  options?: {
    isActive: () => boolean;
    moveCursor: (dir: -1 | 1) => void;
    changeValue: (dir: -1 | 1) => void;
    confirm: () => void;
  };
  /** Centralized per-player dialog action (life-lost, upgrade pick).
   *  The caller resolves the playerId upstream (pointer player for touch,
   *  matched controller for keyboard). Returns true if consumed. */
  dialogAction?: (action: Action) => boolean;
  gameOver?: {
    isActive: () => boolean;
    toggleFocus: () => void;
    confirm: () => void;
  };
}

export interface DpadDeps {
  getState: () => GameState | undefined;
  getMode: () => Mode;
  withPointerPlayer: WithPointerPlayer;
  /** Emit a `uiTap` bus event so the haptics subsystem (and any future
   *  feedback subsystem) can react to the user tapping a d-pad button
   *  without the d-pad importing those subsystems directly. No-op when
   *  game state isn't ready (lobby pre-state). */
  emitUiTap?: () => void;
  isHost: () => boolean;
  /** Join P1 in lobby (or skip if already joined). */
  lobbyAction: () => void;
  getLeftHanded: () => boolean;
  /** Clear direct-touch mode (equivalent to setDirectTouchActive(false)).
   *  Named differently for brevity in the d-pad context where only clearing is needed.
   *  See setDirectTouchActive in input.ts for the full setter. */
  clearDirectTouch?: () => void;
  /** Shared game action deps (selection, placement, battle). */
  gameAction: GameActionDeps;
  /** Shared overlay action deps (options, life-lost, game-over). */
  overlay: OverlayActionDeps;
}

export interface QuitButtonDeps {
  getQuitPending: () => boolean;
  setQuitPending: (quitPending: boolean) => void;
  setQuitTimer: (quitTimer: number) => void;
  setQuitMessage: (msg: string) => void;
  showLobby: () => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => boolean;
}

export interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  getCameraZone: () => number | undefined;
  setCameraZone: (zone: number | undefined) => void;
  povPlayerId: () => number;
  getEnemyZones: () => number[];
  /** Move the human crosshair to a zone's home tower (battle auto-zoom). */
  aimAtZone?: (zone: number) => void;
}

export interface FloatingActionsDeps {
  getState: () => GameState | undefined;
  getMode: () => Mode;
  withPointerPlayer: WithPointerPlayer;
  tryPlacePiece: (
    human: PlayerController & InputReceiver,
    state: BuildViewState,
  ) => boolean;
  tryPlaceCannon: (
    human: PlayerController & InputReceiver,
    state: CannonViewState,
    max: number,
  ) => boolean;
  onPieceRotated?: () => void;
  onPiecePlaced?: () => void;
  onPieceFailed?: () => void;
  onCannonPlaced?: () => void;
  /** Emit a `uiTap` bus event — see `DpadDeps.emitUiTap`. */
  emitUiTap?: () => void;
  /** Forward a drag touch to the canvas pointer-move logic. */
  onDrag?: (clientX: number, clientY: number) => void;
}

export type CreateDpadFn = (
  deps: DpadDeps,
  container: HTMLElement,
) => {
  update: (phase: Phase | null, disableRotate?: boolean) => void;
  setLeftHanded: (lh: boolean) => void;
  setConfirmValid: (valid: boolean) => void;
};

export type CreateEnemyZoomButtonFn = (
  deps: ZoomButtonDeps,
  container: HTMLElement,
) => { update: (active?: boolean) => void };

export type CreateFloatingActionsFn = (
  deps: FloatingActionsDeps,
  element: HTMLElement,
) => FloatingActionsHandle;

export type CreateHomeZoomButtonFn = (
  deps: ZoomButtonDeps,
  container: HTMLElement,
) => { update: (active?: boolean) => void };

export type CreateQuitButtonFn = (
  deps: QuitButtonDeps,
  container: HTMLElement,
) => { update: (phase?: Phase | null) => void };

export interface FloatingActionsHandle {
  /** Reposition + show/hide based on current phantom screen coords. */
  update: (
    visible: boolean,
    x: number,
    y: number,
    nearTop: boolean,
    leftHanded: boolean,
  ) => void;
  /** Toggle the confirm button's disabled look based on placement validity. */
  setConfirmValid: (valid: boolean) => void;
}

export interface RegisterOnlineInputDeps {
  // --- Core (used by all handlers) ---
  renderer: RendererInterface;
  /** DOM event source for keyboard listeners — injected so the keyboard
   *  handler module never touches `document` directly. Production passes
   *  `document`; tests pass a stub. Only entry points should construct the
   *  real `document` reference. */
  keyboardEventSource: Pick<
    Document,
    "addEventListener" | "removeEventListener"
  >;
  getState: () => GameState | undefined;
  getMode: () => Mode;
  setMode: (mode: Mode) => void;
  isOnline?: boolean;
  settings: {
    keyBindings: KeyBindings[];
    seedMode: SeedMode;
    seed: string;
  };

  // --- Controllers ---
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => ctrl is PlayerController & InputReceiver;
  /** Execute an action with the pointer player (mouse/touch target).
   *  IMPORTANT: The callback is NOT invoked if no human players exist
   *  (e.g., all-AI game or spectator mode). Callers must not rely on
   *  side effects — the action may silently not run. */
  withPointerPlayer: WithPointerPlayer;

  // --- Coordinate conversion + pinch ---
  coords: {
    pixelToTile: (x: number, y: number) => { row: number; col: number };
    screenToWorld: (x: number, y: number) => WorldPos;
    onPinchStart?: (midX: number, midY: number) => void;
    onPinchUpdate?: (midX: number, midY: number, scale: number) => void;
    onPinchEnd?: () => void;
  };

  // --- Lobby ---
  lobby: {
    isActive: () => boolean;
    keyJoin?: (key: string) => boolean;
    click: (x: number, y: number) => boolean;
    cursorAt: (x: number, y: number) => string;
  };

  // --- Navigation ---
  showLobby: () => void;
  rematch: () => void | Promise<void>;

  // --- Options overlay ---
  options: {
    show: () => void;
    click: (x: number, y: number) => void;
    clickControls: (x: number, y: number) => void;
    cursorAt: (x: number, y: number) => string;
    controlsCursorAt: (x: number, y: number) => string;
    close: () => void;
    showControls: () => void;
    closeControls: () => void;
    getCursor: () => number;
    setCursor: (cursor: number) => void;
    getCount: () => number;
    getRealIdx: () => number;
    /** Confirm the current option: shows controls if on that row, else closes. */
    confirmOption: () => void;
    getReturnMode: () => number | null;
    setReturnMode: (mode: number | null) => void;
    changeValue: (dir: number) => void;
    togglePause: () => boolean;
    getControlsState: () => ControlsState;
  };

  // --- Per-player dialogs (life-lost, upgrade pick) ---
  /** Dispatch a player action to whichever per-player dialog is active.
   *  Returns true if consumed. Input handlers resolve the playerId upstream
   *  (keyboard: match key → controller, mouse/touch: pointer player). */
  dialogAction: (playerId: ValidPlayerSlot, action: Action) => boolean;

  // --- Life-lost dialog (click + get) ---
  lifeLost: {
    get: () => LifeLostDialogState | null;
    click: (x: number, y: number) => void;
  };

  // --- Upgrade pick dialog (click + get) ---
  upgradePick: {
    get: () => UpgradePickDialogState | null;
    click: (x: number, y: number) => void;
  };

  // --- Game over ---
  gameOver: {
    getFocused: () => GameOverFocus;
    setFocused: (focused: GameOverFocus) => void;
    click: (x: number, y: number) => void;
  };

  // --- Game actions (selection, placement, firing) ---
  gameAction: GameActionDeps;

  // --- Battle networking ---
  maybeSendAimUpdate: (x: number, y: number) => void;

  // --- Direct touch state ---
  /**
   * Direct-touch state lifecycle:
   *   - Enabled by: touch canvas on phantom tap (input-touch-canvas.ts)
   *   - Disabled by: d-pad arrow press (input-touch-ui.ts), keyboard placement (input-keyboard.ts)
   *   - Checked by: touch canvas to suppress tap-to-place when using d-pad
   *
   * When directTouchActive is true, floating action buttons are hidden and
   * taps on the canvas directly confirm placement.
   */
  /** Enable or disable direct-touch mode (finger on screen = cursor follows touch).
   *  Keyboard disables this when entering placement phase.
   *  Touch canvas enables it when user touches during placement.
   *  D-pad uses clearDirectTouch() (a shorthand for setDirectTouchActive(false)). */
  setDirectTouchActive?: (active: boolean) => void;
  /** Whether the user is currently in direct-touch mode (floating buttons visible).
   *  When true, tap-to-place on the canvas is suppressed (the floating confirm
   *  button handles placement instead). Optional — absent on desktop. */
  isDirectTouchActive?: () => boolean;

  // --- Quit flow ---
  quit: {
    getPending: () => boolean;
    setPending: (value: boolean) => void;
    setTimer: (seconds: number) => void;
    setMessage: (text: string) => void;
  };
}

export interface GameActionDeps {
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (
    idx: number,
    zone: number,
    pid: ValidPlayerSlot,
  ) => void;
  confirmSelectionAndStartBuild: (
    pid: ValidPlayerSlot,
    isReselect?: boolean,
  ) => boolean;
  isSelectionReady?: () => boolean;
  tryPlacePiece: (
    ctrl: PlayerController & InputReceiver,
    state: BuildViewState,
  ) => boolean;
  tryPlaceCannon: (
    ctrl: PlayerController & InputReceiver,
    state: CannonViewState,
    max: number,
  ) => boolean;
  onPieceRotated?: () => void;
  onPiecePlaced?: () => void;
  onPieceFailed?: () => void;
  onCannonPlaced?: () => void;
  fire: (ctrl: PlayerController, state: BattleViewState) => void;
}

export interface PointerMoveDeps {
  withPointerPlayer: WithPointerPlayer;
  coords: {
    screenToWorld: (x: number, y: number) => WorldPos;
    pixelToTile: (x: number, y: number) => { row: number; col: number };
  };
  gameAction: Pick<
    GameActionDeps,
    "getSelectionStates" | "highlightTowerForPlayer" | "isSelectionReady"
  >;
  maybeSendAimUpdate: (x: number, y: number) => void;
}

/** Deps for the per-frame touch controls update (loupe, d-pad, zoom, quit, floating actions). */
export interface TouchControlsDeps {
  mode: Mode;
  state: GameState;
  /** Piece + cannon phantoms the touch layer inspects for confirm-button
   *  validity + loupe positioning. Readonly because the source is now
   *  `runtimeState.overlay.phantoms` (assembled from the union of each
   *  controller's `currentBuildPhantoms` + the runtime's remote slot) —
   *  never the tick-mutable `frame.phantoms`. */
  phantoms: {
    piecePhantoms?: readonly { playerId: ValidPlayerSlot; valid: boolean }[];
    cannonPhantoms?: readonly { playerId: ValidPlayerSlot; valid: boolean }[];
  };
  directTouchActive: boolean;
  clearDirectTouch: () => void;
  leftHanded: boolean;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  dpad: Dpad | null;
  floatingActions: FloatingActions | null;
  homeZoomButton: ZoomButton | null;
  enemyZoomButton: ZoomButton | null;
  quitButton: QuitButton | null;
  loupeHandle: LoupeHandle | null;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  screenToContainerCSS: (sx: number, sy: number) => { x: number; y: number };
  containerHeight: number;
}

/** Callback signature for showing phase-transition banners. */
export type BannerShow = (opts: BannerShowOpts) => void;

export interface BannerShowOpts {
  readonly text: string;
  readonly onDone: () => void;
  /** Banner identity — threaded onto every BANNER_* event so consumers
   *  (music, SFX, tests) can discriminate without reading `phase` (which
   *  lies during the upgrade-pick flow) or matching text. */
  readonly kind: BannerKind;
  readonly subtitle?: string;
  /** Set when the banner being shown is a modifier-reveal (the
   *  mid-frame banner that replaces the normal battle banner in modern
   *  mode). The full diff drives (a) the `bannerStart` event payload —
   *  so consumers can distinguish the modifier banner from the battle
   *  banner without string-matching the text field — and (b) the
   *  progressive tile-highlight animation in the renderer. */
  readonly modifierDiff?: ModifierDiff;
  /** Optional post-sweep hold. When set, after the sweep completes the
   *  banner sits in its `swept` state (still visible on screen) for
   *  `holdMs` milliseconds before `onDone` fires. Lets listeners time
   *  SFX / visual effects between banners — e.g. the 2s beat between
   *  the modifier reveal and the battle banner. The banner system owns
   *  the timer (not the caller): `hideBanner()` or a subsequent
   *  `showBanner` during the hold cancels it. */
  readonly holdMs?: number;
}

/** Injected timing primitives. Production callers (main.ts, online-runtime-game.ts)
 *  bind to `performance.now`, `setTimeout`, `clearTimeout`, `requestAnimationFrame`.
 *  Tests pass deterministic stubs or Deno's natives. Following the project's
 *  "DOM/global helpers as deps" rule — no runtime sub-system should reach for
 *  these globals directly. */
export interface TimingApi {
  /** Monotonic timestamp source — produces frame timestamps used by render
   *  animations, dedup channels, and lobby/banner timers. Must be monotonic
   *  within a single runtime instance. */
  readonly now: () => number;
  /** Schedule a one-shot callback after `ms` milliseconds. Returns a handle
   *  that can be passed to `clearTimeout`. */
  readonly setTimeout: (callback: () => void, ms: number) => number;
  /** Cancel a previously scheduled timeout. */
  readonly clearTimeout: (handle: number) => void;
  /** Schedule a callback to run before the next browser paint. Same signature
   *  as `window.requestAnimationFrame` — the `now` argument is a high-resolution
   *  timestamp. Tests pass a synchronous trampoline or no-op (since headless
   *  tests drive the main loop manually). */
  readonly requestFrame: (callback: (now: number) => void) => void;
}

export function createBannerState(): BannerState {
  return { status: "hidden" };
}
