/**
 * Shared input types.
 *
 * Pure type definitions consumed by mouse, keyboard, and touch input handlers.
 * No runtime code — avoids circular dependencies between handler modules.
 *
 * ### Mode vs Phase (glossary)
 *
 * **Mode** (`getMode()` / `setMode()`) — UI state set at the app level (`Mode` enum).
 * Values: STOPPED, LOBBY, OPTIONS, GAME, SELECTION, BANNER, etc.
 * Controls which input handlers are active and which screen is drawn.
 * Use `isInteractiveMode(mode)` to check if gameplay interaction is allowed.
 *
 * **Phase** (`state.phase`, `Phase` enum) — gameplay state within GAME mode.
 * Values: CASTLE_SELECT, WALL_BUILD, CANNON_PLACE, BATTLE, CASTLE_RESELECT.
 * Controls which game actions are valid and which tick functions run.
 *
 * They are independent: Mode gates top-level input routing; Phase gates
 * game-action semantics. An LLM editing input code should check Mode first,
 * then Phase only when Mode === GAME.
 */

import type {
  ControlsState,
  GameOverFocus,
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/dialog-types.ts";
import type { WorldPos } from "../shared/geometry-types.ts";
import type { Action } from "../shared/input-action.ts";
import type { RendererInterface } from "../shared/overlay-types.ts";
import type { KeyBindings, SeedMode } from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";
import type { Mode } from "../shared/ui-mode.ts";
import type { GameActionDeps } from "./input-dispatch.ts";

export interface RegisterOnlineInputDeps {
  // --- Core (used by all handlers) ---
  renderer: RendererInterface;
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
  withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;

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
    show: () => Promise<void>;
    click: (x: number, y: number) => void | Promise<void>;
    clickControls: (x: number, y: number) => void;
    cursorAt: (x: number, y: number) => string;
    controlsCursorAt: (x: number, y: number) => string;
    close: () => void;
    showControls: () => Promise<void>;
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

/** Max CSS pixel distance for a touch to count as a tap (not a drag). */
export const TAP_MAX_DIST = 20;
/** Max milliseconds for a touch to count as a tap. */
export const TAP_MAX_TIME = 300;
