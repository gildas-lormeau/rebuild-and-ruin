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

import { STEP } from "./ai-constants.ts";
import {
  createBattlePhase,
  initBattle,
  resetBattlePhase,
  tickBattle,
} from "./ai-phase-battle.ts";
import {
  BUILD_CURSOR_SPEEDS,
  createBuildPhase,
  finalizeBuild,
  initBuild,
  resetBuildPhase,
  tickBuild,
} from "./ai-phase-build.ts";
import {
  CANNON_CURSOR_SPEEDS,
  createCannonPhase,
  flushCannon,
  initCannon,
  isCannonDone,
  resetCannonPhase,
  tickCannon,
} from "./ai-phase-cannon.ts";
import {
  createSelectionPhase,
  initSelection,
  resetSelectionPhase,
  tickSelection,
} from "./ai-phase-select.ts";
import { type AiStrategy, DefaultStrategy } from "./ai-strategy.ts";
import type {
  AiAnimatable,
  CannonPlacementPreview,
  OrbitParams,
  PiecePlacementPreview,
} from "./controller-interfaces.ts";
import { CROSSHAIR_SPEED } from "./controller-interfaces.ts";
import { BaseController } from "./controller-types.ts";
import type { PixelPos, TilePos } from "./geometry-types.ts";
import type { GameState } from "./types.ts";

export class AiController extends BaseController implements AiAnimatable {
  override readonly kind = "ai" as const;
  /** Pluggable AI strategy (decision-making). */
  readonly strategy: AiStrategy;

  // --- Phase state holders ---
  private readonly selectionPhase = createSelectionPhase();
  private readonly _buildPhase = createBuildPhase();
  private readonly _cannonPhase = createCannonPhase();
  private readonly _battlePhase = createBattlePhase();

  // --- Movement state (used by stepTileCursorToward) ---
  /** Which axis to move first — randomized when a new target is set. */
  private tileMoveRowFirst = true;
  /** Fixed perpendicular jitter offset (tiles), set once per movement. */
  private tileJitterOffset = 0;

  constructor(playerId: number, strategy?: AiStrategy) {
    super(playerId);
    this.strategy = strategy ?? new DefaultStrategy();
    this._battlePhase.idlePhase = this.strategy.rng.next() * Math.PI * 2;
  }

  // -----------------------------------------------------------------------
  // AiAnimatable interface
  // -----------------------------------------------------------------------

  getCrosshairTarget(): PixelPos | null {
    return this._battlePhase.crosshairTarget;
  }

  getOrbitParams(): OrbitParams | null {
    const bp = this._battlePhase;
    if (bp.state.step === STEP.COUNTDOWN && bp.state.orbit) {
      const orbit = bp.state.orbit;
      return {
        rx: orbit.rx,
        ry: orbit.ry,
        speed: orbit.speed,
        phase: bp.idlePhase,
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

  scaledDelay(base: number, spread: number): number {
    return (base + this.strategy.rng.next() * spread) * this.delayScale;
  }

  // -----------------------------------------------------------------------
  // Selection phase
  // -----------------------------------------------------------------------

  override selectTower(state: GameState, zone: number): void {
    initSelection(this, this.selectionPhase, state, zone);
  }

  override selectionTick(dt: number, state?: GameState): boolean {
    return tickSelection(this, this.selectionPhase, dt, state);
  }

  override reselect(state: GameState, zone: number): void {
    initSelection(this, this.selectionPhase, state, zone);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  protected override onStartBuild(state: GameState): void {
    initBuild(this, this._buildPhase, state);
  }

  buildTick(state: GameState, dt: number): PiecePlacementPreview[] {
    return tickBuild(this, this._buildPhase, state, dt);
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

  cannonTick(state: GameState, dt: number): CannonPlacementPreview | null {
    return tickCannon(this, this._cannonPhase, state, dt);
  }

  flushCannons(state: GameState, maxSlots: number): void {
    flushCannon(this._cannonPhase, state, this.playerId, maxSlots);
  }

  // -----------------------------------------------------------------------
  // Battle phase
  // -----------------------------------------------------------------------

  protected override onResetBattle(state?: GameState): void {
    initBattle(this, this._battlePhase, state);
  }

  battleTick(state: GameState, dt: number): void {
    tickBattle(this, this._battlePhase, state, dt);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override onLifeLost(): void {
    super.onLifeLost();
    resetSelectionPhase(this.selectionPhase);
    resetBuildPhase(this._buildPhase);
    resetCannonPhase(this._cannonPhase);
    resetBattlePhase(this._battlePhase);
    this.strategy.onLifeLost();
  }

  endBattle(): void {}

  override reset(): void {
    super.reset();
    resetSelectionPhase(this.selectionPhase);
    resetBuildPhase(this._buildPhase);
    resetCannonPhase(this._cannonPhase);
    resetBattlePhase(this._battlePhase);
    this.strategy.onLifeLost();
  }

  onCannonPhaseStart(): void {}

  // -----------------------------------------------------------------------
  // Movement helpers
  // -----------------------------------------------------------------------

  /** Move a tile cursor one step toward (targetRow, targetCol).
   *  Moves one axis at a time (like arrow keys) with slight perpendicular jitter. */
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
    dt: number,
  ): boolean {
    const dr = targetRow - cursor.row;
    const dc = targetCol - cursor.col;
    const dist = Math.abs(dr) + Math.abs(dc);
    if (dist < 0.05) {
      cursor.row = targetRow;
      cursor.col = targetCol;
      return true;
    }
    const speed = baseSpeed * (dist > boostThreshold ? 2 : 1);
    let remaining = speed * dt;

    // Randomize axis priority and jitter offset when starting a new movement
    if (Math.abs(dr) > 0.5 && Math.abs(dc) > 0.5) {
      this.tileMoveRowFirst = this.strategy.rng.bool(0.5);
      this.tileJitterOffset = (this.strategy.rng.next() - 0.5) * 0.6;
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
        const nudge = (perpTarget - perpCurrent) * Math.min(1, 4 * dt);
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
  stepCrosshairToward(
    tx: PixelPos["x"],
    ty: PixelPos["y"],
    dt: number,
  ): boolean {
    const dx = tx - this.crosshair.x;
    const dy = ty - this.crosshair.y;
    const fraction = moveStepFraction(
      Math.sqrt(dx * dx + dy * dy),
      CROSSHAIR_SPEED,
      this.battleBoostDist,
      dt,
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
  dt: number,
): number {
  if (dist <= 0) return 1;
  const step = baseSpeed * (dist > boostThreshold ? 2 : 1) * dt;
  return step >= dist ? 1 : step / dist;
}
