/**
 * Per-component / per-action deps shapes that input/ handler factories
 * (keyboard, mouse, touch UI) take. Lives in shared/ui so runtime/ and
 * input/ can both reference them without a cross-domain dependency.
 */

import type { Phase } from "../core/game-phase.ts";
import type { TowerIdx, WorldPos } from "../core/geometry-types.ts";
import type { Action, KeyBindings } from "../core/input-action.ts";
import type { ValidPlayerId } from "../core/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../core/system-interfaces.ts";
import type { GameState, SelectionState } from "../core/types.ts";
import type { ZoneId } from "../core/zone-id.ts";
import type {
  ControlsState,
  GameOverFocus,
  LifeLostDialogState,
  OptionsContext,
  QuitState,
  UpgradePickDialogState,
} from "./interaction-types.ts";
import type {
  LoupeHandle,
  PhantomOverlay,
  RendererInterface,
} from "./overlay-types.ts";
import type { SeedMode } from "./player-config.ts";
import type { Mode } from "./ui-mode.ts";

/** Run `action` with the pointer (local human) controller. Returns `true`
 *  if it actually ran, `false` when there is no human to receive the input
 *  (all-AI, demo, online-watcher). Ignore the return value to preserve the
 *  legacy silent-no-op behavior; inspect it to surface a diagnostic.
 *
 *  lint:allow-callback-inversion -- dispatcher: action runs at the caller's
 *  identity; receiver only guards on whether a pointer player exists. */
export type WithPointerPlayer = (
  action: (human: PlayerController & InputReceiver) => void,
) => boolean;

export interface GameActionDeps {
  getSelectionStates: () => Map<ValidPlayerId, SelectionState>;
  highlightTowerForPlayer: (
    idx: TowerIdx,
    zone: ZoneId,
    pid: ValidPlayerId,
  ) => void;
  confirmSelectionAndStartBuild: (pid: ValidPlayerId) => boolean;
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
    "getSelectionStates" | "highlightTowerForPlayer"
  >;
  maybeSendAimUpdate: (x: number, y: number) => void;
}

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
  /** Shared game action deps (selection, placement, battle). */
  gameAction: GameActionDeps;
  /** Shared overlay action deps (options, life-lost, game-over). */
  overlay: OverlayActionDeps;
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
  /** Emit a `uiTap` bus event — see `DpadDeps.emitUiTap`. */
  emitUiTap?: () => void;
  /** Forward a drag touch to the canvas pointer-move logic. */
  onDrag?: (clientX: number, clientY: number) => void;
}

export interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  /** The zone the user is visually looking at right now — explicit zone
   *  target, or the zone at a pinch viewport center, or undefined when
   *  the camera is on full map / over a river. Used to base the cycle's
   *  "next zone" preview on the actually-visible zone. */
  getViewedZone: () => ZoneId | undefined;
  setCameraZone: (zone: ZoneId) => void;
  povPlayerId: () => number;
  getEnemyZones: () => ZoneId[];
  /** Move the human crosshair to a zone's home tower (battle auto-zoom). */
  aimAtZone?: (zone: ZoneId) => void;
}

export interface QuitButtonDeps {
  getQuit: () => QuitState;
  setQuit: (quit: QuitState) => void;
  showLobby: () => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => boolean;
}

export interface SeedField {
  focus: (currentValue: string) => void;
  blur: () => void;
}

export interface Dpad {
  update(phase: Phase | null, disableRotate?: boolean): void;
  setConfirmValid(valid: boolean): void;
}

export interface ZoomButton {
  update(active: boolean): void;
}

export interface QuitButton {
  update(phase: Phase | null): void;
}

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
    closeControls: () => void;
    /** Move the options cursor by ±1 with wraparound — the single source
     *  of the cursor-wrap, shared by keyboard nav and the touch d-pad. */
    moveCursor: (dir: -1 | 1) => void;
    getRealIdx: () => number;
    /** Confirm the current option: shows controls if on that row, else closes. */
    confirmOption: () => void;
    getContext: () => OptionsContext;
    setContext: (context: OptionsContext) => void;
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
    /** True while the game-over overlay is on screen. Gates the
     *  STOPPED-mode keyboard branch: the document-level listener outlives
     *  the session, so without this gate Enter/Space after a route-level
     *  exit would trigger rematch/showLobby behind whatever replaced the
     *  game (including a different entry module's runtime). */
    isActive: () => boolean;
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
  floatingActions: FloatingActionsHandle | null;
  zoneCycleButton: ZoomButton | null;
  quitButton: QuitButton | null;
  loupeHandle: LoupeHandle | null;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  screenToContainerCSS: (sx: number, sy: number) => { x: number; y: number };
  containerHeight: number;
}
