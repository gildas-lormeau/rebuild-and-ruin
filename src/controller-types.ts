/**
 * BaseController — abstract base class implementing shared controller logic.
 *
 * Pure interfaces live in controller-interfaces.ts. This file contains the
 * implementation that depends on battle-system, pieces, spatial, etc.
 */

import { autoPlaceCannonsBalanced } from "./ai-strategy.ts";
import {
  fireCannon,
  fireSingleCaptured,
  nextReadyCombined,
} from "./battle-system.ts";
import type {
  Crosshair,
  LocalCannonPhantom,
  LocalPiecePhantom,
  PlayerController,
} from "./controller-interfaces.ts";
import { NORMAL_CANNON_SIZE } from "./game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import {
  type BagState,
  createBag,
  nextPiece,
  type PieceShape,
} from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import { pxToTile, towerCenter } from "./spatial.ts";
import { Action, type CombinedCannonResult, type GameState } from "./types.ts";

const DEFAULT_CURSOR_ROW = Math.floor(GRID_ROWS / 2);
const DEFAULT_CURSOR_COL = Math.floor(GRID_COLS / 2);

export abstract class BaseController implements PlayerController {
  readonly playerId: number;
  readonly kind: "human" | "ai" = "ai";
  buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  crosshair = {
    x: DEFAULT_CURSOR_COL * TILE_SIZE,
    y: DEFAULT_CURSOR_ROW * TILE_SIZE,
  };
  /** Round-robin index into combined cannon list. Reset in resetBattle() and onLifeLost(). */
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
    const center = towerCenter({ row, col });
    this.buildCursor = {
      row: Math.round(center.row),
      col: Math.round(center.col),
    };
    this.crosshair = { x: center.col * TILE_SIZE, y: center.row * TILE_SIZE };
  }

  getCrosshair(): Crosshair {
    return { ...this.crosshair, playerId: this.playerId };
  }

  updateBindings(_keys: KeyBindings): void {}
  /** Pick a tower. Must set buildCursor/crosshair to the chosen tower. */
  abstract selectTower(state: GameState, zone: number): boolean;
  /** Pick a tower for reselection. Same contract as selectTower. */
  abstract reselect(state: GameState, zone: number): boolean;
  /** Place cannons. AI places all immediately; Human sets up cursor/mode. */
  abstract placeCannons(state: GameState, maxSlots: number): void;
  /** Whether the player has placed all their cannons (slots exhausted or timer expired). */
  abstract isCannonPhaseDone(state: GameState, maxSlots: number): boolean;
  /** Called each frame during cannon phase. Must auto-downgrade cannonPlaceMode
   *  if its cost exceeds remaining slots (SUPER→NORMAL, BALLOON→NORMAL). */
  abstract cannonTick(state: GameState, dt: number): LocalCannonPhantom | null;
  /** Shared build-phase init: bag + cursor on home tower. */
  protected initBuildPhase(state: GameState): void {
    this.initBag(state.round, state.rng);
    const player = state.players[this.playerId]!;
    if (player.homeTower) {
      const center = towerCenter(player.homeTower);
      this.buildCursor = {
        row: Math.round(center.row),
        col: Math.round(center.col),
      };
    }
    this.clampBuildCursor(this.currentPiece);
  }

  /** Start build phase. Must call super.initBuildPhase(state) to init bag + cursor. */
  abstract startBuild(state: GameState): void;
  /** Called each frame during build. Returns phantom pieces for rendering. */
  abstract buildTick(state: GameState, dt: number): LocalPiecePhantom[];

  /** End build phase: clear bag/piece. Subclasses must call super.endBuild(). */
  endBuild(_state: GameState): void {
    this.bag = null;
    this.currentPiece = null;
  }

  /** Called each frame during battle. Should call this.fire(state) to fire cannons. */
  abstract battleTick(state: GameState, dt: number): void;

  /** Reset battle state (lastFiredIdx, cursors). Subclasses must call super.resetBattle(). */
  resetBattle(state?: GameState): void {
    this.lastFiredIdx = -1;
    if (state) {
      const player = state.players[this.playerId];
      if (player?.homeTower) {
        this.centerOn(player.homeTower.row, player.homeTower.col);
      }
    }
  }
  /** Flush remaining auto-placement queue when cannon timer expires. */
  abstract flushCannons(state: GameState, maxSlots: number): void;

  initCannons(state: GameState, maxSlots: number): void {
    if (state.round !== 1) return;
    const player = state.players[this.playerId];
    if (!player || player.eliminated || player.cannons.length > 0) return;
    autoPlaceCannonsBalanced(player, maxSlots, state);
  }
  /** Clean up at end of battle (e.g. clear AI fire targets). */
  abstract onBattleEnd(): void;
  onLifeLost(): void {
    this.lastFiredIdx = -1;
    this.bag = null;
    this.currentPiece = null;
  }
  reset(): void {
    this.buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.crosshair = {
      x: DEFAULT_CURSOR_COL * TILE_SIZE,
      y: DEFAULT_CURSOR_ROW * TILE_SIZE,
    };
    this.lastFiredIdx = -1;
    this.bag = null;
    this.currentPiece = null;
  }
  /** Called at start of cannon phase. Should reset cannon cursor and mode. */
  abstract onCannonPhaseStart(state: GameState): void;

  /** Human never auto-confirms — driven by UI. */
  selectionTick(_dt: number, _state?: GameState): boolean {
    return false;
  }

  getCurrentPiece(): PieceShape | null {
    return this.currentPiece;
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

  moveCannonCursor(direction: Action, size = NORMAL_CANNON_SIZE): void {
    if (direction === Action.UP)
      this.cannonCursor.row = Math.max(0, this.cannonCursor.row - 1);
    else if (direction === Action.DOWN)
      this.cannonCursor.row = Math.min(
        GRID_ROWS - size,
        this.cannonCursor.row + 1,
      );
    else if (direction === Action.LEFT)
      this.cannonCursor.col = Math.max(0, this.cannonCursor.col - 1);
    else if (direction === Action.RIGHT)
      this.cannonCursor.col = Math.min(
        GRID_COLS - size,
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

  /** Fire one cannon (own or captured) at the current crosshair position, round-robin. */
  fire(state: GameState): void {
    if (state.timer <= 0) return;
    const targetRow = pxToTile(this.crosshair.y);
    const targetCol = pxToTile(this.crosshair.x);
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
}
