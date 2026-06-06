/**
 * Thin host wrapper around a pluggable `AiBrain`. Controller owns cursor
 * state, movement helpers, trait-derived getters, and lifecycle hooks;
 * brain owns phase state machines + decision dispatch. The brain is
 * injected via the constructor (see `controller-factory.ts`) so alternate
 * AI implementations can be tried without modifying this file. Default
 * brain comes from `ai/ai-brain.ts`.
 */

import {
  emitFireDecisionDiag,
  isAiBattleDiagHookActive,
} from "../ai/ai-battle-diag.ts";
import type { AiBrain } from "../ai/ai-brain-types.ts";
import type {
  AiStrategy,
  BattleHost,
  BuildHost,
  CannonHost,
  SelectionHost,
} from "../ai/ai-strategy-types.ts";
import { secondsToTicks } from "../ai/ai-utils.ts";
import { CROSSHAIR_SPEED, SIM_TICK_DT } from "../shared/core/game-constants.ts";
import type { PixelPos, TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  type AiAnimatable,
  type BattleViewState,
  type BuildViewState,
  type CannonPlacementPreview,
  type CannonViewState,
  type GameViewState,
  type PiecePlacementPreview,
  type UpgradePickViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import {
  LifeLostChoice,
  type LifeLostEntry,
  type UpgradePickEntry,
} from "../shared/ui/interaction-types.ts";
import { type AiCommitPort, DIRECT_COMMIT_PORT } from "./ai-commit-port.ts";
import { BaseController } from "./controller-base.ts";

// Compile-time guarantee: AiController structurally satisfies every Host
// interface the brain's phase ops expect. Adding a required field to any
// Host without implementing it here — or renaming a field a Host depends
// on — breaks this assertion at the class declaration site, not at
// downstream brain.X.tick() call sites.
type AllAiPhaseHosts = SelectionHost & BuildHost & CannonHost & BattleHost;

// ── Tile-cursor movement tuning ──
/** Manhattan distance below which cursor snaps to target (tiles). */
const TILE_ARRIVAL_TOLERANCE = 0.05;
/** Rate at which perpendicular jitter decays toward target (1/seconds). */
const JITTER_DECAY_RATE = 4;
/** Maximum perpendicular jitter amplitude (tiles). */
const JITTER_MAX_AMPLITUDE = 0.6;
const _assertAiControllerSatisfiesAllHosts = (
  controller: AiController,
): AllAiPhaseHosts => controller;

export class AiController extends BaseController implements AiAnimatable {
  override readonly kind: "ai" | "human" = "ai";
  /** Pluggable AI strategy (decision-making). */
  readonly strategy: AiStrategy;
  /** Pluggable AI brain (phase state machines + decision dispatch). */
  protected readonly brain: AiBrain;
  /** Apply-strategy for the three mutating commits. Direct (mutate
   *  GameState) by default; the assisted-human variant injects a networked
   *  port that schedules + broadcasts instead. */
  protected readonly commit: AiCommitPort;

  // --- Movement state (used by stepTileCursorToward) ---
  /** Which axis to move first — randomized when a new target is set. */
  private tileMoveRowFirst = true;
  /** Fixed perpendicular jitter offset (tiles), set once per movement. */
  private tileJitterOffset = 0;

  constructor(
    playerId: ValidPlayerId,
    strategy: AiStrategy,
    brain: AiBrain,
    commit: AiCommitPort = DIRECT_COMMIT_PORT,
  ) {
    super(playerId);
    this.strategy = strategy;
    this.brain = brain;
    this.commit = commit;
  }

  // -----------------------------------------------------------------------
  // AiAnimatable interface
  // -----------------------------------------------------------------------

  getCrosshairTarget(): PixelPos | null {
    return this.brain.battle.getCrosshairTarget();
  }

  /** When true, castle rects hug the river bank (plug approach).
   *  When false (default), rects shrink at bank corners (tighter ring). */
  get bankHugging(): boolean {
    return this.strategy.bankHugging;
  }
  set bankHugging(bankHugging: boolean) {
    this.strategy.bankHugging = bankHugging;
  }

  // -----------------------------------------------------------------------
  // Trait-derived getters (used by phase Host interfaces)
  // -----------------------------------------------------------------------

  /** Delay multiplier derived from thinkingSpeed: 1=slow(1.4×), 2=normal(1×), 3=fast(0.65×). */
  get delayScale(): number {
    return [1.4, 1.0, 0.65][this.strategy.thinkingSpeed - 1]!;
  }

  /** Build cursor speed scaled by cursorSkill. */
  get buildCursorSpeed(): number {
    return this.brain.build.cursorSpeedFor(this.strategy.cursorSkill);
  }

  /** Cannon cursor speed scaled by cursorSkill. */
  get cannonCursorSpeed(): number {
    return this.brain.cannon.cursorSpeedFor(this.strategy.cursorSkill);
  }

  /** Distance threshold (tiles) below which the cursor uses 1× instead of 2× speed.
   *  cursorSkill 1=8 (rarely boosts), 2=5 (default), 3=3 (boosts early). */
  get boostThreshold(): number {
    return [8, 5, 3][this.strategy.cursorSkill - 1]!;
  }

  /** Battle boost threshold in pixels.
   *  cursorSkill 1=never boosts (Infinity), 2=always (0, default), 3=always (0). */
  get battleBoostDist(): number {
    return this.strategy.cursorSkill === 1 ? Infinity : 0;
  }

  /** Whether the AI pre-picks next target while firing (cursorSkill >= 2). */
  get anticipatesTarget(): boolean {
    return this.strategy.cursorSkill >= 2;
  }

  /** Humanize AI timing — returns an integer **tick count**.
   *  Callers in ai-phase-*.ts decrement by 1 each AI sub-step.
   *  Typical ranges (seconds, before delayScale):
   *    Selection: 0.8–1.0s base (slow, mimics browsing)
   *    Build/Cannon: 0.2–0.3s base (fast placement decisions)
   *    Battle: 0.1–0.2s base (reactive targeting)
   *  delayScale: ~1.4× easy, 1.0× normal, ~0.65× hard. */
  scaledDelay(base: number, spread: number): number {
    const seconds =
      (base + this.strategy.rng.next() * spread) * this.delayScale;
    return secondsToTicks(seconds);
  }

  // -----------------------------------------------------------------------
  // Selection phase
  // -----------------------------------------------------------------------

  override selectTower(state: GameViewState, zone: ZoneId): void {
    this.brain.selection.init(this, state, zone);
  }

  override selectionTick(_dt: number, state?: GameViewState): boolean {
    return this.brain.selection.tick(this, state);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  protected override onStartBuildPhase(state: BuildViewState): void {
    this.brain.build.init(this, state);
    // Leave currentBuildPhantoms at the base-class empty default here.
    // The brain's build tick decrements timers, advances rotation frames,
    // steps the cursor, and draws from strategy.rng — calling it with dt=0
    // would mutate AI state before the first real frame. The first
    // buildTick() call populates currentBuildPhantoms.
  }

  buildTick(state: BuildViewState, _dt: number): PiecePlacementPreview[] {
    const result = this.brain.build.tick(this, state);
    this.currentBuildPhantoms = result.phantoms;
    if (result.commit) {
      const placed = this.commit.placePiece(state, result.commit, this);
      this.brain.build.onPlaceResult(this, state, placed);
    }
    return result.phantoms;
  }

  protected override onFinalizeBuildPhase(state: BuildViewState): void {
    this.brain.build.finalize(this, state);
  }

  // -----------------------------------------------------------------------
  // Cannon phase
  // -----------------------------------------------------------------------

  override placeCannons(state: CannonViewState, maxSlots: number): void {
    this.brain.cannon.init(this, state, maxSlots);
  }

  override isCannonPhaseDone(
    _state: CannonViewState,
    _maxSlots: number,
  ): boolean {
    return this.brain.cannon.isDone();
  }

  cannonTick(
    state: CannonViewState,
    _dt: number,
  ): CannonPlacementPreview | undefined {
    const result = this.brain.cannon.tick(this, state);
    if (result.commit) {
      // Validation rejection here is self-correcting: the brain has already
      // advanced to THINKING, the next decision cycle picks a fresh target
      // against updated state. A tight retry of the same blocked target is
      // prevented by the post-place THINKING delay (cf. build phase's
      // explicit BLOCKED_RETRY_DELAY in ai-phase-build.ts:199), so the
      // placeCannon result is intentionally not consumed here.
      this.commit.placeCannon(state, result.commit, this.brain.cannon.maxSlots);
    }
    // Leave currentCannonPhantom populated by the startCannonPhase hook
    // empty on init (see note there): AI's cannon tick decrements timers
    // and draws from strategy.rng, so seeding at dt=0 would mutate state
    // before the first real frame. Assign from tick result here.
    const phantom = result.phantom ?? undefined;
    this.currentCannonPhantom = phantom;
    return phantom;
  }

  flushCannons(state: CannonViewState, maxSlots: number): void {
    // Commit intents in order; stop on the first validation failure so a
    // wedge in the brain's planning (mismatched slot accounting, occupied
    // tile, etc.) can't burn frames retrying the same intent.
    for (const intent of this.brain.cannon.flush(this, state)) {
      if (!this.commit.placeCannon(state, intent, maxSlots)) break;
    }
  }

  // -----------------------------------------------------------------------
  // Battle phase
  // -----------------------------------------------------------------------

  protected override onResetBattle(state?: BattleViewState): void {
    // Re-roll orbit each battle. Fires only for local controllers (the
    // template runs on `localControllers(...)` per phase-ticks), so remote
    // placeholders never draw — host/watcher stay in lockstep regardless
    // of which controller variant landed at the slot.
    this.brain.battle.setOrbitAngle(this.strategy.rng.next() * Math.PI * 2);
    this.brain.battle.init(this, state);
  }

  battleTick(state: BattleViewState, _dt: number): void {
    const result = this.brain.battle.tick(this, state);
    if (!result.commit) return;
    const rotationIdx = this.commit.fire(state, result.commit, this);
    if (rotationIdx !== null) {
      this.cannonRotationIdx = rotationIdx;
      if (result.origin && isAiBattleDiagHookActive()) {
        emitFireDecisionDiag(result.origin, result.pickPath);
      }
    }
    this.brain.battle.onFireResult(this, state, rotationIdx !== null);
  }

  // -----------------------------------------------------------------------
  // Upgrade pick (modern mode)
  // -----------------------------------------------------------------------

  override autoResolvesUpgradePick(): boolean {
    return true;
  }

  override tickUpgradePick(
    entry: UpgradePickEntry,
    entryIdx: number,
    autoDelaySeconds: number,
    dialogTimer: number,
    state: UpgradePickViewState,
  ): void {
    this.brain.tickUpgradePick(
      entry,
      entryIdx,
      secondsToTicks(autoDelaySeconds),
      dialogTimer,
      state,
    );
  }

  // -----------------------------------------------------------------------
  // Life-lost dialog (auto-resolve via brain.chooseLifeLost)
  // -----------------------------------------------------------------------

  override autoResolvesLifeLost(): boolean {
    return true;
  }

  override tickLifeLost(
    entry: LifeLostEntry,
    dt: number,
    autoDelaySeconds: number,
    state: GameViewState,
  ): void {
    entry.autoTimer += dt;
    if (
      entry.choice === LifeLostChoice.PENDING &&
      entry.autoTimer >= autoDelaySeconds
    ) {
      entry.choice = this.brain.chooseLifeLost(entry, state);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override onLifeLost(): void {
    super.onLifeLost();
    this.brain.selection.reset();
    this.brain.build.reset();
    this.brain.cannon.reset();
    this.brain.battle.resetKeepOrbit();
    this.strategy.onLifeLost();
  }

  override reset(): void {
    super.reset();
    this.brain.selection.reset();
    this.brain.build.reset();
    this.brain.cannon.reset();
    this.brain.battle.resetKeepOrbit();
    this.strategy.onLifeLost();
  }

  // -----------------------------------------------------------------------
  // Movement helpers
  // -----------------------------------------------------------------------

  /** Move a tile cursor one step toward (targetRow, targetCol).
   *  Moves one axis at a time (like arrow keys) with slight perpendicular jitter.
   *  NOTE: AI uses tile-step movement (Manhattan, one axis at a time with jitter).
   *  Human uses pixel-velocity movement (Cartesian, all-axis simultaneous).
   *  Do NOT copy between controller-ai.ts and controller-human.ts. */
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean {
    const dr = targetRow - cursor.row;
    const dc = targetCol - cursor.col;
    const dist = Math.abs(dr) + Math.abs(dc);
    if (dist < TILE_ARRIVAL_TOLERANCE) {
      cursor.row = targetRow;
      cursor.col = targetCol;
      return true;
    }
    const speed = baseSpeed * (dist > boostThreshold ? 2 : 1);
    let remaining = speed * SIM_TICK_DT;

    // Randomize axis priority and jitter offset when starting a new movement
    if (Math.abs(dr) > 0.5 && Math.abs(dc) > 0.5) {
      this.tileMoveRowFirst = this.strategy.rng.bool(0.5);
      this.tileJitterOffset =
        (this.strategy.rng.next() - 0.5) * JITTER_MAX_AMPLITUDE;
    }
    const axis = this.tileMoveRowFirst
      ? ({
          primary: "row",
          secondary: "col",
          primaryDelta: dr,
          secondaryDelta: dc,
          secondaryTarget: targetCol,
        } as const)
      : ({
          primary: "col",
          secondary: "row",
          primaryDelta: dc,
          secondaryDelta: dr,
          secondaryTarget: targetRow,
        } as const);

    if (Math.abs(axis.primaryDelta) > 0.01) {
      const move = Math.min(remaining, Math.abs(axis.primaryDelta));
      cursor[axis.primary] += Math.sign(axis.primaryDelta) * move;
      remaining -= move;
      // Nudge toward fixed jitter offset on perpendicular axis (decays near target)
      if (Math.abs(axis.secondaryDelta) > 1) {
        const perpTarget = axis.secondaryTarget + this.tileJitterOffset;
        const perpCurrent = cursor[axis.secondary];
        const nudge =
          (perpTarget - perpCurrent) *
          Math.min(1, JITTER_DECAY_RATE * SIM_TICK_DT);
        cursor[axis.secondary] += nudge;
      }
    }
    // Move secondary axis with leftover step
    if (remaining > 0.01 && Math.abs(axis.secondaryDelta) > 0.01) {
      const move = Math.min(remaining, Math.abs(axis.secondaryDelta));
      cursor[axis.secondary] += Math.sign(axis.secondaryDelta) * move;
    }
    return false;
  }

  /** Move crosshair one step toward (tx, ty) at battle speed. */
  stepCrosshairToward(tx: PixelPos["x"], ty: PixelPos["y"]): boolean {
    const dx = tx - this.crosshair.x;
    const dy = ty - this.crosshair.y;
    const fraction = moveStepFraction(
      Math.sqrt(dx * dx + dy * dy),
      CROSSHAIR_SPEED,
      this.battleBoostDist,
    );
    if (fraction >= 1) {
      this.crosshair.x = tx;
      this.crosshair.y = ty;
      return true;
    }
    this.crosshair.x += dx * fraction;
    this.crosshair.y += dy * fraction;
    return false;
  }
}

/** Compute interpolation fraction for one movement step. Returns 1 if arrived. */
function moveStepFraction(
  dist: number,
  baseSpeed: number,
  boostThreshold: number,
): number {
  if (dist <= 0) return 1;
  const step = baseSpeed * (dist > boostThreshold ? 2 : 1) * SIM_TICK_DT;
  return step >= dist ? 1 : step / dist;
}

void _assertAiControllerSatisfiesAllHosts;
