import {
  aimCannons,
  cannonSlotsUsed,
  canPlaceCannon,
  canPlacePiece,
  effectivePlacementCost,
  hasAnyCannonPlacement,
  placeCannon,
} from "../game/index.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import { cannonModesForGame } from "../shared/core/cannon-mode-defs.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  TILE_SIZE,
} from "../shared/core/grid.ts";
import { rotateCW } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { cannonSize } from "../shared/core/spatial.ts";
import {
  type BattleViewState,
  type BuildViewState,
  type CannonPlacementPreview,
  type CannonViewState,
  CROSSHAIR_SPEED,
  type GameViewState,
  type InputReceiver,
  type PiecePlacementPreview,
  type PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import { Action } from "../shared/ui/input-action.ts";
import type { KeyBindings } from "../shared/ui/player-config.ts";
import { BaseController } from "./controller-types.ts";

/** Speed multiplier when ROTATE (sprint) key is held during battle crosshair movement. */
const CROSSHAIR_SPRINT_MULTIPLIER = 2;

export class HumanController extends BaseController implements InputReceiver {
  override readonly kind = "human" as const;
  /** Pre-computed lowercase key → action map for fast matching. */
  private keyMap: Map<string, Action>;

  /** Cannon placement mode. */
  private cannonPlaceMode: CannonMode = CannonMode.NORMAL;
  /** Whether this game is modern mode (gates modern-only cannon modes). */
  private modern = false;
  /** Actions currently held for continuous crosshair movement. */
  private readonly heldActions = new Set<Action>();

  constructor(playerId: ValidPlayerSlot, keys: KeyBindings) {
    super(playerId);
    this.keyMap = buildKeyMap(keys);
  }

  /** Rebuild the key map from updated bindings. */
  override updateBindings(keys: KeyBindings): void {
    this.keyMap = buildKeyMap(keys);
  }

  selectInitialTower(_state: GameViewState, _zone: number): void {
    // Human selects via UI — selectionTick() drives confirmation
  }

  selectReplacementTower(_state: GameViewState, _zone: number): void {
    // Same as selectInitialTower — human reselects via UI
  }

  placeCannons(state: CannonViewState, _maxSlots: number): void {
    // Human places cannons interactively — nothing to do here
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.modern = state.gameMode === "modern";
  }

  isCannonPhaseDone(state: CannonViewState, maxSlots: number): boolean {
    return cannonSlotsUsed(state.players[this.playerId]!) >= maxSlots;
  }

  cannonTick(
    state: CannonViewState,
    _dt: number,
  ): CannonPlacementPreview | null {
    const player = state.players[this.playerId]!;
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
  // Two operations keep the cursor valid after mode changes:
  //   downgradeCannonModeIfNeeded — revert to NORMAL if slots insufficient
  //   clampCannonCursorToMode     — keep footprint within grid bounds

  /** Resolves cannon placement: downgrade mode if needed, then validate. */
  private resolveCannonPlacement(
    remaining: number,
    player: Player,
    state: CannonViewState,
  ): boolean {
    this.downgradeCannonModeIfNeeded(remaining, player);
    return canPlaceCannon(
      player,
      this.cannonCursor.row,
      this.cannonCursor.col,
      this.cannonPlaceMode,
      state,
    );
  }

  /** Downgrade cannon mode if its slot cost exceeds remaining slots.
   *  MUST be called before canPlaceCannon() in cannonTick() — otherwise the preview
   *  may show an impossible placement that confuses the player. */
  private downgradeCannonModeIfNeeded(remaining: number, player: Player): void {
    if (remaining < effectivePlacementCost(player, this.cannonPlaceMode)) {
      this.cannonPlaceMode = CannonMode.NORMAL;
    }
  }

  /** Set cannon cursor from world-pixel position.
   *  Converts pixels to the top-left anchor so the cannon phantom is centered
   *  on the pointer. */
  override setCannonCursor(worldX: number, worldY: number): void {
    const sz = cannonSize(this.cannonPlaceMode);
    const szPx = sz * TILE_SIZE;

    // If the mouse is still inside the current phantom footprint, don't move
    const left = this.cannonCursor.col * TILE_SIZE;
    const top = this.cannonCursor.row * TILE_SIZE;
    if (
      worldX >= left &&
      worldX < left + szPx &&
      worldY >= top &&
      worldY < top + szPx
    ) {
      return;
    }

    // Mouse exited — recompute anchor centered on the mouse
    const halfPx = szPx / 2;
    this.cannonCursor.row = Math.max(
      0,
      Math.min(GRID_ROWS - sz, Math.round((worldY - halfPx) / TILE_SIZE)),
    );
    this.cannonCursor.col = Math.max(
      0,
      Math.min(GRID_COLS - sz, Math.round((worldX - halfPx) / TILE_SIZE)),
    );
  }

  override moveCannonCursor(direction: Action): void {
    super.moveCannonCursor(direction, cannonSize(this.cannonPlaceMode));
  }

  /** Set build cursor from absolute position (mouse/touch click).
   *  Offsets by the current piece's pivot so the clicked tile aligns with the piece's visual center.
   *  Contrast with setCannonCursor() which offsets by floor(cannonSize/2) instead. */
  // Offsets by piece pivot — pieces have asymmetric shapes with a defined rotation center.
  override setBuildCursor(
    state: BuildViewState,
    row: number,
    col: number,
  ): void {
    const piece = state.players[this.playerId]?.currentPiece;
    if (piece) {
      const [pr, pc] = piece.pivot;
      row -= pr;
      col -= pc;
    }
    super.setBuildCursor(state, row, col);
  }

  // startBuildPhase: uses base class template (initBuildPhase + onStartBuildPhase)
  // No onStartBuildPhase override needed — human has no AI targeting setup.

  buildTick(state: BuildViewState, _dt: number): PiecePlacementPreview[] {
    const piece = state.players[this.playerId]?.currentPiece;
    if (!piece) return [];
    const valid = canPlacePiece(
      state,
      this.playerId,
      piece.offsets,
      this.buildCursor.row,
      this.buildCursor.col,
    );
    return [
      {
        offsets: piece.offsets,
        row: this.buildCursor.row,
        col: this.buildCursor.col,
        valid,
        playerId: this.playerId,
      },
    ];
  }

  battleTick(state: BattleViewState, dt: number): void {
    this.moveCrosshairFromInput(dt);
    aimCannons(state, this.playerId, this.crosshair.x, this.crosshair.y, dt);
  }

  /** Apply held directional keys to crosshair position (sprint when ROTATE held).
   *  NOTE: Human uses pixel-velocity movement (Cartesian, all-axis simultaneous).
   *  AI uses tile-step movement (Manhattan, one axis at a time with jitter).
   *  Do NOT copy between controller-human.ts and controller-ai.ts. */
  private moveCrosshairFromInput(dt: number): void {
    if (this.heldActions.size === 0) return;
    const speed =
      CROSSHAIR_SPEED *
      (this.heldActions.has(Action.ROTATE) ? CROSSHAIR_SPRINT_MULTIPLIER : 1) *
      dt;
    if (this.heldActions.has(Action.UP))
      this.crosshair.y = Math.max(0, this.crosshair.y - speed);
    if (this.heldActions.has(Action.DOWN))
      this.crosshair.y = Math.min(MAP_PX_H, this.crosshair.y + speed);
    if (this.heldActions.has(Action.LEFT))
      this.crosshair.x = Math.max(0, this.crosshair.x - speed);
    if (this.heldActions.has(Action.RIGHT))
      this.crosshair.x = Math.min(MAP_PX_W, this.crosshair.x + speed);
  }

  /** Try to place a cannon at the current cursor position. Returns `true` on
   *  success, `false` on validation failure.
   *
   *  EXCEPTION to the intent/orchestrator pattern used by tryPlacePiece below
   *  (and documented as pattern #83 in skills/architecture-audit.md): this
   *  method calls `placeCannon` directly instead of returning an intent object.
   *  The historical reason is that `placeCannon` already accepts the structural
   *  subset it needs (`player`, `row`, `col`, `mode`, `state`) without a full
   *  GameState mutation, so there was no migration benefit. DO NOT copy
   *  tryPlacePiece's intent shape here without first rewriting placeCannon —
   *  and DO NOT copy this boolean-returning shape into new placement methods. */
  tryPlaceCannon(state: CannonViewState, maxSlots: number): boolean {
    const placed = placeCannon(
      state.players[this.playerId]!,
      this.cannonCursor.row,
      this.cannonCursor.col,
      maxSlots,
      this.cannonPlaceMode,
      state,
    );
    return placed;
  }

  /** Compute a place-piece intent at the build cursor.
   *  Returns null if placement is invalid. The orchestrator executes the
   *  mutation via placePiece() then calls ctrl.advanceBag(true).
   *  Contrast with tryPlaceCannon above, which is intentionally boolean — see
   *  its JSDoc for why cannon placement never adopted the intent pattern. */
  tryPlacePiece(state: BuildViewState): PlacePieceIntent | null {
    const player = state.players[this.playerId];
    if (!player?.currentPiece || !player.bag) return null;
    const piece = player.currentPiece;
    const valid = canPlacePiece(
      state,
      this.playerId,
      piece.offsets,
      this.buildCursor.row,
      this.buildCursor.col,
    );
    if (!valid) return null;
    return {
      playerId: this.playerId,
      piece,
      row: this.buildCursor.row,
      col: this.buildCursor.col,
    };
  }

  /** Rotate the current build piece clockwise (Tetris-style: pivot stays in place). */
  rotatePiece(state: BuildViewState): void {
    const player = state.players[this.playerId];
    if (!player?.currentPiece) return;
    const prevPivot = player.currentPiece.pivot;
    player.currentPiece = rotateCW(player.currentPiece);
    const newPivot = player.currentPiece.pivot;
    this.buildCursor.row += prevPivot[0] - newPivot[0];
    this.buildCursor.col += prevPivot[1] - newPivot[1];
    this.clampBuildCursor(player.currentPiece);
  }

  /** Cycle cannon placement mode through IMPLEMENTED_CANNON_MODES.
   *  Skips modes whose slot cost exceeds remaining slots.
   *  Also re-clamps the cursor so the new cannon size stays within the grid. */
  cycleCannonMode(state: CannonViewState, maxSlots: number): void {
    const player = state.players[this.playerId]!;
    const used = cannonSlotsUsed(player);
    const modes = cannonModesForGame(this.modern);
    const currentIdx = modes.findIndex(
      (def) => def.id === this.cannonPlaceMode,
    );
    for (let offset = 1; offset < modes.length; offset++) {
      const next = modes[(currentIdx + offset) % modes.length]!;
      if (used + effectivePlacementCost(player, next.id) <= maxSlots) {
        this.cannonPlaceMode = next.id;
        this.clampCannonCursorToMode();
        return;
      }
    }
    this.cannonPlaceMode = CannonMode.NORMAL;
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
  flushCannons(_state: CannonViewState, _maxSlots: number): void {}

  override endBattle(): void {
    this.heldActions.clear();
  }

  override onLifeLost(): void {
    super.onLifeLost();
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.heldActions.clear();
  }

  /** Reset state for new game. */
  override reset(): void {
    super.reset();
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.heldActions.clear();
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
