/**
 * HumanController — human player behavior: keyboard/mouse-driven piece
 * placement, cannon placement, and battle crosshair movement.
 */

import { aimCannons } from "./battle-system.ts";
import { canPlacePiece, placePiece } from "./build-system.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
  findNearestValidCannonPlacement,
  hasAnyCannonPlacement,
  placeCannon,
} from "./cannon-system.ts";
import {
  type CannonPlacementPreview,
  CROSSHAIR_SPEED,
  type InputReceiver,
  type PiecePlacementPreview,
} from "./controller-interfaces.ts";
import { BaseController } from "./controller-types.ts";
import { BALLOON_COST, SUPER_GUN_COST } from "./game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import { rotateCW } from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import { cannonSize } from "./spatial.ts";
import type { GameState, Player } from "./types.ts";
import {
  Action,
  CannonMode,
  isBalloonMode,
  isNormalMode,
  isPlayerAlive,
  isSuperMode,
} from "./types.ts";

/** Speed multiplier when ROTATE (sprint) key is held during battle crosshair movement. */
const CROSSHAIR_SPRINT_MULTIPLIER = 2;

export class HumanController extends BaseController implements InputReceiver {
  override readonly kind = "human" as const;
  /** Pre-computed lowercase key → action map for fast matching. */
  private keyMap: Map<string, Action>;

  /** Cannon placement mode. */
  private cannonPlaceMode: CannonMode = CannonMode.NORMAL;
  /** When true, the next cannonTick() will snap the cursor to the nearest valid placement.
   *  Set after mouse/touch cursor placement; consumed (cleared) by snapCannonCursorIfNeeded(). */
  private shouldSnapCannonCursorNextTick = false;
  /** Actions currently held for continuous crosshair movement. */
  private readonly heldActions = new Set<Action>();

  constructor(playerId: number, keys: KeyBindings) {
    super(playerId);
    this.keyMap = buildKeyMap(keys);
  }

  /** Rebuild the key map from updated bindings. */
  override updateBindings(keys: KeyBindings): void {
    this.keyMap = buildKeyMap(keys);
  }

  selectInitialTower(_state: GameState, _zone: number): void {
    // Human selects via UI — selectionTick() drives confirmation
  }

  selectReplacementTower(_state: GameState, _zone: number): void {
    // Same as selectInitialTower — human reselects via UI
  }

  placeCannons(_state: GameState, _maxSlots: number): void {
    // Human places cannons interactively — nothing to do here
    this.cannonPlaceMode = CannonMode.NORMAL;
  }

  isCannonPhaseDone(state: GameState, maxSlots: number): boolean {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return true;
    return cannonSlotsUsed(player) >= maxSlots;
  }

  cannonTick(state: GameState, _dt: number): CannonPlacementPreview | null {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return null;
    const maxSlots = state.cannonLimits[this.playerId] ?? 0;
    const remaining = maxSlots - cannonSlotsUsed(player);
    if (remaining <= 0) return null;
    if (!hasAnyCannonPlacement(player, this.cannonPlaceMode, state))
      return null;

    const valid = this.resolveCannonPlacement(remaining, player, state);
    return {
      row: this.cannonCursor.row,
      col: this.cannonCursor.col,
      valid,
      mode: this.cannonPlaceMode,
      playerId: this.playerId,
    };
  }

  // --- Cannon cursor state fixups ---
  // Three operations keep the cursor valid after mode/position changes:
  //   downgradeCannonModeIfNeeded — revert to NORMAL if slots insufficient
  //   snapCannonCursorIfNeeded    — nudge to nearest valid tile after mouse/touch
  //   clampCannonCursorToMode     — keep footprint within grid bounds

  /** Atomically resolves cannon placement in order:
   *  1. Downgrade mode if insufficient slots (must run before validation).
   *  2. Snap cursor to nearest valid tile (must run before validation).
   *  3. Validate placement at current cursor. */
  private resolveCannonPlacement(
    remaining: number,
    player: Player,
    state: GameState,
  ): boolean {
    this.downgradeCannonModeIfNeeded(remaining);
    this.snapCannonCursorIfNeeded(player, state);
    return canPlaceCannon(
      player,
      this.cannonCursor.row,
      this.cannonCursor.col,
      this.cannonPlaceMode,
      state,
    );
  }

  /** Downgrade cannon mode if its slot cost exceeds remaining slots (SUPER→NORMAL, BALLOON→NORMAL).
   *  MUST be called before canPlaceCannon() in cannonTick() — otherwise the preview
   *  may show an impossible placement that confuses the player. */
  private downgradeCannonModeIfNeeded(remaining: number): void {
    if (isSuperMode(this.cannonPlaceMode) && remaining < SUPER_GUN_COST) {
      this.cannonPlaceMode = CannonMode.NORMAL;
    }
    if (isBalloonMode(this.cannonPlaceMode) && remaining < BALLOON_COST) {
      this.cannonPlaceMode = CannonMode.NORMAL;
    }
  }

  /** After mouse/touch cursor set, snap to nearest valid tile if current is invalid. */
  private snapCannonCursorIfNeeded(player: Player, state: GameState): void {
    if (!this.shouldSnapCannonCursorNextTick) return;
    this.shouldSnapCannonCursorNextTick = false;
    if (
      canPlaceCannon(
        player,
        this.cannonCursor.row,
        this.cannonCursor.col,
        this.cannonPlaceMode,
        state,
      )
    )
      return;
    const snapped = findNearestValidCannonPlacement(
      player,
      this.cannonCursor.row,
      this.cannonCursor.col,
      this.cannonPlaceMode,
      state,
    );
    if (snapped) {
      this.cannonCursor.row = snapped.row;
      this.cannonCursor.col = snapped.col;
    }
  }

  /** Set cannon cursor from absolute position (mouse/touch click).
   *  Offsets by floor(cannonSize/2) so the clicked tile lands at the phantom's center.
   *  Uses floor (not round) to bias top-left for even-sized cannons.
   *  Contrast with setBuildCursor() which offsets by the piece's pivot point instead. */
  // Offsets by floor(size/2) — cannons are symmetric squares, bias top-left for even sizes.
  override setCannonCursor(row: number, col: number): void {
    const sz = cannonSize(this.cannonPlaceMode);
    // Floor (not round) to bias top-left for even sizes, keeping the click inside the phantom
    const offset = Math.floor(sz / 2);
    super.setCannonCursor(row - offset, col - offset);
    this.shouldSnapCannonCursorNextTick = true;
  }

  override moveBuildCursor(direction: Action): void {
    super.moveBuildCursor(direction, this.currentPiece);
  }

  override moveCannonCursor(direction: Action): void {
    super.moveCannonCursor(direction, cannonSize(this.cannonPlaceMode));
  }

  /** Set build cursor from absolute position (mouse/touch click).
   *  Offsets by the current piece's pivot so the clicked tile aligns with the piece's visual center.
   *  Contrast with setCannonCursor() which offsets by floor(cannonSize/2) instead. */
  // Offsets by piece pivot — pieces have asymmetric shapes with a defined rotation center.
  override setBuildCursor(row: number, col: number): void {
    if (this.currentPiece) {
      const [pr, pc] = this.currentPiece.pivot;
      row -= pr;
      col -= pc;
    }
    super.setBuildCursor(row, col, this.currentPiece);
  }

  // startBuild: uses base class template (initBuildPhase + onStartBuild)
  // No onStartBuild override needed — human has no AI targeting setup.

  buildTick(state: GameState, _dt: number): PiecePlacementPreview[] {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return [];
    if (!this.currentPiece) return [];
    const valid = canPlacePiece(
      state,
      this.playerId,
      this.currentPiece,
      this.buildCursor.row,
      this.buildCursor.col,
    );
    return [
      {
        offsets: this.currentPiece.offsets,
        row: this.buildCursor.row,
        col: this.buildCursor.col,
        valid,
        playerId: this.playerId,
      },
    ];
  }

  battleTick(state: GameState, dt: number): void {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return;
    this.moveCrosshairFromInput(dt);
    aimCannons(state, this.playerId, this.crosshair.x, this.crosshair.y, dt);
  }

  /** Apply held directional keys to crosshair position (sprint when ROTATE held). */
  private moveCrosshairFromInput(dt: number): void {
    if (this.heldActions.size === 0) return;
    const speed =
      CROSSHAIR_SPEED *
      (this.heldActions.has(Action.ROTATE) ? CROSSHAIR_SPRINT_MULTIPLIER : 1) *
      dt;
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    if (this.heldActions.has(Action.UP))
      this.crosshair.y = Math.max(0, this.crosshair.y - speed);
    if (this.heldActions.has(Action.DOWN))
      this.crosshair.y = Math.min(H, this.crosshair.y + speed);
    if (this.heldActions.has(Action.LEFT))
      this.crosshair.x = Math.max(0, this.crosshair.x - speed);
    if (this.heldActions.has(Action.RIGHT))
      this.crosshair.x = Math.min(W, this.crosshair.x + speed);
  }

  /** Try to place a cannon at the current cursor position. Returns true on success. */
  tryPlaceCannon(state: GameState, maxSlots: number): boolean {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return false;
    const placed = placeCannon(
      player,
      this.cannonCursor.row,
      this.cannonCursor.col,
      maxSlots,
      this.cannonPlaceMode,
      state,
    );
    if (placed) this.shouldSnapCannonCursorNextTick = true;
    return placed;
  }

  /** Try to place the current build piece at the build cursor. */
  tryPlacePiece(state: GameState): boolean {
    if (!this.currentPiece || !this.bag) return false;
    const placed = placePiece(
      state,
      this.playerId,
      this.currentPiece,
      this.buildCursor.row,
      this.buildCursor.col,
    );
    if (placed) {
      this.advanceBag(true);
      this.clampBuildCursor(this.currentPiece);
    }
    return placed;
  }

  /** Rotate the current build piece clockwise (Tetris-style: pivot stays in place). */
  rotatePiece(): void {
    if (this.currentPiece) {
      const oldPivot = this.currentPiece.pivot;
      this.currentPiece = rotateCW(this.currentPiece);
      const newPivot = this.currentPiece.pivot;
      this.buildCursor.row += oldPivot[0] - newPivot[0];
      this.buildCursor.col += oldPivot[1] - newPivot[1];
      this.clampBuildCursor(this.currentPiece);
    }
  }

  /** Cycle cannon placement mode: NORMAL → SUPER → BALLOON → NORMAL.
   *  Skips modes whose slot cost exceeds remaining slots.
   *  Also re-clamps the cursor so the new cannon size stays within the grid. */
  cycleCannonMode(state: GameState, maxSlots: number): void {
    const player = state.players[this.playerId];
    if (!isPlayerAlive(player)) return;
    const used = cannonSlotsUsed(player);
    if (
      isNormalMode(this.cannonPlaceMode) &&
      used + SUPER_GUN_COST <= maxSlots
    ) {
      this.cannonPlaceMode = CannonMode.SUPER;
    } else if (
      (isNormalMode(this.cannonPlaceMode) ||
        isSuperMode(this.cannonPlaceMode)) &&
      used + BALLOON_COST <= maxSlots
    ) {
      this.cannonPlaceMode = CannonMode.BALLOON;
    } else {
      this.cannonPlaceMode = CannonMode.NORMAL;
    }
    this.clampCannonCursorToMode();
  }

  /** Clamp cannon cursor so the full cannon footprint (sz×sz) stays within the grid. */
  private clampCannonCursorToMode(): void {
    const sz = cannonSize(this.cannonPlaceMode);
    // Top-left anchor must leave room for sz tiles: max row/col = GRID - sz
    this.cannonCursor.row = Math.min(this.cannonCursor.row, GRID_ROWS - sz);
    this.cannonCursor.col = Math.min(this.cannonCursor.col, GRID_COLS - sz);
  }

  /** Check if a key event matches one of this controller's bindings. */
  matchKey(key: string): Action | null {
    return this.keyMap.get(key.toLowerCase()) ?? null;
  }

  handleKeyDown(action: Action): void {
    this.heldActions.add(action);
  }

  handleKeyUp(action: Action): void {
    this.heldActions.delete(action);
  }

  getCannonPlaceMode(): CannonMode {
    return this.cannonPlaceMode;
  }

  /** Human: no-op — auto-placement for humans with 0 cannons is handled by the game engine.
   *  AI overrides this to process its remaining queued placements from strategy.
   *  Called via finalizeCannonPhase() which guarantees flush→init order. */
  flushCannons(_state: GameState, _maxSlots: number): void {}

  endBattle(): void {
    this.heldActions.clear();
  }

  override onLifeLost(): void {
    super.onLifeLost();
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.heldActions.clear();
    this.shouldSnapCannonCursorNextTick = false;
  }

  onCannonPhaseStart(_state: GameState): void {
    // cannon cursor is set by the game in startCannonPhase
  }

  /** Reset state for new game. */
  override reset(): void {
    super.reset();
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.heldActions.clear();
    this.shouldSnapCannonCursorNextTick = false;
  }
}

function buildKeyMap(keys: KeyBindings): Map<string, Action> {
  return new Map([
    [keys.up.toLowerCase(), Action.UP],
    [keys.down.toLowerCase(), Action.DOWN],
    [keys.left.toLowerCase(), Action.LEFT],
    [keys.right.toLowerCase(), Action.RIGHT],
    [keys.confirm.toLowerCase(), Action.CONFIRM],
    [keys.rotate.toLowerCase(), Action.ROTATE],
  ]);
}
