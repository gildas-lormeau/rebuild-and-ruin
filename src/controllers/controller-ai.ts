/**
 * AiController — thin dispatcher that delegates each game phase to its
 * dedicated state-machine module (ai-phase-*.ts).
 *
 * Owns movement helpers, trait-derived getters, and lifecycle hooks.
 * The per-phase logic (types, constants, tick functions) lives in:
 *   ai-phase-select.ts  — tower browsing & confirmation
 *   ai-phase-build.ts   — piece placement with cursor animation
 *   ai-phase-cannon.ts  — cannon placement with mode switching
 *   ai-phase-battle.ts  — targeting, chain attacks, orbit & fire
 */

import { STEP, secondsToTicks } from "../ai/ai-constants.ts";
import { aiChooseLifeLost } from "../ai/ai-life-lost.ts";
import {
  type BattleHost,
  createBattlePhase,
  initBattle,
  resetBattlePhaseKeepOrbit,
  tickBattle,
} from "../ai/ai-phase-battle.ts";
import {
  BUILD_CURSOR_SPEEDS,
  type BuildHost,
  createBuildPhase,
  finalizeBuild,
  initBuild,
  resetBuildPhase,
  tickBuild,
} from "../ai/ai-phase-build.ts";
import {
  CANNON_CURSOR_SPEEDS,
  type CannonHost,
  createCannonPhase,
  flushCannon,
  initCannon,
  isCannonDone,
  resetCannonPhase,
  tickCannon,
} from "../ai/ai-phase-cannon.ts";
import {
  createSelectionPhase,
  initSelection,
  resetSelectionPhase,
  type SelectionHost,
  tickSelection,
} from "../ai/ai-phase-select.ts";
import { type AiStrategy, DefaultStrategy } from "../ai/ai-strategy.ts";
import { tickAiUpgradePickEntry } from "../ai/ai-upgrade-pick.ts";
import {
  executePlaceCannon,
  executePlacePiece,
  fireNextReadyCannon,
} from "../game/index.ts";
import { SIM_TICK_DT } from "../shared/core/game-constants.ts";
import type { PixelPos, TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  type AiAnimatable,
  type CannonPlacementPreview,
  CROSSHAIR_SPEED,
  type FireIntent,
  type OrbitParams,
  type PiecePlacementPreview,
  type PlaceCannonIntent,
  type PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  LifeLostChoice,
  type LifeLostEntry,
  type UpgradePickEntry,
} from "../shared/ui/interaction-types.ts";
import { BaseController } from "./controller-types.ts";

// Compile-time guarantee: AiController structurally satisfies every phase
// module's Host interface. Adding a required field/method to any Host without
// implementing it on AiController — or renaming a field that a Host depends on
// — breaks this assertion at the class declaration site, not at downstream
// tick() call sites. See each ai-phase-*.ts file for the Host definitions.
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

  // --- Phase state holders ---
  protected readonly selectionPhase = createSelectionPhase();
  protected readonly _buildPhase = createBuildPhase();
  protected readonly _cannonPhase = createCannonPhase();
  protected readonly _battlePhase = createBattlePhase();

  // --- Movement state (used by stepTileCursorToward) ---
  /** Which axis to move first — randomized when a new target is set. */
  private tileMoveRowFirst = true;
  /** Fixed perpendicular jitter offset (tiles), set once per movement. */
  private tileJitterOffset = 0;

  constructor(playerId: ValidPlayerSlot, strategy?: AiStrategy) {
    super(playerId);
    this.strategy = strategy ?? new DefaultStrategy();
    this._battlePhase.orbitAngle = this.strategy.rng.next() * Math.PI * 2;
  }

  // -----------------------------------------------------------------------
  // AiAnimatable interface
  // -----------------------------------------------------------------------

  getCrosshairTarget(): PixelPos | null {
    return this._battlePhase.crosshairTarget;
  }

  getOrbitParams(): OrbitParams | null {
    const battlePhase = this._battlePhase;
    if (battlePhase.state.step === STEP.COUNTDOWN && battlePhase.state.orbit) {
      const orbit = battlePhase.state.orbit;
      return {
        rx: orbit.rx,
        ry: orbit.ry,
        speed: orbit.speed,
        phaseAngle: battlePhase.orbitAngle,
      };
    }
    return null;
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
    return BUILD_CURSOR_SPEEDS[this.strategy.cursorSkill - 1]!;
  }

  /** Cannon cursor speed scaled by cursorSkill. */
  get cannonCursorSpeed(): number {
    return CANNON_CURSOR_SPEEDS[this.strategy.cursorSkill - 1]!;
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

  override selectInitialTower(state: GameState, zone: number): void {
    initSelection(this, this.selectionPhase, state, zone);
  }

  override selectionTick(_dt: number, state?: GameState): boolean {
    return tickSelection(this, this.selectionPhase, state);
  }

  override selectReplacementTower(state: GameState, zone: number): void {
    initSelection(this, this.selectionPhase, state, zone);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  protected override onStartBuildPhase(state: GameState): void {
    initBuild(this, this._buildPhase, state);
  }

  buildTick(state: GameState, _dt: number): PiecePlacementPreview[] {
    const executePlace = (intent: PlacePieceIntent): boolean =>
      executePlacePiece(state, intent, this);
    return tickBuild(this, this._buildPhase, state, executePlace);
  }

  protected override onFinalizeBuildPhase(state: GameState): void {
    finalizeBuild(this, this._buildPhase, state);
  }

  // -----------------------------------------------------------------------
  // Cannon phase
  // -----------------------------------------------------------------------

  override placeCannons(state: GameState, maxSlots: number): void {
    initCannon(this, this._cannonPhase, state, maxSlots);
  }

  override isCannonPhaseDone(_state: GameState, _maxSlots: number): boolean {
    return isCannonDone(this._cannonPhase);
  }

  cannonTick(state: GameState, _dt: number): CannonPlacementPreview | null {
    const executePlace = (intent: PlaceCannonIntent): boolean =>
      executePlaceCannon(state, intent, this._cannonPhase.maxSlots);
    return tickCannon(this, this._cannonPhase, state, executePlace);
  }

  flushCannons(state: GameState, maxSlots: number): void {
    const executePlace = (intent: PlaceCannonIntent): boolean =>
      executePlaceCannon(state, intent, maxSlots);
    flushCannon(this._cannonPhase, this.playerId, executePlace);
  }

  // -----------------------------------------------------------------------
  // Battle phase
  // -----------------------------------------------------------------------

  protected override onResetBattle(state?: GameState): void {
    initBattle(this, this._battlePhase, state);
  }

  battleTick(state: GameState, _dt: number): void {
    const executeFire = (intent: FireIntent): boolean => {
      const fired = fireNextReadyCannon(
        state,
        intent.playerId,
        this.cannonRotationIdx,
        intent.targetRow,
        intent.targetCol,
      );
      if (!fired) return false;
      this.cannonRotationIdx = fired.rotationIdx;
      return true;
    };
    tickBattle(this, this._battlePhase, state, executeFire);
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
    state: GameState,
  ): void {
    tickAiUpgradePickEntry(
      entry,
      entryIdx,
      secondsToTicks(autoDelaySeconds),
      dialogTimer,
      state,
    );
  }

  // -----------------------------------------------------------------------
  // Life-lost dialog (auto-resolve via aiChooseLifeLost)
  // -----------------------------------------------------------------------

  override autoResolvesLifeLost(): boolean {
    return true;
  }

  override tickLifeLost(
    entry: LifeLostEntry,
    dt: number,
    autoDelaySeconds: number,
    state: GameState,
  ): void {
    if (entry.choice !== LifeLostChoice.PENDING) return;
    entry.autoTimer += dt;
    if (entry.autoTimer >= autoDelaySeconds) {
      entry.choice = aiChooseLifeLost(entry, state);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override onLifeLost(): void {
    super.onLifeLost();
    resetSelectionPhase(this.selectionPhase);
    resetBuildPhase(this._buildPhase);
    resetCannonPhase(this._cannonPhase);
    resetBattlePhaseKeepOrbit(this._battlePhase);
    this.strategy.onLifeLost();
  }

  override reset(): void {
    super.reset();
    resetSelectionPhase(this.selectionPhase);
    resetBuildPhase(this._buildPhase);
    resetCannonPhase(this._cannonPhase);
    resetBattlePhaseKeepOrbit(this._battlePhase);
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
    const rowFirst = this.tileMoveRowFirst;
    const d1 = rowFirst ? dr : dc;
    const d2 = rowFirst ? dc : dr;

    if (Math.abs(d1) > 0.01) {
      const move = Math.min(remaining, Math.abs(d1));
      if (rowFirst) cursor.row += Math.sign(d1) * move;
      else cursor.col += Math.sign(d1) * move;
      remaining -= move;
      // Nudge toward fixed jitter offset on perpendicular axis (decays near target)
      if (Math.abs(d2) > 1) {
        const perpTarget =
          (rowFirst ? targetCol : targetRow) + this.tileJitterOffset;
        const perpCurrent = rowFirst ? cursor.col : cursor.row;
        const nudge =
          (perpTarget - perpCurrent) *
          Math.min(1, JITTER_DECAY_RATE * SIM_TICK_DT);
        if (rowFirst) cursor.col += nudge;
        else cursor.row += nudge;
      }
    }
    // Move secondary axis with leftover step
    if (remaining > 0.01 && Math.abs(d2) > 0.01) {
      const move = Math.min(remaining, Math.abs(d2));
      if (rowFirst) cursor.col += Math.sign(d2) * move;
      else cursor.row += Math.sign(d2) * move;
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
