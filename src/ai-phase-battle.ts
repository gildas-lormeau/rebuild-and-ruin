/**
 * AI battle-phase state machine — targeting, chain attacks, countdown
 * orbit, and fire timing.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { STEP } from "./ai-constants.ts";
import { type AiStrategy, CHAIN, type ChainType } from "./ai-strategy.ts";
import { aimCannons, nextReadyCombined } from "./battle-system.ts";
import type { ValidPlayerSlot } from "./game-constants.ts";
import type { StrategicPixelPos, TilePos } from "./geometry-types.ts";
import { packTile, tileCenterPx } from "./spatial.ts";
import {
  type CombinedCannonResult,
  type GameState,
  isPlayerAlive,
} from "./types.ts";

/** Subset of AiController accessed by battle-phase logic. */
interface BattleHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  crosshair: { x: number; y: number };
  readonly cannonRotationIdx: number | null;
  readonly anticipatesTarget: boolean;
  scaledDelay(base: number, spread: number): number;
  stepCrosshairToward(tx: number, ty: number, dt: number): boolean;
  fire(state: GameState): void;
  fireNextCannon(
    state: GameState,
    targetRow: number,
    targetCol: number,
  ): CombinedCannonResult | null;
}

/** Pre-battle countdown orbit parameters (randomized once per countdown). */
type CountdownOrbit = { rx: number; ry: number; speed: number };

type BattleState =
  | { step: typeof STEP.IDLE }
  | { step: typeof STEP.COUNTDOWN; orbit: CountdownOrbit | null }
  | { step: typeof STEP.CHAIN_MOVING }
  | { step: typeof STEP.CHAIN_DWELLING; timer: number }
  | { step: typeof STEP.THINKING; timer: number }
  | { step: typeof STEP.PICKING }
  | { step: typeof STEP.MOVING }
  | { step: typeof STEP.DWELLING; timer: number };

interface BattlePhase {
  state: BattleState;
  crosshairTarget: StrategicPixelPos | null;
  chainTargets: TilePos[] | null;
  chainIdx: number;
  chainType: ChainType;
  /** Persistent orbit phase — accumulated across battles for natural variation. */
  orbitAngle: number;
}

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

export function createBattlePhase(): BattlePhase {
  return {
    state: { step: STEP.IDLE },
    crosshairTarget: null,
    chainTargets: null,
    chainIdx: 0,
    chainType: CHAIN.WALL,
    orbitAngle: 0,
  };
}

/** Reset battle state for life-lost / new-game. Does NOT reset orbitAngle
 *  (it persists across battles for natural variation). */
export function resetBattlePhase(phase: BattlePhase): void {
  phase.state = { step: STEP.IDLE };
  phase.crosshairTarget = null;
  phase.chainTargets = null;
  phase.chainIdx = 0;
  phase.chainType = CHAIN.WALL;
}

/** Plan chain attacks and enter COUNTDOWN state. */
export function initBattle(
  host: BattleHost,
  phase: BattlePhase,
  state?: GameState,
): void {
  phase.crosshairTarget = null;
  phase.chainTargets = null;
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
  state: GameState,
  dt: number,
): void {
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return;
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
      tickChainDwelling(host, phase, state, dt);
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
            timer: host.scaledDelay(0.15, 0.1),
          };
        }
      } else {
        // No target available — keep picking
        phase.state = { step: STEP.PICKING };
      }
      break;
    case STEP.DWELLING:
      tickDwelling(host, phase, state, dt);
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
  state: GameState,
  dt: number,
): void {
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return;
  if (!phase.crosshairTarget) {
    phase.crosshairTarget = host.strategy.pickTarget(
      state,
      host.playerId,
      host.crosshair,
    );
  }
  if (!phase.crosshairTarget) return;

  const ps = phase.state as Extract<
    BattleState,
    { step: typeof STEP.COUNTDOWN }
  >;

  if (state.battleCountdown > 0) {
    // During countdown, move to target then orbit around it
    const dist = Math.hypot(
      phase.crosshairTarget.x - host.crosshair.x,
      phase.crosshairTarget.y - host.crosshair.y,
    );
    if (dist > ORBIT_ENGAGEMENT_DISTANCE) {
      host.stepCrosshairToward(
        phase.crosshairTarget.x,
        phase.crosshairTarget.y,
        dt,
      );
    } else {
      if (!ps.orbit) {
        const strategic = !!phase.crosshairTarget.strategic;
        const boost = strategic ? 1.2 : 1;
        const rng = host.strategy.rng;
        const speedBase = strategic
          ? ORBIT_SPEED_STRATEGIC_BASE
          : ORBIT_SPEED_DEFAULT_BASE;
        const baseSpeed =
          Math.PI * (speedBase + rng.next() * ORBIT_SPEED_RANGE);
        ps.orbit = {
          rx: (ORBIT_RADIUS_BASE + rng.next() * ORBIT_RADIUS_RANGE) * boost,
          ry: (ORBIT_RADIUS_BASE + rng.next() * ORBIT_RADIUS_RANGE) * boost,
          speed: baseSpeed * (rng.bool() ? 1 : -1),
        };
        // Seed the phase from the current approach angle so the orbit
        // starts where the crosshair already is (no visible jump).
        phase.orbitAngle = Math.atan2(
          host.crosshair.y - phase.crosshairTarget.y,
          host.crosshair.x - phase.crosshairTarget.x,
        );
      }
      phase.orbitAngle += ps.orbit.speed * dt;
      host.crosshair.x =
        phase.crosshairTarget.x + Math.cos(phase.orbitAngle) * ps.orbit.rx;
      host.crosshair.y =
        phase.crosshairTarget.y + Math.sin(phase.orbitAngle) * ps.orbit.ry;
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
  state: GameState,
  dt: number,
): void {
  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    phase.state = { step: STEP.PICKING };
    return;
  }
  const target = phase.chainTargets[phase.chainIdx]!;
  // For wall/pocket attacks, skip already-destroyed wall tiles
  if (phase.chainType === CHAIN.WALL || phase.chainType === CHAIN.POCKET) {
    const targetKey = packTile(target.row, target.col);
    let wallExists = false;
    if (phase.chainType === CHAIN.POCKET) {
      wallExists = state.players[host.playerId]?.walls.has(targetKey) ?? false;
    } else {
      for (const other of state.players) {
        if (other.id !== host.playerId && other.walls.has(targetKey)) {
          wallExists = true;
          break;
        }
      }
    }
    if (!wallExists) {
      phase.chainIdx++;
      if (phase.chainIdx >= phase.chainTargets.length) {
        phase.chainTargets = null;
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
      timer: host.scaledDelay(0.2, 0.1),
    };
  }
}

/** Chain attack: dwell then fire at chain target. */
function tickChainDwelling(
  host: BattleHost,
  phase: BattlePhase,
  state: GameState,
  dt: number,
): void {
  const ps = phase.state as Extract<
    BattleState,
    { step: typeof STEP.CHAIN_DWELLING }
  >;
  ps.timer -= dt;
  if (ps.timer > 0) return;

  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    phase.state = { step: STEP.PICKING };
    return;
  }
  const target = phase.chainTargets[phase.chainIdx]!;
  const result = host.fireNextCannon(state, target.row, target.col);
  if (result) {
    phase.chainIdx++;
    if (phase.chainIdx >= phase.chainTargets.length) {
      phase.chainTargets = null;
      phase.crosshairTarget = null;
      phase.state = { step: STEP.PICKING };
    } else {
      phase.state = { step: STEP.CHAIN_MOVING };
    }
  } else {
    // No cannon ready — wait a bit longer
    ps.timer = 0.05;
  }
}

/** Standard fire: dwell on target then fire. */
function tickDwelling(
  host: BattleHost,
  phase: BattlePhase,
  state: GameState,
  dt: number,
): void {
  const ps = phase.state as Extract<
    BattleState,
    { step: typeof STEP.DWELLING }
  >;
  ps.timer -= dt;
  if (ps.timer > 0) return;

  const ready = nextReadyCombined(state, host.playerId, host.cannonRotationIdx);
  if (!ready) {
    ps.timer = 0.05;
    return;
  }
  host.fire(state);
  host.strategy.trackShot(state, host.playerId, host.crosshair);
  // Random thinking delay before picking next target
  const thinkTime = host.scaledDelay(0.1, 0.2);
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
