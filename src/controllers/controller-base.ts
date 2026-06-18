import { autoPlaceRound1Cannons, nextReadyCannon } from "../game/index.ts";
import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import type {
  LifeLostEntry,
  UpgradePickEntry,
} from "../shared/core/dialog-state.ts";
import { NORMAL_CANNON_SIZE } from "../shared/core/game-constants.ts";
import type { WorldPos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import { Action, type KeyBindings } from "../shared/core/input-action.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  pxToTile,
  towerCenter,
  towerCenterTile,
} from "../shared/core/spatial.ts";
import type {
  AimResolver,
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
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";

const DEFAULT_CURSOR_ROW = Math.floor(GRID_ROWS / 2);
const DEFAULT_CURSOR_COL = Math.floor(GRID_COLS / 2);
/** Shared-empty snapshot so every controller constructed with no build
 *  phantoms points at the same zero-length array (avoids per-instance
 *  allocation and gives readers a stable identity). */
const EMPTY_PIECE_PHANTOMS: readonly PiecePhantom[] = Object.freeze([]);

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
 *  Both HumanController and AiController honor the per-phase ViewState
 *  declarations on the base — buildTick(state: BuildViewState),
 *  cannonTick(state: CannonViewState), battleTick(state: BattleViewState),
 *  tickUpgradePick(state: UpgradePickViewState), etc.  AiController upcasts
 *  to `GameState` locally at the 3 mutating-executor call sites
 *  (executePlacePiece, executePlaceCannon, fireNextReadyCannon) — see those
 *  call sites in controller-ai.ts for the contained casts.  See
 *  shared/core/system-interfaces.ts for the canonical bivariance note. */
export abstract class BaseController implements PlayerController {
  readonly playerId: ValidPlayerId;
  abstract readonly kind: "human" | "ai";
  buildCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  cannonCursor = { row: DEFAULT_CURSOR_ROW, col: DEFAULT_CURSOR_COL };
  /** Controller-owned phantom snapshots read by render + broadcast.
   *  Default empty; populated by each phase's start + tick methods.
   *  See BuildController / CannonController in system-interfaces.ts. */
  currentBuildPhantoms: readonly PiecePhantom[] = EMPTY_PIECE_PHANTOMS;
  currentCannonPhantom: CannonPhantom | undefined = undefined;
  crosshair = {
    x: DEFAULT_CURSOR_COL * TILE_SIZE,
    y: DEFAULT_CURSOR_ROW * TILE_SIZE,
  };
  /** Round-robin index into combined cannon list. undefined = no cannon fired yet this round.
   *  Reset in initBattleState() and onLifeLost(). */
  cannonRotationIdx: number | undefined;

  /** Resolves a raw battle-aim input to the occluded crosshair world position.
   *  Injected at construction: camera-backed for humans, sim-only for AI. */
  protected readonly aimResolver: AimResolver;

  constructor(playerId: ValidPlayerId, aimResolver: AimResolver) {
    this.playerId = playerId;
    this.aimResolver = aimResolver;
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
  abstract selectTower(state: GameViewState, zone: ZoneId): void;
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
  ): CannonPlacementPreview | undefined;
  /** Shared build-phase init: cursor on home tower.
   *  Private — only called as an internal step of the startBuildPhase() template method.
   *  Bag init lives in the engine's `prepareNextRound` (per-player loop)
   *  so host and watcher consume RNG identically — watchers have no local
   *  controllers, so a per-controller bag init advanced the host's RNG
   *  without advancing the watcher's. */
  private initBuildPhase(state: BuildViewState): void {
    const player = state.players[this.playerId];
    if (!player) return;
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
   *  Calls the hook and drops any lingering build-phantom snapshot so the render
   *  path doesn't keep drawing the last preview into the cannon/battle phases.
   *  (Controller-owned state requires the clear to be explicit; symmetric to
   *  finalizeCannonPhase.)
   *
   *  NOTE: piece-bag clearing is NOT done here. Bags live on shared GameState
   *  (`player.bag`), so they must be cleared on every peer at the same logical
   *  sim tick — see `clearAllPlayerBags` invocation in `round-end.mutate`.
   *  Doing it per-LOCAL-controller would cross-peer-asymmetrically clear bags,
   *  letting a late-arriving piece-place drain on one peer (no-op) and not the
   *  other (advance + potential RNG shuffle), drifting `state.rng`. */
  finalizeBuildPhase(state: BuildViewState): void {
    this.onFinalizeBuildPhase(state);
    this.currentBuildPhantoms = EMPTY_PIECE_PHANTOMS;
  }

  /** Subclass hook called before bag/piece are cleared. Override for AI cleanup etc. */
  protected onFinalizeBuildPhase(_state: BuildViewState): void {}

  /** Called each frame during battle. Human subclass builds a FireIntent
   *  from input and lets the runtime commit it; AI subclass pulls an
   *  intent from `brain.battle.tick`, calls `fireNextReadyCannon` (or
   *  `scheduleCannonFire` in the assisted-human variant), then routes
   *  the outcome back through `brain.battle.onFireResult` so the brain
   *  can hold its dwell on commit failure. */
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
   *  Drops any lingering cannon-phantom snapshot so the render path doesn't keep
   *  drawing the last preview into the battle phase. (Symmetric to
   *  `finalizeBuildPhase` clearing `currentBuildPhantoms`.)
   *  Call this for LOCAL controllers; remote controllers only need initCannons(). */
  finalizeCannonPhase(state: CannonViewState, maxSlots: number): void {
    this.flushCannons(state, maxSlots);
    this.initCannons(state, maxSlots);
    this.currentCannonPhantom = undefined;
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

  /** Resolve a battle-aim input through this controller's occlusion model and
   *  snap the crosshair onto the result. Base behavior matches the human
   *  pointer (instant crosshair move); AiController overrides to resolve-only
   *  so its crosshair can glide toward the target via stepCrosshairToward. */
  aim(state: BattleViewState, x: number, y: number): WorldPos {
    const world = this.aimResolver(state, x, y);
    this.setCrosshair(world.wx, world.wy);
    return world;
  }

  /** Compute a fire intent at the current crosshair position.
   *  Returns null if the player can't fire (timer expired, no cannon ready).
   *  The orchestrator executes the actual mutation via fireNextReadyCannon(). */
  fire(state: BattleViewState): FireIntent | null {
    if (state.timer <= 0 || state.battleCountdown > 0) return null;
    const targetRow = pxToTile(this.crosshair.y);
    const targetCol = pxToTile(this.crosshair.x);
    if (!nextReadyCannon(state, this.playerId, this.cannonRotationIdx))
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

  /** Deterministic max-timer fallback: random offer drawn from a private
   *  Rng derived from `(state.rng.seed, round, playerId)` — every peer
   *  reproduces the same pick from state alone, so host and peer converge
   *  without a broadcast. Deliberately does NOT draw from the shared
   *  lockstep `state.rng`: the deadline fires at per-peer local ticks, so
   *  a human pick racing it could consume the draw on one peer and not
   *  another, desyncing every subsequent shared draw. Mirrors
   *  `aiPickUpgrade` / `aiChooseLifeLost`. Auto-resolving controllers
   *  commit `entry.choice` long before max-timer expiry, so this path is
   *  reached only for entries still pending at the deadline (typically
   *  humans who didn't pick). */
  forceUpgradePick(
    entry: UpgradePickEntry,
    state: UpgradePickViewState,
  ): UpgradeId {
    const pickRng = new Rng(
      deriveAiStrategySeed(state.rng.seed, state.round, entry.playerId),
    );
    return entry.offers[Math.floor(pickRng.next() * entry.offers.length)]!;
  }
}
