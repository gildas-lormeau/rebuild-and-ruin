/**
 * BaseController — abstract base class implementing shared controller logic.
 *
 * Pure interfaces live in controller-interfaces.ts. This file contains the
 * implementation that depends on battle-system, pieces, spatial, etc.
 */

import { fireNextReadyCannon } from "./battle-system.ts";
import { autoPlaceRound1Cannons } from "./cannon-system.ts";
import type {
  CannonPlacementPreview,
  PiecePlacementPreview,
  PlayerController,
} from "./controller-interfaces.ts";
import { NORMAL_CANNON_SIZE, type ValidPlayerSlot } from "./game-constants.ts";
import type { Crosshair } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import {
  type BagState,
  createBag,
  nextPiece,
  type PieceShape,
} from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import { pxToTile, towerCenter, towerCenterTile } from "./spatial.ts";
import { Action, type CombinedCannonResult, type GameState } from "./types.ts";

const DEFAULT_CURSOR_ROW = Math.floor(GRID_ROWS / 2);
const DEFAULT_CURSOR_COL = Math.floor(GRID_COLS / 2);

/** Abstract base class implementing shared controller logic.
 *
 *  TEMPLATE METHOD PATTERN: Public lifecycle methods (startBuildPhase, finalizeBuildPhase,
 *  initBattleState) run base initialization then delegate to protected hooks.
 *  Subclasses MUST override the hooks (onStartBuildPhase, onFinalizeBuildPhase, onResetBattle),
 *  NEVER the public template methods — otherwise base initialization is skipped.
 *
 *  Naming: public methods use imperative verbs (startBuildPhase, finalizeBuildPhase).
 *  Protected hooks use on*() prefix (onStartBuildPhase, onFinalizeBuildPhase).
 *  When adding a new public lifecycle method, add a corresponding protected hook. */
export abstract class BaseController implements PlayerController {
  readonly playerId: ValidPlayerSlot;
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

  constructor(playerId: ValidPlayerSlot) {
    this.playerId = playerId;
  }

  /** Create a new piece bag and draw the first piece. */
  protected initBag(round: number, rng?: GameState["rng"]): void {
    this.bag = createBag(round, rng);
    this.currentPiece = nextPiece(this.bag);
  }

  /** Draw the next piece from the bag.
   *  @param _placed — must be literal `true`. This is a compile-time guard:
   *  callers can only pass `true` (not a variable), ensuring advanceBag is
   *  only called after a verified successful placement. Advancing without
   *  placing would skip a piece and desynchronize the bag with the board state.
   *  Do NOT remove this parameter or widen its type. */
  advanceBag(_placed: true): void {
    if (!this.bag) {
      console.warn("advanceBag called with null bag — likely a desync");
      return;
    }
    this.currentPiece = nextPiece(this.bag);
  }

  centerOn(row: number, col: number): void {
    const tile = towerCenterTile({ row, col });
    this.buildCursor = { row: tile.row, col: tile.col };
    const center = towerCenter({ row, col });
    this.crosshair = { x: center.col * TILE_SIZE, y: center.row * TILE_SIZE };
  }

  getCrosshair(): Crosshair {
    return { ...this.crosshair, playerId: this.playerId };
  }

  updateBindings(_keys: KeyBindings): void {}
  /** Pick a tower. Must set buildCursor/crosshair to the chosen tower. */
  abstract selectInitialTower(state: GameState, zone: number): void;
  /** Pick a tower for reselection. Same contract as selectInitialTower. */
  abstract selectReplacementTower(state: GameState, zone: number): void;
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
   *  Private — only called as an internal step of the startBuildPhase() template method.
   *  Contrast with initCannons() which is public for remote-controller use. */
  private initBuildPhase(state: GameState): void {
    this.initBag(state.round, state.rng);
    const player = state.players[this.playerId];
    if (player?.homeTower) {
      this.buildCursor = towerCenterTile(player.homeTower);
    }
    this.clampBuildCursor(this.currentPiece);
  }

  /** @final Template method — do NOT override. Override onStartBuildPhase() instead.
   *  Runs base initialization (bag + cursor) then delegates to the hook. */
  startBuildPhase(state: GameState): void {
    this.initBuildPhase(state);
    this.onStartBuildPhase(state);
  }

  /** Subclass hook called after bag/cursor are initialized. Override for AI targeting etc. */
  protected onStartBuildPhase(_state: GameState): void {}
  /** Called each frame during build. Returns placement previews for rendering. */
  abstract buildTick(state: GameState, dt: number): PiecePlacementPreview[];

  /** @final Template method — do NOT override. Override onFinalizeBuildPhase() instead.
   *  Calls the hook then clears bag/piece. */
  finalizeBuildPhase(state: GameState): void {
    this.onFinalizeBuildPhase(state);
    this.bag = null;
    this.currentPiece = null;
  }

  /** Subclass hook called before bag/piece are cleared. Override for AI cleanup etc. */
  protected onFinalizeBuildPhase(_state: GameState): void {}

  /** Called each frame during battle. Should call this.fire(state) to fire cannons. */
  abstract battleTick(state: GameState, dt: number): void;

  /** @final Template method — do NOT override. Override onResetBattle() instead.
   *  Initializes battle-phase state (cannonRotationIdx, cursors), then calls hook.
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
  /** @internal Called only from finalizeCannonPhase(). Do NOT call directly. */
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
   *  the startBuildPhase template method and never called externally. */
  initCannons(state: GameState, maxSlots: number): void {
    autoPlaceRound1Cannons(state, this.playerId, maxSlots);
  }
  /** Called at the end of the battle phase (e.g. clear held input actions). */
  endBattle(): void {}
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
  /** Called at start of cannon phase. Override to reset cannon cursor/mode. */
  startCannonPhase(_state: GameState): void {}

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
    const h = piece ? piece.height : 1;
    const w = piece ? piece.width : 1;
    if (direction === Action.UP)
      this.buildCursor.row = Math.max(0, this.buildCursor.row - 1);
    else if (direction === Action.DOWN)
      this.buildCursor.row = Math.min(GRID_ROWS - h, this.buildCursor.row + 1);
    else if (direction === Action.LEFT)
      this.buildCursor.col = Math.max(0, this.buildCursor.col - 1);
    else if (direction === Action.RIGHT)
      this.buildCursor.col = Math.min(GRID_COLS - w, this.buildCursor.col + 1);
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
    if (state.players[this.playerId]?.eliminated) return;
    if (state.timer <= 0 || state.battleCountdown > 0) return;
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
    const fired = fireNextReadyCannon(
      state,
      this.playerId,
      this.cannonRotationIdx,
      targetRow,
      targetCol,
    );
    if (!fired) return null;
    this.cannonRotationIdx = fired.rotationIdx;
    return fired.result;
  }
}
