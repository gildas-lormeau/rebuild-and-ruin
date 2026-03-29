/**
 * Shared input types.
 *
 * Pure type definitions consumed by mouse, keyboard, and touch input handlers.
 * No runtime code — avoids circular dependencies between handler modules.
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { GameActionDeps, ModeValues } from "./input-dispatch.ts";
import type { KeyBindings, SeedMode } from "./player-config.ts";
import type { RendererInterface } from "./render-types.ts";
import type {
  ControlsState,
  GameOverFocus,
  GameState,
  LifeLostDialogState,
  ResolvedChoice,
} from "./types.ts";

export interface RegisterOnlineInputDeps {
  // --- Core (used by all handlers) ---
  renderer: RendererInterface;
  getState: () => GameState | undefined;
  getMode: () => number;
  setMode: (mode: number) => void;
  modeValues: ModeValues;
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
  };

  // --- Navigation ---
  showLobby: () => void;
  rematch: () => void;

  // --- Options overlay ---
  options: {
    show: () => void;
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
    setFocused: (f: GameOverFocus) => void;
    click: (x: number, y: number) => void;
  };

  // --- Game actions (selection, placement, firing) ---
  gameAction: GameActionDeps;

  // --- Battle networking ---
  maybeSendAimUpdate: (x: number, y: number) => void;

  // --- Direct touch state ---
  /** Mark whether the user is using direct canvas touch (vs d-pad).
   *  When active, floating action buttons appear near the phantom. */
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
