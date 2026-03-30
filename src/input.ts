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
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { GameActionDeps } from "./input-dispatch.ts";
import type { KeyBindings, SeedMode } from "./player-config.ts";
import type { RendererInterface } from "./render-types.ts";
import type {
  ControlsState,
  GameOverFocus,
  GameState,
  LifeLostDialogState,
  Mode,
  ResolvedChoice,
} from "./types.ts";

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
  withFirstHuman: (
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
  rematch: () => void;

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

  // --- Life-lost dialog ---
  lifeLost: {
    get: () => LifeLostDialogState | null;
    click: (x: number, y: number) => void;
    sendChoice: (choice: ResolvedChoice, playerId: number) => void;
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
