import {
  autoPlaceRound1Cannons,
  nextReadyCombined,
  useSmallPieces,
} from "../game/index.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import { NORMAL_CANNON_SIZE } from "../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { clearPlayerBag, initPlayerBag } from "../shared/core/player-types.ts";
import {
  pxToTile,
  towerCenter,
  towerCenterTile,
} from "../shared/core/spatial.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonPlacementPreview,
  CannonViewState,
  FireIntent,
  GameViewState,
  PiecePlacementPreview,
  PlayerController,
  UpgradePickViewState,
} from "../shared/core/system-interfaces.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import { Action } from "../shared/ui/input-action.ts";
import type {
  LifeLostEntry,
  UpgradePickEntry,
} from "../shared/ui/interaction-types.ts";
import type { KeyBindings } from "../shared/ui/player-config.ts";

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
 *  When adding a new public lifecycle method, add a corresponding protected hook.
 *
 *  @DIVERGENCE — state parameter types on the per-phase tick methods differ
 *  between concrete subclasses by design:
 *    - HumanController follows the base declarations: buildTick(state: BuildViewState),
 *      cannonTick(state: CannonViewState), battleTick(state: BattleViewState).
 *    - AiController overrides with buildTick/cannonTick/battleTick(state: GameState)
 *      because the AI strategy modules need fields outside each ViewState slice
 *      (e.g., full zone state, grunt lists, modifier tiles).
 *  TypeScript method bivariance permits both shapes under a single `PlayerController`
 *  interface; all real call sites pass `GameState`, so both signatures are satisfied.
 *  See shared/core/system-interfaces.ts:31-34 for the canonical bivariance note.
 *  DO NOT copy a signature from one subclass to the other — the ViewStates exist
 *  to document the minimum field contract per phase, not as runtime guards. */
export abstract class BaseController implements PlayerController {
  readonly playerId: ValidPlayerSlot;
  abstract readonly kind: "human" | "ai";
  buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  crosshair = {
    x: DEFAULT_CURSOR_COL * TILE_SIZE,
    y: DEFAULT_CURSOR_ROW * TILE_SIZE,
  };
  /** Round-robin index into combined cannon list. undefined = no cannon fired yet this round.
   *  Reset in initBattleState() and onLifeLost(). */
  cannonRotationIdx: number | undefined;

  constructor(playerId: ValidPlayerSlot) {
    this.playerId = playerId;
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
  abstract selectInitialTower(state: GameViewState, zone: number): void;
  /** Pick a tower for reselection. Same contract as selectInitialTower. */
  abstract selectReplacementTower(state: GameViewState, zone: number): void;
  /** Place cannons. AI places all immediately; Human sets up cursor/mode. */
  abstract placeCannons(state: CannonViewState, maxSlots: number): void;
  /** Whether the player has placed all their cannons (slots exhausted or timer expired). */
  abstract isCannonPhaseDone(state: CannonViewState, maxSlots: number): boolean;
  /** Called each frame during cannon phase. Returns a placement preview for rendering.
   *  Human subclass must call downgradeCannonModeIfNeeded() before validating placement
   *  to auto-downgrade when the selected mode's cost exceeds remaining slots.
   *  AI manages mode per-target from its pre-planned queue and does not need downgrading. */
  abstract cannonTick(
    state: CannonViewState,
    dt: number,
  ): CannonPlacementPreview | null;
  /** Shared build-phase init: bag + cursor on home tower.
   *  Private — only called as an internal step of the startBuildPhase() template method.
   *  Contrast with initCannons() which is public for remote-controller use. */
  private initBuildPhase(state: BuildViewState): void {
    const player = state.players[this.playerId];
    if (!player) return;
    const smallPieces = useSmallPieces(player);
    initPlayerBag(player, state.round, state.rng, smallPieces);
    if (player.homeTower) {
      this.buildCursor = towerCenterTile(player.homeTower);
    }
    this.clampBuildCursor(player.currentPiece);
  }

  /** @final Template method — do NOT override. Override onStartBuildPhase() instead.
   *  Runs base initialization (bag + cursor) then delegates to the hook. */
  startBuildPhase(state: BuildViewState): void {
    this.initBuildPhase(state);
    this.onStartBuildPhase(state);
  }

  /** Subclass hook called after bag/cursor are initialized. Override for AI targeting etc. */
  protected onStartBuildPhase(_state: BuildViewState): void {}
  /** Called each frame during build. Returns placement previews for rendering. */
  abstract buildTick(
    state: BuildViewState,
    dt: number,
  ): PiecePlacementPreview[];

  /** @final Template method — do NOT override. Override onFinalizeBuildPhase() instead.
   *  Calls the hook then clears bag/piece. */
  finalizeBuildPhase(state: BuildViewState): void {
    this.onFinalizeBuildPhase(state);
    const player = state.players[this.playerId];
    if (player) clearPlayerBag(player);
  }

  /** Subclass hook called before bag/piece are cleared. Override for AI cleanup etc. */
  protected onFinalizeBuildPhase(_state: BuildViewState): void {}

  /** Called each frame during battle. Subclasses call fire(state) to get intents;
   *  the orchestrator executes mutations (AI: via executeFire closure, Human: via runtime). */
  abstract battleTick(state: BattleViewState, dt: number): void;

  /** @final Template method — do NOT override. Override onResetBattle() instead.
   *  Initializes battle-phase state (cannonRotationIdx, cursors), then calls hook.
   *  Scope: cannonRotationIdx + cursor centering only — not a full game reset (see reset()). */
  initBattleState(state?: BattleViewState): void {
    this.cannonRotationIdx = undefined;
    if (state) {
      const player = state.players[this.playerId];
      if (player?.homeTower) {
        this.centerOn(player.homeTower.row, player.homeTower.col);
      }
    }
    this.onResetBattle(state);
  }

  /** Subclass hook called after base battle state is reset. Override for AI battle planning etc. */
  protected onResetBattle(_state?: BattleViewState): void {}
  /** @internal Called only from finalizeCannonPhase(). Do NOT call directly. */
  abstract flushCannons(state: CannonViewState, maxSlots: number): void;

  /** End-of-cannon-phase finalization: flush remaining placements, then auto-place
   *  round-1 cannons if none were placed. Guarantees correct flush→init ordering.
   *  Call this for LOCAL controllers; remote controllers only need initCannons(). */
  finalizeCannonPhase(state: CannonViewState, maxSlots: number): void {
    this.flushCannons(state, maxSlots);
    this.initCannons(state, maxSlots);
  }

  /** Round-1 safety net: auto-place cannons if none were manually placed.
   *  Public because remote controllers call it directly (their client handles
   *  flush locally, so the host only runs initCannons for them).
   *  Contrast with initBuildPhase which is private — it's an internal step of
   *  the startBuildPhase template method and never called externally. */
  initCannons(state: CannonViewState, maxSlots: number): void {
    autoPlaceRound1Cannons(state, this.playerId, maxSlots);
  }
  /** Called at the end of the battle phase (e.g. clear held input actions). */
  endBattle(): void {}
  onLifeLost(): void {
    this.cannonRotationIdx = undefined;
  }
  reset(): void {
    this.buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
    this.crosshair = {
      x: DEFAULT_CURSOR_COL * TILE_SIZE,
      y: DEFAULT_CURSOR_ROW * TILE_SIZE,
    };
    this.cannonRotationIdx = undefined;
  }
  /** Called at start of cannon phase. Override to reset cannon cursor/mode. */
  startCannonPhase(_state: CannonViewState): void {}

  /** Base returns false (human never auto-confirms — confirmation is driven by UI).
   *  AI overrides to return true after its selection animation completes. */
  selectionTick(_dt: number, _state?: GameViewState): boolean {
    return false;
  }

  /** Clamp build cursor so the entire piece stays within the grid. */
  clampBuildCursor(piece: PieceShape | undefined): void {
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

  moveBuildCursor(state: BuildViewState, direction: Action): void {
    const piece = state.players[this.playerId]?.currentPiece;
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

  setBuildCursor(state: BuildViewState, row: number, col: number): void {
    const piece = state.players[this.playerId]?.currentPiece;
    this.buildCursor = { row, col };
    if (piece) this.clampBuildCursor(piece);
  }
  setCannonCursor(worldX: number, worldY: number): void {
    this.cannonCursor = { row: pxToTile(worldY), col: pxToTile(worldX) };
  }
  setCrosshair(x: number, y: number): void {
    this.crosshair = { x, y };
  }

  /** Compute a fire intent at the current crosshair position.
   *  Returns null if the player can't fire (timer expired, no cannon ready).
   *  The orchestrator executes the actual mutation via fireNextReadyCannon(). */
  fire(state: BattleViewState): FireIntent | null {
    if (state.timer <= 0 || state.battleCountdown > 0) return null;
    const targetRow = pxToTile(this.crosshair.y);
    const targetCol = pxToTile(this.crosshair.x);
    if (!nextReadyCombined(state, this.playerId, this.cannonRotationIdx))
      return null;
    return { playerId: this.playerId, targetRow, targetCol };
  }

  /** Default matches HumanController: entry waits for local UI input,
   *  which commits via the runtime's `resolveAndSend` path. AiController
   *  overrides to auto-resolve. */
  autoResolvesUpgradePick(): boolean {
    return false;
  }

  /** Default matches HumanController: entry waits for local UI input.
   *  AiController overrides to auto-resolve via `aiChooseLifeLost`. */
  autoResolvesLifeLost(): boolean {
    return false;
  }

  /** Default no-op — only auto-resolving controllers need to tick. */
  tickLifeLost(
    _entry: LifeLostEntry,
    _dt: number,
    _autoDelaySeconds: number,
    _state: GameViewState,
  ): void {}

  /** Default no-op — only auto-resolving controllers need to tick. */
  tickUpgradePick(
    _entry: UpgradePickEntry,
    _entryIdx: number,
    _autoDelaySeconds: number,
    _dialogTimer: number,
    _state: UpgradePickViewState,
  ): void {}

  /** Deterministic max-timer fallback shared by every controller: prefer
   *  the AI's pre-cached `plannedChoice` (set during the lock-in window),
   *  otherwise roll `state.rng` — synced across host/peer so the fallback
   *  converges without a broadcast. Pure arithmetic, no AI imports. */
  forceUpgradePick(
    entry: UpgradePickEntry,
    state: UpgradePickViewState,
  ): UpgradeId {
    if (entry.plannedChoice !== null) return entry.plannedChoice;
    return entry.offers[Math.floor(state.rng.next() * entry.offers.length)]!;
  }
}
