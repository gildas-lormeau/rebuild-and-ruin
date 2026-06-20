import {
  cannonSlotsUsed,
  canPlaceCannon,
  canPlacePiece,
  effectivePlacementCost,
  isCannonPlacementComplete,
} from "../game/index.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import { cannonModesForGame } from "../shared/core/cannon-mode-defs.ts";
import { CROSSHAIR_SPEED } from "../shared/core/game-constants.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  TILE_SIZE,
} from "../shared/core/grid.ts";
import { Action, type KeyBindings } from "../shared/core/input-action.ts";
import { rotateCW } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { cannonSize } from "../shared/core/spatial.ts";
import {
  type AimResolver,
  type BattleViewState,
  type BuildViewState,
  type CannonPlacementPreview,
  type CannonViewState,
  type GameViewState,
  type InputReceiver,
  type PiecePlacementPreview,
  type PlaceCannonIntent,
  type PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import { cannonSlotsFor } from "../shared/core/types.ts";
import { BaseController } from "./controller-base.ts";

/** Speed multiplier when ROTATE (sprint) key is held during battle crosshair movement. */
const CROSSHAIR_SPRINT_MULTIPLIER = 2;

export class HumanController extends BaseController implements InputReceiver {
  override readonly kind = "human" as const;
  /** Pre-computed lowercase key → action map for fast matching. */
  private keyMap: Map<string, Action>;

  private cannonPlaceMode: CannonMode = CannonMode.NORMAL;
  /** Whether this game is modern mode (gates modern-only cannon modes). */
  private modern = false;
  /** Actions currently held for continuous crosshair movement. */
  private readonly heldActions = new Set<Action>();
  /** Analog d-pad vector for continuous crosshair aiming (touch circle pad).
   *  When set, takes precedence over `heldActions` cardinals in
   *  `moveCrosshairFromInput`. Components are unit-vector by convention; the
   *  touch handler normalizes (with a center dead-zone) before writing. */
  private dpadVector: { x: number; y: number } | undefined;

  constructor(
    playerId: ValidPlayerId,
    keys: KeyBindings,
    aimResolver: AimResolver,
  ) {
    super(playerId, aimResolver);
    this.keyMap = buildKeyMap(keys);
  }

  /** Rebuild the key map from updated bindings. */
  override updateBindings(keys: KeyBindings): void {
    this.keyMap = buildKeyMap(keys);
  }

  selectTower(_state: GameViewState, _zone: number): void {
    // Human selects via UI — selectionTick() drives confirmation
  }

  placeCannons(state: CannonViewState, _maxSlots: number): void {
    // Human places cannons interactively — nothing to do here
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.modern = state.gameMode === "modern";
  }

  isCannonPhaseDone(state: CannonViewState, maxSlots: number): boolean {
    return isCannonPlacementComplete(
      state.players[this.playerId]!,
      maxSlots,
      state,
    );
  }

  cannonTick(
    state: CannonViewState,
    _dt: number,
  ): CannonPlacementPreview | undefined {
    const player = state.players[this.playerId]!;
    const maxSlots = cannonSlotsFor(state, this.playerId);
    // Once the player has no cannon left to place (all slots used OR no legal
    // tile remains), show no phantom — the phase is just waiting on the other
    // players to finish. Mirrors the AI's `tickCannon` returning a null
    // phantom when its brain is done; without this the human keeps rendering
    // an unplaceable phantom on screen until every slot finishes the phase.
    if (isCannonPlacementComplete(player, maxSlots, state)) {
      this.currentCannonPhantom = undefined;
      return undefined;
    }
    const remaining = maxSlots - cannonSlotsUsed(player);
    const valid =
      remaining > 0 && this.resolveCannonPlacement(remaining, player, state);
    const result: CannonPlacementPreview = {
      row: this.cannonCursor.row,
      col: this.cannonCursor.col,
      valid,
      mode: this.cannonPlaceMode,
      playerId: this.playerId,
    };
    this.currentCannonPhantom = result;
    return result;
  }

  // Human's cannonTick is pure (no RNG/timer advancement), so calling it at
  // dt=0 from startCannonPhase seeds currentCannonPhantom before the first
  // real tick runs — the first post-banner GAME frame renders with the
  // preview already in place instead of one tick late. (Unlike
  // onStartBuildPhase below, this does NOT land in the entry banner's
  // B-snapshot: cannon priming runs in the banner's postDisplay, after
  // both scenes were captured; build priming runs in the mutate, before.)
  override startCannonPhase(state: CannonViewState): void {
    super.startCannonPhase(state);
    this.currentCannonPhantom = this.cannonTick(state, 0);
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
    const halfPx = (sz * TILE_SIZE) / 2;

    // Hysteresis: hold position while the pointer stays within half a tile
    // of the phantom's visual center. A footprint-wide dead zone exceeded
    // the snap stride for odd sizes (3×3), making half the anchor positions
    // unreachable.
    const centerX = this.cannonCursor.col * TILE_SIZE + halfPx;
    const centerY = this.cannonCursor.row * TILE_SIZE + halfPx;
    if (
      Math.abs(worldX - centerX) < TILE_SIZE / 2 &&
      Math.abs(worldY - centerY) < TILE_SIZE / 2
    ) {
      return;
    }

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

  // startBuildPhase: uses base class template (initBuildPhase + onStartBuildPhase).
  // Override onStartBuildPhase to seed currentBuildPhantoms so banner B-snapshots
  // show the preview even before the first tick runs. buildTick is pure
  // (no dt-dependent state), so reusing it at dt=0 is safe.
  protected override onStartBuildPhase(state: BuildViewState): void {
    this.currentBuildPhantoms = this.buildTick(state, 0);
  }

  buildTick(state: BuildViewState, _dt: number): PiecePlacementPreview[] {
    const piece = state.players[this.playerId]?.currentPiece;
    if (!piece) {
      this.currentBuildPhantoms = [];
      return [];
    }
    const valid = canPlacePiece(
      state,
      this.playerId,
      piece.offsets,
      this.buildCursor.row,
      this.buildCursor.col,
    );
    const result: PiecePlacementPreview[] = [
      {
        offsets: piece.offsets,
        row: this.buildCursor.row,
        col: this.buildCursor.col,
        valid,
        playerId: this.playerId,
      },
    ];
    this.currentBuildPhantoms = result;
    return result;
  }

  battleTick(_state: BattleViewState, dt: number): void {
    // Cannon facing is computed cosmetically by the cannon-animator from the
    // crosshair — the controller only moves the crosshair here.
    this.moveCrosshairFromInput(dt);
  }

  /** Apply held directional keys to crosshair position (sprint when ROTATE held).
   *  NOTE: Human uses pixel-velocity movement (Cartesian, all-axis simultaneous).
   *  AI uses tile-step movement (Manhattan, one axis at a time with jitter).
   *  Do NOT copy between controller-human.ts and controller-ai.ts. */
  private moveCrosshairFromInput(dt: number): void {
    if (this.dpadVector === undefined && this.heldActions.size === 0) return;
    const speed =
      CROSSHAIR_SPEED *
      (this.heldActions.has(Action.ROTATE) ? CROSSHAIR_SPRINT_MULTIPLIER : 1) *
      dt;
    if (this.dpadVector !== undefined) {
      this.crosshair.x = Math.max(
        0,
        Math.min(MAP_PX_W, this.crosshair.x + this.dpadVector.x * speed),
      );
      this.crosshair.y = Math.max(
        0,
        Math.min(MAP_PX_H, this.crosshair.y + this.dpadVector.y * speed),
      );
      return;
    }
    if (this.heldActions.has(Action.UP))
      this.crosshair.y = Math.max(0, this.crosshair.y - speed);
    if (this.heldActions.has(Action.DOWN))
      this.crosshair.y = Math.min(MAP_PX_H, this.crosshair.y + speed);
    if (this.heldActions.has(Action.LEFT))
      this.crosshair.x = Math.max(0, this.crosshair.x - speed);
    if (this.heldActions.has(Action.RIGHT))
      this.crosshair.x = Math.min(MAP_PX_W, this.crosshair.x + speed);
  }

  /** Build a `PlaceCannonIntent` from the human's cursor + selected mode.
   *  Returns the intent unconditionally — the orchestrator (`executePlaceCannon`)
   *  validates slot budget and tile occupancy on apply. */
  tryPlaceCannon(_state: CannonViewState): PlaceCannonIntent {
    return {
      playerId: this.playerId,
      row: this.cannonCursor.row,
      col: this.cannonCursor.col,
      mode: this.cannonPlaceMode,
    };
  }

  /** Compute a place-piece intent at the build cursor.
   *  Returns null if placement is invalid. The orchestrator executes the
   *  mutation via placePiece() then calls ctrl.advanceBag(true). */
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

  setDpadVector(x: number, y: number): void {
    this.dpadVector = { x, y };
  }

  clearDpadVector(): void {
    this.dpadVector = undefined;
  }

  getCannonPlaceMode(): CannonMode {
    return this.cannonPlaceMode;
  }

  override endBattle(): void {
    this.clearHeldInput();
  }

  override onLifeLost(): void {
    super.onLifeLost();
    this.clearTransientInputState();
  }

  /** Reset state for new game. */
  override reset(): void {
    super.reset();
    this.clearTransientInputState();
  }

  /** Drop any held keys and the analog d-pad vector. Shared by `endBattle`
   *  (battle exit) and the heavier `clearTransientInputState`. */
  private clearHeldInput(): void {
    this.heldActions.clear();
    this.dpadVector = undefined;
  }

  /** Shared body of `onLifeLost` / `reset`: revert the cannon-mode selection
   *  to NORMAL and clear held input so a fresh phase starts with no carryover.
   *  `endBattle` does NOT reset the cannon mode (battle exit leaves the next
   *  cannon phase to re-arm it), so it uses `clearHeldInput` alone. */
  private clearTransientInputState(): void {
    this.cannonPlaceMode = CannonMode.NORMAL;
    this.clearHeldInput();
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
