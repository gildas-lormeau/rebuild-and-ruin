/**
 * Pure controller interfaces and types — no runtime imports.
 *
 * Extracted from controller-types.ts so that modules needing only the
 * PlayerController interface don't transitively depend on battle-system.
 */

import type { PixelPos, TilePos } from "./geometry-types.ts";
import type { PieceShape } from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import { Action, CannonMode, type GameState } from "./types.ts";

/** Orbit animation parameters for AI countdown idle animation. */
export type OrbitParams = {
  rx: number;
  ry: number;
  speed: number;
  phase: number;
};

export interface LocalPiecePhantom {
  offsets: [number, number][];
  row: number;
  col: number;
  valid: boolean;
  playerId: number;
}

export interface LocalCannonPhantom {
  row: number;
  col: number;
  valid: boolean;
  kind: CannonMode;
  playerId: number;
  facing: number;
}

export interface Crosshair {
  x: number;
  y: number;
  playerId: number;
  cannonReady?: boolean;
}

/** Shared interface — both AI and Human genuinely use these. */
export interface PlayerController {
  readonly playerId: number;
  readonly kind: "human" | "ai";

  /** Build cursor position. */
  buildCursor: TilePos;

  /** Cannon cursor position (set by the game at cannon phase start). */
  cannonCursor: TilePos;

  /** Update key bindings (no-op for AI). */
  updateBindings(keys: KeyBindings): void;

  /** Pick a tower. Returns false — use selectionTick to advance. */
  selectTower(state: GameState, zone: number): boolean;

  /** Pick a tower for reselection. Returns false — use selectionTick to advance. */
  reselect(state: GameState, zone: number): boolean;

  /** Tick during selection phase. Returns true when the player has confirmed. */
  selectionTick(dt: number, state?: GameState): boolean;

  /** Place cannons. AI places all immediately. Human sets up UI. */
  placeCannons(state: GameState, maxSlots: number): void;

  /** Whether the player has placed all their cannons. */
  isCannonPhaseDone(state: GameState, maxSlots: number): boolean;

  /** Called each frame during cannon phase. Returns phantom cannon for rendering. */
  cannonTick(state: GameState, dt: number): LocalCannonPhantom | null;

  /** Called once at the start of the build phase. */
  startBuild(state: GameState): void;

  /** Called each frame during the build phase. Returns phantom pieces to display. */
  buildTick(state: GameState, dt: number): LocalPiecePhantom[];

  /** Called at the end of the build phase. */
  endBuild(state: GameState): void;

  /** Called each frame during battle. Uses state.battleCountdown and state.timer to decide behavior. */
  battleTick(state: GameState, dt: number): void;

  /** Current crosshair for rendering. */
  getCrosshair(): Crosshair;

  /** Center cursors/crosshair on a tower position. */
  centerOn(row: number, col: number): void;

  /** Reset battle state (accumulators, targets). Called at battle start. */
  resetBattle(state?: GameState): void;

  /** Flush any remaining auto-placement queue (cannon timer expired). */
  flushCannons(state: GameState, maxSlots: number): void;

  /** Round-1 safety net: auto-place cannons if none were manually placed. No-op on round 2+. */
  initCannons(state: GameState, maxSlots: number): void;

  /** Clean up at end of battle. */
  onBattleEnd(): void;

  /** Reset stale state after losing a life (before reselection). */
  onLifeLost(): void;

  /** Reset all state for a new game. */
  reset(): void;

  /** Called at start of cannon phase. */
  onCannonPhaseStart(state: GameState): void;

  /** Move build cursor one tile in a direction (keyboard). Piece-aware clamping when provided. */
  moveBuildCursor(direction: Action, piece?: PieceShape | null): void;

  /** Move cannon cursor one tile in a direction (keyboard). */
  moveCannonCursor(direction: Action): void;

  /** Set build cursor to absolute position (mouse). Piece-aware clamping when provided. */
  setBuildCursor(row: number, col: number, piece?: PieceShape | null): void;

  /** Set cannon cursor to absolute position (mouse). */
  setCannonCursor(row: number, col: number): void;

  /** Set crosshair to absolute pixel position (mouse). */
  setCrosshair(x: number, y: number): void;

  /** Get the current build piece (for sending placement data). */
  getCurrentPiece(): PieceShape | null;

  /** Fire at the current crosshair position. */
  fire(state: GameState): void;
}

/** Human input handling — no-op in BaseController, overridden by HumanController. */
export interface InputReceiver {
  /** Match a keyboard key to an action name. Returns null if no match. */
  matchKey(key: string): Action | null;

  /** Register a held key for continuous crosshair movement (battle). */
  handleKeyDown(action: Action): void;

  /** Release a held key (battle). */
  handleKeyUp(action: Action): void;

  /** Rotate the current build piece clockwise. */
  rotatePiece(): void;

  /** Try to place the current build piece at the cursor. */
  tryPlacePiece(state: GameState): boolean;

  /** Try to place a cannon at the cursor. */
  tryPlaceCannon(state: GameState, maxSlots: number): boolean;

  /** Cycle cannon placement mode (normal/super/balloon). */
  cycleCannonMode(state: GameState, maxSlots: number): void;

  /** Current cannon placement mode. */
  getCannonPlaceMode(): CannonMode;
}

/** AI rendering queries — returns null in BaseController, overridden by AiController. */
export interface AiAnimatable {
  /** AI's current crosshair target (null for human — driven by mouse/keyboard). */
  getCrosshairTarget(): PixelPos | null;

  /** AI's orbit parameters for countdown animation (null if not orbiting). */
  getOrbitParams(): OrbitParams | null;
}

/** Battle crosshair movement speed in pixels per second. */
export const CROSSHAIR_SPEED = 80;

/** Type guard — true when ctrl is a HumanController (implements InputReceiver). */
export function isHuman(
  ctrl: PlayerController,
): ctrl is PlayerController & InputReceiver {
  return ctrl.kind === "human";
}

/** Type guard — true when ctrl is an AiController (implements AiAnimatable). */
export function isAiAnimatable(
  ctrl: PlayerController,
): ctrl is PlayerController & AiAnimatable {
  return ctrl.kind === "ai";
}
