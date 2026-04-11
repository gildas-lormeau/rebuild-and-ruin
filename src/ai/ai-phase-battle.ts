/**
 * AI battle-phase state machine — targeting, chain attacks, countdown
 * orbit, and fire timing.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { aimCannons, nextReadyCombined } from "../game/battle-system.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { packTile, tileCenterPx } from "../shared/spatial.ts";
import type {
  BattleViewState,
  FireIntent,
} from "../shared/system-interfaces.ts";
import type { StrategicPixelPos } from "./ai-build-types.ts";
import { STEP } from "./ai-constants.ts";
import { type AiStrategy, CHAIN, type ChainType } from "./ai-strategy.ts";

/** Callback that executes a fire intent against mutable game state.
 *  Returns true if a cannon actually fired. */
type ExecuteFireFn = (intent: FireIntent) => boolean;

/** Subset of AiController accessed by battle-phase logic.
 *  Exported so controller-ai.ts can statically assert AiController implements
 *  every phase's Host (see the `satisfies` check at the bottom of that file). */
export interface BattleHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  crosshair: { x: number; y: number };
  readonly cannonRotationIdx: number | undefined;
  readonly anticipatesTarget: boolean;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
  stepCrosshairToward(tx: number, ty: number, dt: number): boolean;
  fire(state: BattleViewState): FireIntent | null;
}

/** Pre-battle countdown orbit parameters (randomized once per countdown). */
type CountdownOrbit = { rx: number; ry: number; speed: number };

type BattleState =
  | { step: "idle" }
  | { step: "countdown"; orbit: CountdownOrbit | null }
  | { step: "chain_moving" }
  | { step: "chain_dwelling"; timer: number }
  | { step: "thinking"; timer: number }
  | { step: "picking" }
  | { step: "moving" }
  | { step: "dwelling"; timer: number };

interface BattlePhase {
  state: BattleState;
  crosshairTarget: StrategicPixelPos | null;
  chainTargets: TilePos[] | undefined;
  chainIdx: number;
  chainType: ChainType;
  /** Persistent orbit phase — accumulated across battles for natural variation. */
  orbitAngle: number;
}

/** Pixel distance at which countdown orbit engages (stop approaching, start circling). */
const ORBIT_ENGAGEMENT_DISTANCE_PX = 12;
/** Base orbit angular speed (rad/s) when targeting a strategic tile. */
const ORBIT_SPEED_STRATEGIC_RAD_S = 5.5;
/** Base orbit angular speed (rad/s) for default targets. */
const ORBIT_SPEED_DEFAULT_RAD_S = 4.5;
/** Random variation added to orbit angular speed (rad/s). */
const ORBIT_SPEED_RANGE_RAD_S = 1.5;
/** Base orbit ellipse radius (pixels). */
const ORBIT_RADIUS_BASE_PX = 5;
/** Random variation added to orbit radius (pixels). */
const ORBIT_RADIUS_RANGE_PX = 3;
/** Pause on target before firing (standard attack). */
const PRE_FIRE_DELAY_SEC = 0.15;
const PRE_FIRE_SPREAD_SEC = 0.1;
/** Pause on chain target before firing (chain attack). */
const CHAIN_DWELL_DELAY_SEC = 0.2;
const CHAIN_DWELL_SPREAD_SEC = 0.1;
/** Thinking delay after firing before picking the next target. */
const POST_FIRE_THINK_SEC = 0.1;
const POST_FIRE_THINK_SPREAD_SEC = 0.2;
/** Retry wait when no cannon is ready to fire. */
const CANNON_RETRY_WAIT_SEC = 0.05;

export function createBattlePhase(): BattlePhase {
  return {
    state: { step: STEP.IDLE },
    crosshairTarget: null,
    chainTargets: undefined,
    chainIdx: 0,
    chainType: CHAIN.WALL,
    orbitAngle: 0,
  };
}

/** Reset battle state for life-lost / new-game. Does NOT reset orbitAngle
 *  (it persists across battles for natural variation). */
export function resetBattlePhaseKeepOrbit(phase: BattlePhase): void {
  phase.state = { step: STEP.IDLE };
  phase.crosshairTarget = null;
  phase.chainTargets = undefined;
  phase.chainIdx = 0;
  phase.chainType = CHAIN.WALL;
}

/** Plan chain attacks and enter COUNTDOWN state. */
export function initBattle(
  host: BattleHost,
  phase: BattlePhase,
  state?: BattleViewState,
): void {
  phase.crosshairTarget = null;
  phase.chainTargets = undefined;
  phase.chainIdx = 0;
  phase.chainType = CHAIN.WALL;
  if (state) {
    const plan = host.strategy.planBattle(state, host.playerId);
    phase.chainTargets = plan.chainTargets;
    phase.chainType = plan.chainType;
  }
  phase.state = { step: STEP.COUNTDOWN, orbit: null };
}

export function tickBattle(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  dt: number,
  executeFire: ExecuteFireFn,
): void {
  if (!nextReadyCombined(state, host.playerId)) return;

  const aimAt = phase.crosshairTarget ?? host.crosshair;
  aimCannons(state, host.playerId, aimAt.x, aimAt.y, dt);

  // During countdown or after battle timer expires: move/orbit only
  if (state.battleCountdown > 0 || state.timer <= 0) {
    // Force back to countdown state if needed
    if (phase.state.step !== STEP.COUNTDOWN) {
      phase.state = { step: STEP.COUNTDOWN, orbit: null };
    }
    // If chain attack is planned, move toward first target during countdown
    if (
      phase.chainTargets &&
      phase.chainIdx < phase.chainTargets.length &&
      state.battleCountdown > 0
    ) {
      const first = phase.chainTargets[phase.chainIdx]!;
      phase.crosshairTarget = tileCenterPx(first.row, first.col);
    }
    tickCountdown(host, phase, state, dt);
    return;
  }

  // Transition out of countdown on first active frame
  if (phase.state.step === STEP.COUNTDOWN) {
    if (phase.chainTargets && phase.chainIdx < phase.chainTargets.length) {
      phase.state = { step: STEP.CHAIN_MOVING };
    } else if (phase.crosshairTarget) {
      // Fire at the target we were aiming at during countdown
      phase.state = { step: STEP.MOVING };
    } else {
      phase.state = { step: STEP.PICKING };
    }
  }

  switch (phase.state.step) {
    case STEP.CHAIN_MOVING:
      tickChainMoving(host, phase, state, dt);
      break;
    case STEP.CHAIN_DWELLING:
      tickChainDwelling(host, phase, state, dt, executeFire);
      break;
    case STEP.THINKING:
      phase.state.timer -= dt;
      if (phase.state.timer <= 0) {
        phase.state = { step: STEP.PICKING };
      }
      break;
    case STEP.PICKING:
      phase.crosshairTarget = host.strategy.pickTarget(
        state,
        host.playerId,
        host.crosshair,
      );
      phase.state = { step: STEP.MOVING };
      break;
    case STEP.MOVING:
      if (phase.crosshairTarget) {
        if (
          host.stepCrosshairToward(
            phase.crosshairTarget.x,
            phase.crosshairTarget.y,
            dt,
          )
        ) {
          phase.state = {
            step: STEP.DWELLING,
            timer: host.scaledDelay(PRE_FIRE_DELAY_SEC, PRE_FIRE_SPREAD_SEC),
          };
        }
      } else {
        // No target available — keep picking
        phase.state = { step: STEP.PICKING };
      }
      break;
    case STEP.DWELLING:
      tickDwelling(host, phase, state, dt, executeFire);
      break;
    default:
      // IDLE and COUNTDOWN are handled by early returns above (lines 126–154).
      // If a new BattleState step is added, add its case here.
      break;
  }
}

/** Countdown: move toward target then orbit. */
function tickCountdown(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  dt: number,
): void {
  if (!phase.crosshairTarget) {
    phase.crosshairTarget = host.strategy.pickTarget(
      state,
      host.playerId,
      host.crosshair,
    );
  }
  if (!phase.crosshairTarget) return;

  const phaseState = phase.state as Extract<BattleState, { step: "countdown" }>;

  if (state.battleCountdown > 0) {
    // During countdown, move to target then orbit around it
    const dist = Math.hypot(
      phase.crosshairTarget.x - host.crosshair.x,
      phase.crosshairTarget.y - host.crosshair.y,
    );
    if (dist > ORBIT_ENGAGEMENT_DISTANCE_PX) {
      host.stepCrosshairToward(
        phase.crosshairTarget.x,
        phase.crosshairTarget.y,
        dt,
      );
    } else {
      if (!phaseState.orbit) {
        const strategic = !!phase.crosshairTarget.strategic;
        const boost = strategic ? 1.2 : 1;
        const rng = host.strategy.rng;
        const speedBase = strategic
          ? ORBIT_SPEED_STRATEGIC_RAD_S
          : ORBIT_SPEED_DEFAULT_RAD_S;
        const baseSpeed =
          Math.PI * (speedBase + rng.next() * ORBIT_SPEED_RANGE_RAD_S);
        phaseState.orbit = {
          rx:
            (ORBIT_RADIUS_BASE_PX + rng.next() * ORBIT_RADIUS_RANGE_PX) * boost,
          ry:
            (ORBIT_RADIUS_BASE_PX + rng.next() * ORBIT_RADIUS_RANGE_PX) * boost,
          speed: baseSpeed * (rng.bool() ? 1 : -1),
        };
        // Seed the phase from the current approach angle so the orbit
        // starts where the crosshair already is (no visible jump).
        phase.orbitAngle = Math.atan2(
          host.crosshair.y - phase.crosshairTarget.y,
          host.crosshair.x - phase.crosshairTarget.x,
        );
      }
      phase.orbitAngle += phaseState.orbit.speed * dt;
      host.crosshair.x =
        phase.crosshairTarget.x +
        Math.cos(phase.orbitAngle) * phaseState.orbit.rx;
      host.crosshair.y =
        phase.crosshairTarget.y +
        Math.sin(phase.orbitAngle) * phaseState.orbit.ry;
    }
  } else {
    host.stepCrosshairToward(
      phase.crosshairTarget.x,
      phase.crosshairTarget.y,
      dt,
    );
  }
}

/** Chain attack: move crosshair toward next chain target, skip destroyed walls. */
function tickChainMoving(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  dt: number,
): void {
  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    phase.state = { step: STEP.PICKING };
    return;
  }
  const target = phase.chainTargets[phase.chainIdx]!;
  // For wall/pocket/structural/ice attacks, skip already-destroyed targets
  if (
    phase.chainType === CHAIN.WALL ||
    phase.chainType === CHAIN.POCKET ||
    phase.chainType === CHAIN.STRUCTURAL ||
    phase.chainType === CHAIN.ICE_TRENCH
  ) {
    const targetKey = packTile(target.row, target.col);
    let targetExists = false;
    if (phase.chainType === CHAIN.POCKET) {
      targetExists =
        state.players[host.playerId]?.walls.has(targetKey) ?? false;
    } else if (phase.chainType === CHAIN.ICE_TRENCH) {
      targetExists = state.modern?.frozenTiles?.has(targetKey) ?? false;
    } else {
      for (const other of state.players) {
        if (other.id !== host.playerId && other.walls.has(targetKey)) {
          targetExists = true;
          break;
        }
      }
    }
    if (!targetExists) {
      phase.chainIdx++;
      if (phase.chainIdx >= phase.chainTargets.length) {
        phase.chainTargets = undefined;
        phase.crosshairTarget = null;
        phase.state = { step: STEP.PICKING };
      }
      return;
    }
  }
  const center = tileCenterPx(target.row, target.col);
  if (host.stepCrosshairToward(center.x, center.y, dt)) {
    phase.state = {
      step: STEP.CHAIN_DWELLING,
      timer: host.scaledDelay(CHAIN_DWELL_DELAY_SEC, CHAIN_DWELL_SPREAD_SEC),
    };
  }
}

/** Chain attack: dwell then fire at chain target. */
function tickChainDwelling(
  host: BattleHost,
  phase: BattlePhase,
  _state: BattleViewState,
  dt: number,
  executeFire: ExecuteFireFn,
): void {
  const phaseState = phase.state as Extract<
    BattleState,
    { step: "chain_dwelling" }
  >;
  phaseState.timer -= dt;
  if (phaseState.timer > 0) return;

  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    phase.state = { step: STEP.PICKING };
    return;
  }
  const target = phase.chainTargets[phase.chainIdx]!;
  const intent: FireIntent = {
    playerId: host.playerId,
    targetRow: target.row,
    targetCol: target.col,
  };
  if (executeFire(intent)) {
    phase.chainIdx++;
    if (phase.chainIdx >= phase.chainTargets.length) {
      phase.chainTargets = undefined;
      phase.crosshairTarget = null;
      phase.state = { step: STEP.PICKING };
    } else {
      phase.state = { step: STEP.CHAIN_MOVING };
    }
  } else {
    // No cannon ready — wait a bit longer
    phaseState.timer = CANNON_RETRY_WAIT_SEC;
  }
}

/** Standard fire: dwell on target then fire. */
function tickDwelling(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  dt: number,
  executeFire: ExecuteFireFn,
): void {
  const phaseState = phase.state as Extract<BattleState, { step: "dwelling" }>;
  phaseState.timer -= dt;
  if (phaseState.timer > 0) return;

  const intent = host.fire(state);
  if (!intent) {
    phaseState.timer = CANNON_RETRY_WAIT_SEC;
    return;
  }
  executeFire(intent);
  host.strategy.trackShot(state, host.playerId, host.crosshair);
  // Random thinking delay before picking next target
  const thinkTime = host.scaledDelay(
    POST_FIRE_THINK_SEC,
    POST_FIRE_THINK_SPREAD_SEC,
  );
  if (host.anticipatesTarget) {
    phase.crosshairTarget = host.strategy.pickTarget(
      state,
      host.playerId,
      host.crosshair,
    );
    phase.state = { step: STEP.THINKING, timer: thinkTime };
  } else {
    phase.crosshairTarget = null;
    phase.state = { step: STEP.THINKING, timer: thinkTime };
  }
}
