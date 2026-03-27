/**
 * AiController — AI player behavior: tower selection, piece placement,
 * cannon placement, and battle targeting via pluggable strategy.
 *
 * State machines use discriminated unions so each phase's valid fields
 * are scoped to the active state variant — no implicit timer checks.
 */

import type { AiStrategy, ChainType } from "./ai-strategy.ts";
import {
  Chain,
  DefaultStrategy,
} from "./ai-strategy.ts";
import {
  aimCannons,
  nextReadyCombined,
} from "./battle-system.ts";
import { placePiece } from "./build-system.ts";
import {
  canPlaceCannon,
  placeCannon,
} from "./cannon-system.ts";
import {
  type AiAnimatable,
  CROSSHAIR_SPEED,
  type OrbitParams,
  type PhantomCannon,
  type PhantomPiece,
} from "./controller-interfaces.ts";
import { BaseController } from "./controller-types.ts";
import type {
  PixelPos,
  StrategicPixelPos,
  TilePos,
} from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { type PieceShape, rotateCW } from "./pieces.ts";
import { packTile, tileCenterPx, towerCenter } from "./spatial.ts";
import { CannonMode, type GameState, type Player } from "./types.ts";

/** Placement target with piece and position. */
type BuildTarget = { piece: PieceShape } & TilePos;

/** Rotation animation running concurrently with cursor movement. */
type BuildRotation = { seq: PieceShape[]; idx: number; timer: number };

/** Pre-battle idle orbit parameters (randomized once per countdown). */
type IdleOrbit = { rx: number; ry: number; speed: number };

type SelectionState =
  | { step: typeof Step.IDLE }
  | { step: typeof Step.BROWSING; queue: number[]; dwell: number; confirmDelay: number }
  | { step: typeof Step.CONFIRMING; timer: number };

type BuildState =
  | { step: typeof Step.IDLE }
  | { step: typeof Step.THINKING; timer: number }
  | { step: typeof Step.MOVING; target: BuildTarget; rotation: BuildRotation }
  | { step: typeof Step.DWELLING; target: BuildTarget; timer: number; retried: boolean }
  | { step: typeof Step.GAVE_UP; retryTimer: number };

type CannonState =
  | { step: typeof Step.IDLE }
  | { step: typeof Step.THINKING; timer: number }
  | { step: typeof Step.MODE_SWITCHING; timer: number }
  | { step: typeof Step.MOVING }
  | { step: typeof Step.DWELLING; timer: number };

type BattleState =
  | { step: typeof Step.IDLE }
  | { step: typeof Step.COUNTDOWN; orbit: IdleOrbit | null }
  | { step: typeof Step.CHAIN_MOVING }
  | { step: typeof Step.CHAIN_DWELLING; timer: number }
  | { step: typeof Step.THINKING; timer: number }
  | { step: typeof Step.PICKING }
  | { step: typeof Step.MOVING }
  | { step: typeof Step.DWELLING; timer: number };

/** Shared step discriminant values for all AI state machines. */
const Step = {
  IDLE: "idle",
  BROWSING: "browsing",
  CONFIRMING: "confirming",
  THINKING: "thinking",
  MOVING: "moving",
  DWELLING: "dwelling",
  GAVE_UP: "gave_up",
  MODE_SWITCHING: "mode_switching",
  COUNTDOWN: "countdown",
  CHAIN_MOVING: "chain_moving",
  CHAIN_DWELLING: "chain_dwelling",
  PICKING: "picking",
} as const;
/** AI build-phase cursor speed in tiles per second. */
const BUILD_CURSOR_SPEED = 12;
/** AI cannon-phase cursor speed in tiles per second. */
const CANNON_CURSOR_SPEED = 6;
/** Pixel distance at which countdown orbit engages (stop approaching, start circling). */
const ORBIT_ENGAGEMENT_DISTANCE = 12;
/** Base orbit angular speed (rad/s) when targeting a strategic tile. */
const ORBIT_SPEED_STRATEGIC_BASE = 5.5;
/** Base orbit angular speed (rad/s) for default targets. */
const ORBIT_SPEED_DEFAULT_BASE = 4.5;
/** Random variation added to orbit angular speed. */
const ORBIT_SPEED_RANGE = 1.5;
/** Base orbit ellipse radius (pixels). */
const ORBIT_RADIUS_BASE = 5;
/** Random variation added to orbit radius. */
const ORBIT_RADIUS_RANGE = 3;
/** Base delay (seconds) per rotation animation frame. */
const ROTATION_FRAME_BASE = 0.12;
/** Random variation added to each rotation frame delay. */
const ROTATION_FRAME_RANGE = 0.08;
/** Base delay (seconds) before the first rotation frame starts. */
const ROTATION_INITIAL_BASE = 0.15;
/** Random variation added to the initial rotation delay. */
const ROTATION_INITIAL_RANGE = 0.1;

export class AiController extends BaseController implements AiAnimatable {
  /** Pluggable AI strategy (decision-making). */
  private strategy: AiStrategy;

  // --- State machines (one per game phase) ---
  private selectionState: SelectionState = { step: Step.IDLE };
  private buildState: BuildState = { step: Step.IDLE };
  private cannonState: CannonState = { step: Step.IDLE };
  private battleState: BattleState = { step: Step.IDLE };

  // --- Cannon peer fields (shared across cannon states) ---
  private cannonQueue: { row: number; col: number; mode?: CannonMode.SUPER | CannonMode.BALLOON }[] = [];
  private cannonMaxSlots = 0;
  private displayedCannonMode: CannonMode.SUPER | CannonMode.BALLOON | undefined;

  // --- Battle peer fields (shared across battle states) ---
  private crosshairTarget: StrategicPixelPos | null = null;
  private chainTargets: TilePos[] | null = null;
  private chainIdx = 0;
  private chainType: ChainType = Chain.WALL;
  /** Persistent orbit phase — accumulated across battles for natural variation. */
  private idlePhase = 0;

  getCrosshairTarget(): PixelPos | null { return this.crosshairTarget; }
  getOrbitParams(): OrbitParams | null {
    if (this.battleState.step === Step.COUNTDOWN && this.battleState.orbit) {
      const o = this.battleState.orbit;
      return { rx: o.rx, ry: o.ry, speed: o.speed, phase: this.idlePhase };
    }
    return null;
  }

  /** When true, castle rects hug the river bank (plug approach).
   *  When false (default), rects shrink at bank corners (tighter ring). */
  get bankHugging(): boolean { return this.strategy.bankHugging; }
  set bankHugging(v: boolean) { this.strategy.bankHugging = v; }

  /** Delay multiplier derived from thinkingSpeed: 1=slow(1.4×), 2=normal(1×), 3=fast(0.65×). */
  private get delayScale(): number {
    return [1.4, 1.0, 0.65][this.strategy.thinkingSpeed - 1]!;
  }

  /** Distance threshold (tiles) below which the cursor uses 1× instead of 2× speed.
   *  cursorSkill 1=8 (rarely boosts), 2=5 (default), 3=3 (boosts early). */
  private get boostThreshold(): number {
    return [8, 5, 3][this.strategy.cursorSkill - 1]!;
  }

  /** Battle boost threshold in pixels.
   *  cursorSkill 1=never boosts (Infinity), 2=always (0, default), 3=always (0). */
  private get battleBoostDist(): number {
    // Level 1: no 2× speed boost (always 1×). Levels 2–3: always 2× (threshold 0).
    return this.strategy.cursorSkill === 1 ? Infinity : 0;
  }

  /** Whether the AI pre-picks next target while firing (cursorSkill >= 2). */
  private get anticipatesTarget(): boolean {
    return this.strategy.cursorSkill >= 2;
  }

  private scaledDelay(base: number, spread: number): number {
    return (base + this.strategy.rng.next() * spread) * this.delayScale;
  }

  constructor(playerId: number, strategy?: AiStrategy) {
    super(playerId);
    this.strategy = strategy ?? new DefaultStrategy();
    this.idlePhase = this.strategy.rng.next() * Math.PI * 2;
  }

  // -----------------------------------------------------------------------
  // Selection phase
  // -----------------------------------------------------------------------

  override selectTower(state: GameState, zone: number): boolean {
    const player = state.players[this.playerId]!;
    const chosenTower = this.strategy.selectTower(state.map, zone);

    // Build browse queue: visit 1-3 random zone towers before the chosen one
    const zoneTowers = state.map.towers.filter(t => t.zone === zone);
    const others = zoneTowers.filter(t => t !== chosenTower);
    const browseCount = Math.min(others.length, 1 + Math.floor(this.strategy.rng.next() * 3));
    // Shuffle and take browseCount
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(this.strategy.rng.next() * (i + 1));
      [others[i], others[j]] = [others[j]!, others[i]!];
    }
    const queue = others.slice(0, browseCount).map(t => t.index);
    if (chosenTower) queue.push(chosenTower.index);

    this.selectionState = {
      step: Step.BROWSING,
      queue,
      dwell: this.scaledDelay(0.8, 0.6),
      confirmDelay: this.scaledDelay(1.0, 0.6),
    };

    // Start at first tower in browse queue
    const firstIdx = queue[0];
    const firstTower = firstIdx !== undefined ? state.map.towers[firstIdx] : chosenTower;
    if (firstTower) {
      player.homeTower = firstTower;
      player.ownedTowers = [firstTower];
    }
    return false;
  }

  override selectionTick(dt: number, state?: GameState): boolean {
    switch (this.selectionState.step) {
      case Step.IDLE: return false;
      case Step.BROWSING: {
        const s = this.selectionState;
        s.dwell -= dt;
        if (s.dwell <= 0 && s.queue.length > 1) {
          s.queue.shift();
          s.dwell = this.scaledDelay(0.8, 0.6);
          if (state) {
            const nextIdx = s.queue[0];
            const nextTower = nextIdx !== undefined ? state.map.towers[nextIdx] : undefined;
            if (nextTower) {
              state.players[this.playerId]!.homeTower = nextTower;
              state.players[this.playerId]!.ownedTowers = [nextTower];
            }
          }
          return false;
        }
        if (s.queue.length <= 1) {
          this.selectionState = { step: Step.CONFIRMING, timer: s.confirmDelay };
        }
        return false;
      }
      case Step.CONFIRMING: {
        this.selectionState.timer -= dt;
        return this.selectionState.timer <= 0;
      }
    }
  }

  override reselect(state: GameState, zone: number): boolean {
    return this.selectTower(state, zone);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  startBuild(state: GameState): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    this.initBuildPhase(state);
    const target = this.computeNextPlacement(state);
    if (target) {
      this.buildState = { step: Step.MOVING, target, rotation: this.buildRotationFor(target) };
    } else {
      // Will compute on first tick
      this.buildState = { step: Step.THINKING, timer: 0 };
    }
  }

  buildTick(state: GameState, dt: number): PhantomPiece[] {
    if (!this.currentPiece) return [];
    const player = state.players[this.playerId]!;
    if (player.eliminated) return [];

    // Clamp cursor so phantom never extends beyond the grid
    const clampPiece = (this.buildState.step === Step.MOVING || this.buildState.step === Step.DWELLING)
      ? this.buildState.target.piece
      : this.currentPiece;
    this.clampBuildCursor(clampPiece);

    switch (this.buildState.step) {
      case Step.IDLE: return [];

      case Step.THINKING: {
        const s = this.buildState;
        if (s.timer > 0) {
          s.timer -= dt;
          return [this.phantomAtCursor()];
        }
        // Timer expired — compute next placement
        const target = this.computeNextPlacement(state);
        if (target) {
          this.buildState = { step: Step.MOVING, target, rotation: this.buildRotationFor(target) };
          return this.buildTickMoving(dt);
        }
        if (state.timer > 2) {
          this.buildState = { step: Step.THINKING, timer: 1.0 };
        } else {
          this.buildState = { step: Step.GAVE_UP, retryTimer: 1.0 };
        }
        return [this.phantomAtCursor()];
      }

      case Step.GAVE_UP: {
        const s = this.buildState;
        const home = player.homeTower ? towerCenter(player.homeTower) : this.buildCursor;
        this.stepTileCursorToward(
          this.buildCursor, Math.round(home.row), Math.round(home.col),
          BUILD_CURSOR_SPEED, Infinity, dt,
        );
        s.retryTimer -= dt;
        if (s.retryTimer <= 0) {
          const target = this.computeNextPlacement(state);
          if (target) {
            this.buildState = { step: Step.MOVING, target, rotation: this.buildRotationFor(target) };
          } else {
            s.retryTimer = 1.0;
          }
        }
        return [this.phantomAtCursor()];
      }

      case Step.MOVING:
        return this.buildTickMoving(dt);

      case Step.DWELLING: {
        const s = this.buildState;
        s.timer -= dt;
        if (s.timer <= 0) {
          const placed = placePiece(state, this.playerId, s.target.piece, s.target.row, s.target.col);
          if (placed) {
            this.advanceBag();
            this.buildState = { step: Step.THINKING, timer: this.scaledDelay(0.3, 0.4) };
            return [];
          }
          // Placement blocked (e.g. grunt moved onto target)
          if (!s.retried) {
            s.retried = true;
            s.timer = 1.0;
          } else {
            this.buildState = { step: Step.THINKING, timer: 0.1 };
          }
          return [];
        }
        return [this.makePhantom(s.target.piece, s.target.row, s.target.col, true)];
      }
    }
  }

  /** Handle "moving toward target" state with concurrent rotation animation. */
  private buildTickMoving(dt: number): PhantomPiece[] {
    const s = this.buildState as Extract<BuildState, { step: typeof Step.MOVING }>;
    const { target, rotation } = s;

    // Tick rotation animation concurrently with movement
    if (rotation.idx < rotation.seq.length) {
      rotation.timer -= dt;
      if (rotation.timer <= 0) {
        rotation.idx++;
        if (rotation.idx < rotation.seq.length) {
          rotation.timer = ROTATION_FRAME_BASE + this.strategy.rng.next() * ROTATION_FRAME_RANGE;
        }
      }
    }

    // Move cursor toward target
    const arrived = this.stepTileCursorToward(
      this.buildCursor, target.row, target.col, BUILD_CURSOR_SPEED, this.boostThreshold, dt,
    );
    if (arrived && rotation.idx >= rotation.seq.length) {
      this.buildState = { step: Step.DWELLING, target, timer: this.scaledDelay(0.2, 0.3), retried: false };
    }

    // Show phantom at current cursor position — use current rotation frame
    const movingPiece = rotation.idx < rotation.seq.length
      ? rotation.seq[Math.min(rotation.idx, rotation.seq.length - 1)]!
      : target.piece;
    const pivotDr = target.piece.pivot[0] - movingPiece.pivot[0];
    const pivotDc = target.piece.pivot[1] - movingPiece.pivot[1];
    const curRow = Math.max(0, Math.min(Math.round(this.buildCursor.row) + pivotDr, GRID_ROWS - movingPiece.height));
    const curCol = Math.max(0, Math.min(Math.round(this.buildCursor.col) + pivotDc, GRID_COLS - movingPiece.width));
    return [this.makePhantom(movingPiece, curRow, curCol, curRow === target.row && curCol === target.col)];
  }

  /** Build rotation animation sequence from current bag piece to target orientation. */
  private buildRotationFor(target: BuildTarget): BuildRotation {
    const bag = this.currentPiece!;
    if (sameShape(bag, target.piece)) {
      return { seq: [], idx: 0, timer: 0 };
    }
    const seq: PieceShape[] = [bag];
    let cur = bag;
    for (let i = 0; i < 3; i++) {
      cur = rotateCW(cur);
      if (sameShape(cur, target.piece)) {
        seq.push(target.piece);
        break;
      }
      seq.push(cur);
    }
    return { seq, idx: 0, timer: ROTATION_INITIAL_BASE + this.strategy.rng.next() * ROTATION_INITIAL_RANGE };
  }

  override endBuild(state: GameState): void {
    super.endBuild(state);
    this.buildState = { step: Step.IDLE };
    this.strategy.assessBuildEnd(state, this.playerId);
  }

  // -----------------------------------------------------------------------
  // Cannon phase
  // -----------------------------------------------------------------------

  override placeCannons(state: GameState, maxSlots: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    this.cannonQueue = this.strategy.placeCannons(player, maxSlots, state);
    this.cannonMaxSlots = maxSlots;
    this.displayedCannonMode = undefined;
    this.cannonState = { step: Step.THINKING, timer: this.scaledDelay(0.3, 0.4) };
  }

  override isCannonPhaseDone(_state: GameState, _maxSlots: number): boolean {
    return this.cannonQueue.length === 0 && this.cannonState.step === Step.IDLE;
  }

  cannonTick(state: GameState, dt: number): PhantomCannon | null {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return null;

    switch (this.cannonState.step) {
      case Step.IDLE: return null;

      case Step.THINKING: {
        this.cannonState.timer -= dt;
        if (this.cannonState.timer > 0) return null;
        if (this.cannonQueue.length === 0) {
          this.cannonState = { step: Step.IDLE };
          return null;
        }
        // Check if mode switch is needed
        const target = this.cannonQueue[0]!;
        if (target.mode !== this.displayedCannonMode) {
          this.displayedCannonMode = target.mode;
          this.cannonState = {
            step: Step.MODE_SWITCHING,
            timer: (0.25 + this.strategy.rng.next() * 0.2) * this.delayScale,
          };
          return this.cannonPhantomAt(Math.round(this.cannonCursor.row), Math.round(this.cannonCursor.col), false, player);
        }
        this.cannonState = { step: Step.MOVING };
        return this.cannonTickMoving(state, player, dt);
      }

      case Step.MODE_SWITCHING: {
        this.cannonState.timer -= dt;
        if (this.cannonState.timer <= 0) {
          this.cannonState = { step: Step.MOVING };
        }
        return this.cannonPhantomAt(Math.round(this.cannonCursor.row), Math.round(this.cannonCursor.col), false, player);
      }

      case Step.MOVING:
        return this.cannonTickMoving(state, player, dt);

      case Step.DWELLING: {
        this.cannonState.timer -= dt;
        if (this.cannonState.timer <= 0) {
          const target = this.cannonQueue[0]!;
          const targetMode = target.mode ?? CannonMode.NORMAL;
          if (canPlaceCannon(player, target.row, target.col, targetMode, state)) {
            placeCannon(player, target.row, target.col, this.cannonMaxSlots, targetMode, state);
          }
          this.cannonQueue.shift();
          this.cannonState = { step: Step.THINKING, timer: this.scaledDelay(0.3, 0.4) };
          return null;
        }
        const target = this.cannonQueue[0]!;
        return this.cannonPhantomAt(target.row, target.col, true, player);
      }
    }
  }

  private cannonTickMoving(state: GameState, player: Player, dt: number): PhantomCannon | null {
    const target = this.cannonQueue[0]!;
    const targetMode = target.mode ?? CannonMode.NORMAL;
    if (this.stepTileCursorToward(
      this.cannonCursor, target.row, target.col, CANNON_CURSOR_SPEED, this.boostThreshold, dt,
    )) {
      this.cannonState = { step: Step.DWELLING, timer: this.scaledDelay(0.2, 0.3) };
    }
    const curRow = Math.round(this.cannonCursor.row);
    const curCol = Math.round(this.cannonCursor.col);
    const atTarget = curRow === target.row && curCol === target.col;
    return {
      row: curRow, col: curCol,
      valid: atTarget && canPlaceCannon(player, curRow, curCol, targetMode, state),
      kind: targetMode, playerId: this.playerId, facing: player.defaultFacing,
    };
  }

  private cannonPhantomAt(row: number, col: number, valid: boolean, player: Player): PhantomCannon {
    const target = this.cannonQueue[0]!;
    const targetMode = target.mode ?? CannonMode.NORMAL;
    return {
      row, col, valid, kind: targetMode,
      playerId: this.playerId, facing: player.defaultFacing,
    };
  }

  flushCannons(state: GameState, maxSlots: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    for (const target of this.cannonQueue) {
      const mode = target.mode ?? CannonMode.NORMAL;
      if (canPlaceCannon(player, target.row, target.col, mode, state)) {
        placeCannon(player, target.row, target.col, maxSlots, mode, state);
      }
    }
    this.cannonQueue = [];
    this.cannonState = { step: Step.IDLE };
  }

  // -----------------------------------------------------------------------
  // Battle phase
  // -----------------------------------------------------------------------

  override resetBattle(state?: GameState): void {
    super.resetBattle(state);
    this.crosshairTarget = null;

    // Delegate battle planning to strategy
    this.chainTargets = null;
    this.chainIdx = 0;
    this.chainType = Chain.WALL;
    if (state) {
      const plan = this.strategy.planBattle(state, this.playerId);
      this.chainTargets = plan.chainTargets;
      this.chainType = plan.chainType;
    }

    this.battleState = { step: Step.COUNTDOWN, orbit: null };
  }

  battleTick(state: GameState, dt: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    if (!nextReadyCombined(state, this.playerId)) return;

    const aimAt = this.crosshairTarget ?? this.crosshair;
    aimCannons(state, this.playerId, aimAt.x, aimAt.y, dt);

    // During countdown or after battle timer expires: move/orbit only
    if (state.battleCountdown > 0 || state.timer <= 0) {
      // Force back to countdown state if needed
      if (this.battleState.step !== Step.COUNTDOWN) {
        this.battleState = { step: Step.COUNTDOWN, orbit: null };
      }
      // If chain attack is planned, move toward first target during countdown
      if (this.chainTargets && this.chainIdx < this.chainTargets.length && state.battleCountdown > 0) {
        const first = this.chainTargets[this.chainIdx]!;
        this.crosshairTarget = tileCenterPx(first.row, first.col);
      }
      this.battleTickCountdown(state, dt);
      return;
    }

    // Transition out of countdown on first active frame
    if (this.battleState.step === Step.COUNTDOWN) {
      this.battleState = this.chainTargets && this.chainIdx < this.chainTargets.length
        ? { step: Step.CHAIN_MOVING }
        : { step: Step.PICKING };
    }

    switch (this.battleState.step) {
      case Step.CHAIN_MOVING:
        this.battleTickChainMoving(state, dt);
        break;
      case Step.CHAIN_DWELLING:
        this.battleTickChainDwelling(state, dt);
        break;
      case Step.THINKING:
        this.battleState.timer -= dt;
        if (this.battleState.timer <= 0) {
          this.battleState = { step: Step.PICKING };
        }
        break;
      case Step.PICKING:
        this.crosshairTarget = this.strategy.pickTarget(state, this.playerId, this.crosshair);
        this.battleState = { step: Step.MOVING };
        break;
      case Step.MOVING:
        if (this.crosshairTarget) {
          if (this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt)) {
            this.battleState = { step: Step.DWELLING, timer: this.scaledDelay(0.15, 0.1) };
          }
        } else {
          // No target available — keep picking
          this.battleState = { step: Step.PICKING };
        }
        break;
      case Step.DWELLING:
        this.battleTickDwelling(state, dt);
        break;
      default:
        break;
    }
  }

  /** Countdown: move toward target then orbit. */
  private battleTickCountdown(state: GameState, dt: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    if (!this.crosshairTarget) {
      this.crosshairTarget = this.strategy.pickTarget(state, this.playerId, this.crosshair);
    }
    if (!this.crosshairTarget) return;

    const s = this.battleState as Extract<BattleState, { step: typeof Step.COUNTDOWN }>;

    if (state.battleCountdown > 0) {
      // During countdown, move to target then orbit around it
      const dist = Math.hypot(
        this.crosshairTarget.x - this.crosshair.x,
        this.crosshairTarget.y - this.crosshair.y,
      );
      if (dist > ORBIT_ENGAGEMENT_DISTANCE) {
        this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt);
      } else {
        if (!s.orbit) {
          const strategic = !!this.crosshairTarget.strategic;
          const boost = strategic ? 1.2 : 1;
          const rng = this.strategy.rng;
          const speedBase = strategic ? ORBIT_SPEED_STRATEGIC_BASE : ORBIT_SPEED_DEFAULT_BASE;
          const baseSpeed = Math.PI * (speedBase + rng.next() * ORBIT_SPEED_RANGE);
          s.orbit = {
            rx: (ORBIT_RADIUS_BASE + rng.next() * ORBIT_RADIUS_RANGE) * boost,
            ry: (ORBIT_RADIUS_BASE + rng.next() * ORBIT_RADIUS_RANGE) * boost,
            speed: baseSpeed * (rng.bool() ? 1 : -1),
          };
        }
        this.idlePhase += s.orbit.speed * dt;
        this.crosshair.x = this.crosshairTarget.x + Math.cos(this.idlePhase) * s.orbit.rx;
        this.crosshair.y = this.crosshairTarget.y + Math.sin(this.idlePhase) * s.orbit.ry;
      }
    } else {
      this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt);
    }
  }

  /** Chain attack: move crosshair toward next chain target, skip destroyed walls. */
  private battleTickChainMoving(state: GameState, dt: number): void {
    if (!this.chainTargets || this.chainIdx >= this.chainTargets.length) {
      this.battleState = { step: Step.PICKING };
      return;
    }
    const target = this.chainTargets[this.chainIdx]!;
    // For wall/pocket attacks, skip already-destroyed wall tiles
    if (this.chainType === Chain.WALL || this.chainType === Chain.POCKET) {
      const targetKey = packTile(target.row, target.col);
      let wallExists = false;
      if (this.chainType === Chain.POCKET) {
        wallExists = state.players[this.playerId]!.walls.has(targetKey);
      } else {
        for (const other of state.players) {
          if (other.id !== this.playerId && other.walls.has(targetKey)) {
            wallExists = true;
            break;
          }
        }
      }
      if (!wallExists) {
        this.chainIdx++;
        if (this.chainIdx >= this.chainTargets.length) {
          this.chainTargets = null;
          this.crosshairTarget = null;
          this.battleState = { step: Step.PICKING };
        }
        return;
      }
    }
    const center = tileCenterPx(target.row, target.col);
    if (this.stepCrosshairToward(center.x, center.y, dt)) {
      this.battleState = {
        step: Step.CHAIN_DWELLING,
        timer: (0.2 + this.strategy.rng.next() * 0.1) * this.delayScale,
      };
    }
  }

  /** Chain attack: dwell then fire at chain target. */
  private battleTickChainDwelling(state: GameState, dt: number): void {
    const s = this.battleState as Extract<BattleState, { step: typeof Step.CHAIN_DWELLING }>;
    s.timer -= dt;
    if (s.timer > 0) return;

    if (!this.chainTargets || this.chainIdx >= this.chainTargets.length) {
      this.battleState = { step: Step.PICKING };
      return;
    }
    const target = this.chainTargets[this.chainIdx]!;
    const result = this.fireNext(state, target.row, target.col);
    if (result) {
      this.chainIdx++;
      if (this.chainIdx >= this.chainTargets.length) {
        this.chainTargets = null;
        this.crosshairTarget = null;
        this.battleState = { step: Step.PICKING };
      } else {
        this.battleState = { step: Step.CHAIN_MOVING };
      }
    } else {
      // No cannon ready — wait a bit longer
      s.timer = 0.05;
    }
  }

  /** Standard fire: dwell on target then fire. */
  private battleTickDwelling(state: GameState, dt: number): void {
    const s = this.battleState as Extract<BattleState, { step: typeof Step.DWELLING }>;
    s.timer -= dt;
    if (s.timer > 0) return;

    const ready = nextReadyCombined(state, this.playerId, this.lastFiredIdx);
    if (!ready) {
      s.timer = 0.05;
      return;
    }
    this.fire(state);
    this.strategy.trackShot(state, this.playerId, this.crosshair);
    // Random thinking delay before picking next target
    const thinkTime = this.scaledDelay(0.1, 0.2);
    if (this.anticipatesTarget) {
      this.crosshairTarget = this.strategy.pickTarget(state, this.playerId, this.crosshair);
      this.battleState = { step: Step.THINKING, timer: thinkTime };
    } else {
      this.crosshairTarget = null;
      this.battleState = { step: Step.THINKING, timer: thinkTime };
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override onLifeLost(): void {
    super.onLifeLost();
    this.resetAiState();
    this.strategy.onLifeLost();
  }

  private resetAiState(): void {
    this.selectionState = { step: Step.IDLE };
    this.buildState = { step: Step.IDLE };
    this.cannonState = { step: Step.IDLE };
    this.battleState = { step: Step.IDLE };
    this.cannonQueue = [];
    this.cannonMaxSlots = 0;
    this.crosshairTarget = null;
    this.chainTargets = null;
    this.chainIdx = 0;
    this.chainType = Chain.WALL;
  }

  onBattleEnd(): void {}

  override reset(): void {
    super.reset();
    this.onLifeLost();
  }

  onCannonPhaseStart(): void {}

  // -----------------------------------------------------------------------
  // Movement helpers
  // -----------------------------------------------------------------------

  /** Move a tile cursor one step toward (targetRow, targetCol). */
  private stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
    dt: number,
  ): boolean {
    const dr = targetRow - cursor.row;
    const dc = targetCol - cursor.col;
    const f = moveStepFraction(Math.sqrt(dr * dr + dc * dc), baseSpeed, boostThreshold, dt);
    if (f >= 1) { cursor.row = targetRow; cursor.col = targetCol; return true; }
    cursor.row += dr * f;
    cursor.col += dc * f;
    return false;
  }

  /** Move crosshair one step toward (tx, ty) at battle speed. */
  private stepCrosshairToward(
    tx: PixelPos["x"],
    ty: PixelPos["y"],
    dt: number,
  ): boolean {
    const dx = tx - this.crosshair.x;
    const dy = ty - this.crosshair.y;
    const f = moveStepFraction(Math.sqrt(dx * dx + dy * dy), CROSSHAIR_SPEED, this.battleBoostDist, dt);
    if (f >= 1) { this.crosshair.x = tx; this.crosshair.y = ty; return true; }
    this.crosshair.x += dx * f;
    this.crosshair.y += dy * f;
    return false;
  }

  // -----------------------------------------------------------------------
  // Build helpers
  // -----------------------------------------------------------------------

  private phantomAtCursor(): PhantomPiece {
    return this.makePhantom(
      this.currentPiece!,
      Math.round(this.buildCursor.row),
      Math.round(this.buildCursor.col),
      false,
    );
  }

  private makePhantom(
    shape: PieceShape,
    row: number,
    col: number,
    valid: boolean,
  ): PhantomPiece {
    return { offsets: shape.offsets, row, col, valid, playerId: this.playerId };
  }

  private computeNextPlacement(state: GameState): BuildTarget | null {
    if (!this.currentPiece) return null;
    const result = this.strategy.pickPlacement(
      state,
      this.playerId,
      this.currentPiece,
      {
        row: Math.round(this.buildCursor.row),
        col: Math.round(this.buildCursor.col),
      },
    );
    return result ? { piece: result.piece, row: result.row, col: result.col } : null;
  }
}

/** Compute interpolation fraction for one movement step. Returns 1 if arrived. */
function moveStepFraction(dist: number, baseSpeed: number, boostThreshold: number, dt: number): number {
  if (dist <= 0) return 1;
  const step = baseSpeed * (dist > boostThreshold ? 2 : 1) * dt;
  return step >= dist ? 1 : step / dist;
}

/** Check if two pieces have the same shape (ignoring position). */
function sameShape(a: PieceShape, b: PieceShape): boolean {
  return pieceKey(a) === pieceKey(b);
}

/** Normalized key for a piece shape (origin-independent). */
function pieceKey(p: PieceShape): string {
  const minR = Math.min(...p.offsets.map((o) => o[0]));
  const minC = Math.min(...p.offsets.map((o) => o[1]));
  return [...p.offsets]
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((o) => `${o[0]},${o[1]}`)
    .join(";");
}
