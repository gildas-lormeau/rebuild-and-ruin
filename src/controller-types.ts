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
  CannonPlacementPreview,
  Crosshair,
  PiecePlacementPreview,
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
import {
  Action,
  type CombinedCannonResult,
  type GameState,
  isPlayerAlive,
} from "./types.ts";

const DEFAULT_CURSOR_ROW = Math.floor(GRID_ROWS / 2);
const DEFAULT_CURSOR_COL = Math.floor(GRID_COLS / 2);

export abstract class BaseController implements PlayerController {
  readonly playerId: number;
  abstract readonly kind: "human" | "ai";
  buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  crosshair = {
    x: DEFAULT_CURSOR_COL * TILE_SIZE,
    y: DEFAULT_CURSOR_ROW * TILE_SIZE,
  };
  /** Round-robin index into combined cannon list. null = no cannon fired yet this round.
   *  Reset in initBattleState() and onLifeLost(). */
  cannonRotationIdx: number | null = null;

  /** Piece bag for the build phase (shared by AI and Human). */
  protected bag: BagState | null = null;
  /** Current piece drawn from the bag. */
  currentPiece: PieceShape | null = null;

  constructor(playerId: number) {
    this.playerId = playerId;
  }

  /** Create a new piece bag and draw the first piece. */
  protected initBag(round: number, rng?: GameState["rng"]): void {
    this.bag = createBag(round, rng);
    this.currentPiece = nextPiece(this.bag);
  }

  /** Draw the next piece from the bag.
   *  @param _placed — must be `true`; enforces that callers only advance
   *  after a successful placement. Advancing without placing skips a piece
   *  and desynchronizes the bag with the board state. */
  advanceBag(_placed: true): void {
    if (!this.bag) {
      console.warn("advanceBag called with null bag — likely a desync");
      return;
    }
    this.currentPiece = nextPiece(this.bag);
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
  abstract selectTower(state: GameState, zone: number): void;
  /** Pick a tower for reselection. Same contract as selectTower. */
  abstract reselect(state: GameState, zone: number): void;
  /** Place cannons. AI places all immediately; Human sets up cursor/mode. */
  abstract placeCannons(state: GameState, maxSlots: number): void;
  /** Whether the player has placed all their cannons (slots exhausted or timer expired). */
  abstract isCannonPhaseDone(state: GameState, maxSlots: number): boolean;
  /** Called each frame during cannon phase. Returns a placement preview for rendering.
   *  Human subclass must call downgradeCannonModeIfNeeded() before validating placement
   *  to auto-downgrade when the selected mode's cost exceeds remaining slots.
   *  AI manages mode per-target from its pre-planned queue and does not need downgrading. */
  abstract cannonTick(
    state: GameState,
    dt: number,
  ): CannonPlacementPreview | null;
  /** Shared build-phase init: bag + cursor on home tower.
   *  Private — only called as an internal step of the startBuild() template method.
   *  Contrast with initCannons() which is public for remote-controller use. */
  private initBuildPhase(state: GameState): void {
    this.initBag(state.round, state.rng);
    const player = state.players[this.playerId];
    if (player?.homeTower) {
      const center = towerCenter(player.homeTower);
      this.buildCursor = {
        row: Math.round(center.row),
        col: Math.round(center.col),
      };
    }
    this.clampBuildCursor(this.currentPiece);
  }

  /** Template method — subclasses MUST override onStartBuild(), NOT startBuild().
   *  startBuild() runs base initialization (bag + cursor) then delegates to the hook. */
  startBuild(state: GameState): void {
    this.initBuildPhase(state);
    this.onStartBuild(state);
  }

  /** Subclass hook called after bag/cursor are initialized. Override for AI targeting etc. */
  protected onStartBuild(_state: GameState): void {}
  /** Called each frame during build. Returns placement previews for rendering. */
  abstract buildTick(state: GameState, dt: number): PiecePlacementPreview[];

  /** Template method — subclasses MUST override onFinalizeBuildPhase(), NOT finalizeBuildPhase().
   *  finalizeBuildPhase() calls the hook then clears bag/piece. */
  finalizeBuildPhase(state: GameState): void {
    this.onFinalizeBuildPhase(state);
    this.bag = null;
    this.currentPiece = null;
  }

  /** Subclass hook called before bag/piece are cleared. Override for AI cleanup etc. */
  protected onFinalizeBuildPhase(_state: GameState): void {}

  /** Called each frame during battle. Should call this.fire(state) to fire cannons. */
  abstract battleTick(state: GameState, dt: number): void;

  /** Initialize battle-phase state (cannonRotationIdx, cursors), then call subclass hook.
   *  Template method — subclasses override onResetBattle() instead of this method,
   *  so the base init is always guaranteed to run.
   *  Scope: cannonRotationIdx + cursor centering only — not a full game reset (see reset()). */
  initBattleState(state?: GameState): void {
    this.cannonRotationIdx = null;
    if (state) {
      const player = state.players[this.playerId];
      if (player?.homeTower) {
        this.centerOn(player.homeTower.row, player.homeTower.col);
      }
    }
    this.onResetBattle(state);
  }

  /** Subclass hook called after base battle state is reset. Override for AI battle planning etc. */
  protected onResetBattle(_state?: GameState): void {}
  /** Flush remaining auto-placement queue when cannon timer expires.
   *  Do NOT call directly — use finalizeCannonPhase() which guarantees flush→init order. */
  abstract flushCannons(state: GameState, maxSlots: number): void;

  /** End-of-cannon-phase finalization: flush remaining placements, then auto-place
   *  round-1 cannons if none were placed. Guarantees correct flush→init ordering.
   *  Call this for LOCAL controllers; remote controllers only need initCannons(). */
  finalizeCannonPhase(state: GameState, maxSlots: number): void {
    this.flushCannons(state, maxSlots);
    this.initCannons(state, maxSlots);
  }

  /** Round-1 safety net: auto-place cannons if none were manually placed.
   *  Public because remote controllers call it directly (their client handles
   *  flush locally, so the host only runs initCannons for them).
   *  Contrast with initBuildPhase which is private — it's an internal step of
   *  the startBuild template method and never called externally. */
  initCannons(state: GameState, maxSlots: number): void {
    if (state.round !== 1) return;
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player) || player.cannons.length > 0) return;
    autoPlaceCannonsBalanced(player, maxSlots, state);
  }
  /** Called at the end of the battle phase (e.g. clear AI fire targets). */
  abstract endBattle(): void;
  onLifeLost(): void {
    this.cannonRotationIdx = null;
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
    this.cannonRotationIdx = null;
    this.bag = null;
    this.currentPiece = null;
  }
  /** Called at start of cannon phase. Should reset cannon cursor and mode. */
  abstract onCannonPhaseStart(state: GameState): void;

  /** Base returns false (human never auto-confirms — confirmation is driven by UI).
   *  AI overrides to return true after its selection animation completes. */
  selectionTick(_dt: number, _state?: GameState): boolean {
    return false;
  }

  getCurrentPiece(): PieceShape | null {
    return this.currentPiece;
  }

  /** Clamp build cursor so the entire piece stays within the grid. */
  clampBuildCursor(piece: PieceShape | null): void {
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

  /** @param size — footprint size for grid-boundary clamping. Callers MUST
   *  compute from cannonSize(mode); the default (NORMAL) is a fallback only. */
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

  /** Fire one cannon at the current crosshair position (public entry point).
   *  Converts pixel crosshair to tile coords and delegates to fireNextCannon(). */
  fire(state: GameState): void {
    if (state.timer <= 0) return;
    const targetRow = pxToTile(this.crosshair.y);
    const targetCol = pxToTile(this.crosshair.x);
    this.fireNextCannon(state, targetRow, targetCol);
  }

  /** Fire the next ready cannon (own or captured) at a target tile via combined round-robin.
   *  Returns the fired cannon's result for AI chain-attack tracking, or null if no cannon is ready. */
  fireNextCannon(
    state: GameState,
    targetRow: number,
    targetCol: number,
  ): CombinedCannonResult | null {
    const result = nextReadyCombined(
      state,
      this.playerId,
      this.cannonRotationIdx,
    );
    if (!result) return null;
    this.cannonRotationIdx = result.combinedIdx;
    if (result.type === "own") {
      fireCannon(state, this.playerId, result.ownIdx, targetRow, targetCol);
    } else {
      fireSingleCaptured(state, result.cc, targetRow, targetCol);
    }
    return result;
  }
}
