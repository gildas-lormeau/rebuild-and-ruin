/**
 * PlayerController — abstracts AI vs Human behavior behind a common interface.
 *
 * The game loop calls the same methods on every controller. AI controllers
 * act immediately or on tick timers; Human controllers set up UI state and
 * react to mouse/keyboard events forwarded from main.ts.
 *
 * Concrete implementations: AiController (ai-controller.ts), HumanController (human-controller.ts).
 */

import type { CombinedCannonResult } from "./battle-system.ts";
import {
  fireCannon,
  fireSingleCaptured,
  nextReadyCombined,
} from "./battle-system.ts";
import type { PixelPos, TilePos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import type { BagState, PieceShape } from "./pieces.ts";
import { createBag, nextPiece } from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import type { GameState } from "./types.ts";
import {
  Action,
  CannonMode,
  NORMAL_CANNON_SIZE,
} from "./types.ts";

/** Orbit animation parameters for AI countdown idle animation. */
export type OrbitParams = { rx: number; ry: number; speed: number; phase: number };
export interface PhantomPiece {
  offsets: [number, number][];
  row: number;
  col: number;
  valid: boolean;
  playerId: number;
}
export interface PhantomCannon {
  row: number;
  col: number;
  valid: boolean;
  isSuper: boolean;
  isBalloon: boolean;
  playerId: number;
  facing: number;
}
export interface Crosshair {
  x: number;
  y: number;
  playerId: number;
  cannonReady?: boolean;
}
export interface PlayerController {
  readonly playerId: number;

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
  cannonTick(state: GameState, dt: number): PhantomCannon | null;

  /** Called once at the start of the build phase. */
  startBuild(state: GameState): void;

  /** Called each frame during the build phase. Returns phantom pieces to display. */
  buildTick(state: GameState, dt: number): PhantomPiece[];

  /** Called at the end of the build phase. */
  endBuild(state: GameState): void;

  /** Called each frame during battle. Uses state.battleCountdown and state.timer to decide behavior. */
  battleTick(state: GameState, dt: number): void;

  /** Current crosshair for rendering. */
  getCrosshair(): Crosshair;

  /** AI's current crosshair target (null for human — driven by mouse/keyboard). */
  getCrosshairTarget(): PixelPos | null;

  /** AI's orbit parameters for countdown animation (null if not orbiting). */
  getOrbitParams(): OrbitParams | null;

  /** Center cursors/crosshair on a tower position. */
  centerOn(row: number, col: number): void;

  /** Reset battle state (accumulators, targets). Called at battle start. */
  resetBattle(state?: GameState): void;

  /** Flush any remaining auto-placement queue (cannon timer expired). */
  flushCannons(state: GameState, maxSlots: number): void;

  /** Clean up at end of battle. */
  onBattleEnd(): void;

  /** Reset stale state after losing a life (before reselection). */
  onLifeLost(): void;

  /** Reset all state for a new game. */
  reset(): void;

  /** Called at start of cannon phase. */
  onCannonPhaseStart(state: GameState): void;

  /** Match a keyboard key to an action name. Returns null if no match. */
  matchKey(key: string): Action | null;

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

  /** Register a held key for continuous crosshair movement (battle). */
  handleKeyDown(action: Action): void;

  /** Release a held key (battle). */
  handleKeyUp(action: Action): void;

  /** Get the current build piece (for sending placement data). */
  getCurrentPiece(): PieceShape | null;

  /** Rotate the current build piece clockwise. */
  rotatePiece(): void;

  /** Try to place the current build piece at the cursor. */
  tryPlacePiece(state: GameState): boolean;

  /** Try to place a cannon at the cursor. */
  tryPlaceCannon(state: GameState, maxSlots: number): boolean;

  /** Cycle cannon placement mode (normal/super/balloon). */
  cycleCannonMode(state: GameState, maxSlots: number): void;

  /** Fire at the current crosshair position. */
  fire(state: GameState): void;

  /** Current cannon placement mode. */
  getCannonPlaceMode(): CannonMode;
}

const DEFAULT_CURSOR_ROW = Math.floor(GRID_ROWS / 2);
const DEFAULT_CURSOR_COL = Math.floor(GRID_COLS / 2);
/** Battle crosshair movement speed in pixels per second. */
export const CROSSHAIR_SPEED = 80;

export abstract class BaseController implements PlayerController {
  readonly playerId: number;
  buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  crosshair = {
    x: DEFAULT_CURSOR_COL * TILE_SIZE,
    y: DEFAULT_CURSOR_ROW * TILE_SIZE,
  };
  protected lastFiredIdx = -1;

  /** Piece bag for the build phase (shared by AI and Human). */
  protected bag: BagState | null = null;
  /** Current piece drawn from the bag. */
  protected currentPiece: PieceShape | null = null;

  constructor(playerId: number) {
    this.playerId = playerId;
  }

  /** Create a new piece bag and draw the first piece. */
  protected initBag(round: number, rng?: GameState["rng"]): void {
    this.bag = createBag(round, rng);
    this.currentPiece = nextPiece(this.bag);
  }

  /** Draw the next piece from the bag. */
  protected advanceBag(): void {
    if (this.bag) {
      this.currentPiece = nextPiece(this.bag);
    }
  }

  centerOn(row: number, col: number): void {
    this.buildCursor = { row: row + 1, col: col + 1 };
    this.crosshair = { x: (col + 1) * TILE_SIZE, y: (row + 1) * TILE_SIZE };
  }

  getCrosshair(): Crosshair {
    return { ...this.crosshair, playerId: this.playerId };
  }

  updateBindings(_keys: KeyBindings): void {}
  abstract selectTower(state: GameState, zone: number): boolean;
  abstract reselect(state: GameState, zone: number): boolean;
  abstract placeCannons(state: GameState, maxSlots: number): void;
  abstract isCannonPhaseDone(state: GameState, maxSlots: number): boolean;
  abstract cannonTick(state: GameState, dt: number): PhantomCannon | null;
  abstract startBuild(state: GameState): void;
  abstract buildTick(state: GameState, dt: number): PhantomPiece[];
  abstract endBuild(state: GameState): void;
  abstract battleTick(state: GameState, dt: number): void;
  abstract resetBattle(state?: GameState): void;
  abstract flushCannons(state: GameState, maxSlots: number): void;
  abstract onBattleEnd(): void;
  onLifeLost(): void {
    this.lastFiredIdx = -1;
    this.bag = null;
    this.currentPiece = null;
  }
  reset(): void {
    this.buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.crosshair = { x: DEFAULT_CURSOR_COL * TILE_SIZE, y: DEFAULT_CURSOR_ROW * TILE_SIZE };
    this.lastFiredIdx = -1;
    this.bag = null;
    this.currentPiece = null;
  }
  abstract onCannonPhaseStart(state: GameState): void;

  /** Human never auto-confirms — driven by UI. */
  selectionTick(_dt: number, _state?: GameState): boolean { return false; }

  getCurrentPiece(): PieceShape | null { return this.currentPiece; }
  getCrosshairTarget(): PixelPos | null { return null; }
  getOrbitParams(): OrbitParams | null { return null; }

  // --- Default implementations for input methods (overridden by Human) ---

  matchKey(_key: string): Action | null {
    return null;
  }

  /** Clamp build cursor so the entire piece stays within the grid. */
  protected clampBuildCursor(piece: PieceShape | null): void {
    if (!piece) return;
    this.buildCursor.row = Math.max(
      0,
      Math.min(GRID_ROWS - piece.height, this.buildCursor.row),
    );
    this.buildCursor.col = Math.max(
      0,
      Math.min(GRID_COLS - piece.width, this.buildCursor.col),
    );
  }

  moveBuildCursor(direction: Action, piece?: PieceShape | null): void {
    if (direction === Action.UP)
      this.buildCursor.row = Math.max(0, this.buildCursor.row - 1);
    else if (direction === Action.DOWN)
      this.buildCursor.row = Math.min(GRID_ROWS - 1, this.buildCursor.row + 1);
    else if (direction === Action.LEFT)
      this.buildCursor.col = Math.max(0, this.buildCursor.col - 1);
    else if (direction === Action.RIGHT)
      this.buildCursor.col = Math.min(GRID_COLS - 1, this.buildCursor.col + 1);
    if (piece) this.clampBuildCursor(piece);
  }

  moveCannonCursor(direction: Action): void {
    if (direction === Action.UP)
      this.cannonCursor.row = Math.max(0, this.cannonCursor.row - 1);
    else if (direction === Action.DOWN)
      this.cannonCursor.row = Math.min(
        GRID_ROWS - NORMAL_CANNON_SIZE,
        this.cannonCursor.row + 1,
      );
    else if (direction === Action.LEFT)
      this.cannonCursor.col = Math.max(0, this.cannonCursor.col - 1);
    else if (direction === Action.RIGHT)
      this.cannonCursor.col = Math.min(
        GRID_COLS - NORMAL_CANNON_SIZE,
        this.cannonCursor.col + 1,
      );
  }

  setBuildCursor(row: number, col: number, piece?: PieceShape | null): void {
    this.buildCursor = { row, col };
    if (piece) this.clampBuildCursor(piece);
  }
  setCannonCursor(row: number, col: number): void {
    this.cannonCursor = { row, col };
  }
  setCrosshair(x: number, y: number): void {
    this.crosshair = { x, y };
  }

  handleKeyDown(_action: Action): void {}
  handleKeyUp(_action: Action): void {}
  rotatePiece(): void {}
  tryPlacePiece(_state: GameState): boolean {
    return false;
  }
  tryPlaceCannon(_state: GameState, _maxSlots: number): boolean {
    return false;
  }
  cycleCannonMode(_state: GameState, _maxSlots: number): void {}

  /** Fire one cannon (own or captured) at the current crosshair position, round-robin. */
  fire(state: GameState): void {
    if (state.timer <= 0) return;
    const targetRow = Math.floor(this.crosshair.y / TILE_SIZE);
    const targetCol = Math.floor(this.crosshair.x / TILE_SIZE);
    this.fireNext(state, targetRow, targetCol);
  }

  /** Fire the next ready cannon (own or captured) at a target tile via combined round-robin. */
  protected fireNext(
    state: GameState,
    targetRow: number,
    targetCol: number,
  ): CombinedCannonResult | null {
    const result = nextReadyCombined(state, this.playerId, this.lastFiredIdx);
    if (!result) return null;
    this.lastFiredIdx = result.combinedIdx;
    if (result.type === "own") {
      fireCannon(state, this.playerId, result.ownIdx, targetRow, targetCol);
    } else {
      fireSingleCaptured(state, result.cc, targetRow, targetCol);
    }
    return result;
  }

  getCannonPlaceMode(): CannonMode {
    return CannonMode.NORMAL;
  }
}
