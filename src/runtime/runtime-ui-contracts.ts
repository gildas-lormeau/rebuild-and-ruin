/**
 * UI contracts — overlay/screen factories, hit-test types, touch component
 * handle interfaces, and input-handler registration signatures. The
 * cross-cutting types that runtime/, render/, and input/ all need to agree
 * on. Per-component deps live in shared/ui/input-deps.ts; banner callback
 * types live in runtime-banner-state.ts.
 */

import type {
  BalloonFlight,
  CannonDestroy,
  Crosshair,
  DestroyedWall,
  GruntKill,
  HouseDestroy,
  Impact,
  ShieldFlash,
  ThawingTile,
} from "../shared/core/battle-types.ts";
import type { BannerKind } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap, WorldPos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState, LobbyState } from "../shared/core/types.ts";
import type { SceneCapture } from "../shared/ui/banner-content.ts";
import type { Action } from "../shared/ui/input-action.ts";
import type {
  DpadDeps,
  FloatingActionsDeps,
  GameActionDeps,
  PointerMoveDeps,
  QuitButtonDeps,
  WithPointerPlayer,
  ZoomButtonDeps,
} from "../shared/ui/input-deps.ts";
import type {
  ControlsState,
  GameOverFocus,
  LifeLostDialogState,
  QuitState,
  UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type {
  BannerUi,
  GameOverOverlay,
  LoupeHandle,
  PhantomOverlay,
  RendererInterface,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import type {
  GameSettings,
  KeyBindings,
  SeedMode,
} from "../shared/ui/player-config.ts";
import type { RGB } from "../shared/ui/theme.ts";
import type { Mode } from "../shared/ui/ui-mode.ts";
import type { RevealOverlayBattleFields } from "./modifier-reveal-overlay-registry.ts";

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
  isOnline: boolean;
  /** True when all player-supplied Rampart sound files are in IndexedDB, so the
   *  "Sound" row in the options screen can render status at a glance. */
  getSoundReady: () => boolean;
}

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
  | { type: "cell"; playerIdx: ValidPlayerId; actionIdx: number }
  | null;

export type CreateBannerUiFn = (
  active: boolean,
  kind: BannerKind,
  text: string,
  progress: number,
  subtitle?: string,
  paletteKey?: string,
  prevScene?: SceneCapture,
  newScene?: SceneCapture,
) => BannerUi | undefined;

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
  | { type: "slot"; slotId: ValidPlayerId };

export type CreateOnlineOverlayFn = (
  params: OnlineOverlayParams,
) => RenderOverlay;

/** Parameter object for createOnlineOverlay — extracted so consumers can import the type. */
export interface OnlineOverlayParams {
  previousSelection: RenderOverlay["selection"];
  view: RenderView;
  battleAnim: {
    territory: Set<TileKey>[];
    walls: Set<TileKey>[];
    flights: ReadonlyArray<{ flight: BalloonFlight; progress: number }>;
    impacts: Impact[];
    thawing: ThawingTile[];
    destroyedWalls: DestroyedWall[];
    cannonDestroys: CannonDestroy[];
    gruntKills: GruntKill[];
    houseDestroys: HouseDestroy[];
    shieldFlashes: ShieldFlash[];
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
  povPlayerId: ValidPlayerId;
  hasPointerPlayer: boolean;
  upgradePickInteractiveSlots: ReadonlySet<ValidPlayerId>;
  playerNames: ReadonlyArray<string>;
  playerColors: ReadonlyArray<{ wall: RGB }>;
  getLifeLostPanelPos: (playerId: ValidPlayerId) => {
    px: number;
    py: number;
  };
  /** 2D-overlay scalars driven by the active modifier-reveal pulse, one
   *  field per consumer (`fogRevealOpacity`, `rubbleClearingFade`,
   *  `frostbiteRevealProgress`, `sapperRevealIntensity`,
   *  `gruntSurgeRevealIntensity`). Built by
   *  `deriveRevealOverlayFields` in `subsystems/render.ts` from the single
   *  resolved `revealTimeMs` — bespoke per-modifier `revealTimeFor`
   *  plumbing does not live here. Spread into `overlay.battle`. */
  revealOverlayFields: RevealOverlayBattleFields;
}

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

export type CreateDpadFn = (
  deps: DpadDeps,
  container: HTMLElement,
) => {
  update: (phase: Phase | null, disableRotate?: boolean) => void;
  setLeftHanded: (lh: boolean) => void;
  setConfirmValid: (valid: boolean) => void;
};

export type CreateZoneCycleButtonFn = (
  deps: ZoomButtonDeps,
  container: HTMLElement,
) => { update: (active?: boolean) => void };

export type CreateFloatingActionsFn = (
  deps: FloatingActionsDeps,
  element: HTMLElement,
) => FloatingActionsHandle;

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
  isOnline: boolean;
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
    /** Elevation-aware variant of `screenToWorld` used for battle aim. */
    pickHitWorld: (x: number, y: number) => WorldPos;
    onPinchStart?: (midX: number, midY: number) => void;
    onPinchUpdate?: (midX: number, midY: number, scale: number) => void;
    onPinchEnd?: () => void;
    /** Snap the camera so `(wx, wy)` is at the viewport center (current
     *  zoom preserved). Called by single-finger touchstart so a tap
     *  re-centers wherever the player pressed. */
    centerCameraOnTap?: (wx: number, wy: number) => void;
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
  dialogAction: (playerId: ValidPlayerId, action: Action) => boolean;

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

  // --- Quit flow ---
  quit: {
    getQuit: () => QuitState;
    setQuit: (quit: QuitState) => void;
  };
}

/** Deps for the per-frame touch controls update (loupe, d-pad, zoom, quit, floating actions). */
export interface TouchControlsDeps {
  mode: Mode;
  state: GameState;
  /** Piece + cannon phantoms the touch layer inspects for confirm-button
   *  validity + loupe positioning. Readonly because the source is
   *  `runtimeState.overlay.phantoms` (assembled from the union of each
   *  controller's `currentBuildPhantoms` / `currentCannonPhantom` + the
   *  runtime's remote slot). */
  phantoms: Pick<PhantomOverlay, "piecePhantoms" | "cannonPhantoms">;
  leftHanded: boolean;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  dpad: Dpad | null;
  floatingActions: FloatingActions | null;
  zoneCycleButton: ZoomButton | null;
  quitButton: QuitButton | null;
  loupeHandle: LoupeHandle | null;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  screenToContainerCSS: (sx: number, sy: number) => { x: number; y: number };
  containerHeight: number;
}
