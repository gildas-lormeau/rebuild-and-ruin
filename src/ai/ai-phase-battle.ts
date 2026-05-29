/**
 * AI battle-phase state machine — targeting, chain attacks, countdown
 * orbit, and fire timing.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { aimCannons, nextReadyCannon } from "../game/index.ts";
import { SIM_TICK_DT } from "../shared/core/game-constants.ts";
import { packTile, tileCenterPx } from "../shared/core/spatial.ts";
import type {
  BattleViewState,
  FireIntent,
} from "../shared/core/system-interfaces.ts";
import type { FireOrigin } from "./ai-battle-diag.ts";
import { CHAIN, type ChainType } from "./ai-chain.ts";
import { STEP } from "./ai-constants.ts";
import type {
  BattleHost,
  BattlePlan,
  BattleTickResult,
  StrategicPixelPos,
} from "./ai-strategy-types.ts";
import { secondsToTicks } from "./ai-utils.ts";

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

// Extends BattlePlan: the controller's per-tick battle state IS a chain plan
// (chainTargets / chainType / originTag) plus live cursor + dwell bookkeeping.
// Inheriting the plan fields keeps the two shapes from drifting (and from
// tripping the shared-subset duplicate-shape lint).
interface BattlePhase extends BattlePlan {
  state: BattleState;
  crosshairTarget: StrategicPixelPos | null;
  chainIdx: number;
  /** Persistent orbit phase — accumulated across battles for natural variation. */
  orbitAngle: number;
}

/** Map a chain-attack kind to its FireOrigin tag. CHAIN.WALL aggregates
 *  planWallDemolition + planSuperAttack — both share the same skip-when-
 *  destroyed semantics so the strategy doesn't distinguish them; the
 *  origin tag collapses them too. */
const CHAIN_TO_ORIGIN: Record<ChainType, FireOrigin> = {
  [CHAIN.POCKET]: "pocket",
  [CHAIN.STRUCTURAL]: "structural",
  [CHAIN.WALL]: "wall_chain",
  [CHAIN.GRUNT]: "grunt_sweep",
  [CHAIN.ICE_TRENCH]: "ice_trench",
};
/** Per-tick multiplier for orbit angular speed (rad/s → rad/tick). */
const ORBIT_DT = SIM_TICK_DT;
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
/** Retry wait when no cannon is ready to fire (ticks). */
const CANNON_RETRY_WAIT = secondsToTicks(0.05);

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

/** Reset battle state for life-lost / new-game. Leaves orbitAngle alone
 *  here — `AiController.onResetBattle` re-seeds it from `strategy.rng` at
 *  the start of every local-controller battle (so host/watcher stay in
 *  lockstep regardless of which controller variant lands at each slot). */
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
  phase.originTag = undefined;
  if (state) {
    const plan = host.strategy.planBattle(state, host.playerId);
    phase.chainTargets = plan.chainTargets;
    phase.chainType = plan.chainType;
    phase.originTag = plan.originTag;
  }
  phase.state = { step: STEP.COUNTDOWN, orbit: null };
}

export function tickBattle(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): BattleTickResult {
  if (!nextReadyCannon(state, host.playerId)) return {};

  const aimAt = phase.crosshairTarget ?? host.crosshair;
  aimCannons(state, host.playerId, aimAt.x, aimAt.y);

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
    tickCountdown(host, phase, state);
    return {};
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
      tickChainMoving(host, phase, state);
      return {};
    case STEP.CHAIN_DWELLING:
      return tickChainDwelling(host, phase);
    case STEP.THINKING:
      phase.state.timer--;
      if (phase.state.timer <= 0) {
        phase.state = { step: STEP.PICKING };
      }
      return {};
    case STEP.PICKING:
      phase.crosshairTarget = host.strategy.pickTarget(
        state,
        host.playerId,
        host.crosshair,
      );
      phase.state = { step: STEP.MOVING };
      return {};
    case STEP.MOVING:
      if (phase.crosshairTarget) {
        if (
          host.stepCrosshairToward(
            phase.crosshairTarget.x,
            phase.crosshairTarget.y,
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
      return {};
    case STEP.DWELLING:
      return tickDwelling(host, phase, state);
    default:
      // IDLE and COUNTDOWN are handled by early returns above (lines 126–154).
      // If a new BattleState step is added, add its case here.
      return {};
  }
}

/** Apply the controller's fire-commit result to the brain's
 *  CHAIN_DWELLING or DWELLING state. On success: trackShot + advance
 *  (chain → next target / end-of-chain pivot, standard → next pick /
 *  pre-pick when `anticipatesTarget`). On failure: hold the dwell with
 *  CANNON_RETRY_WAIT so the same aim is retried once a cannon is
 *  ready. Phase.state.step (preserved across the commit) discriminates
 *  the two paths. */
export function onBattleFireResult(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  success: boolean,
): void {
  if (phase.state.step === STEP.CHAIN_DWELLING) {
    completeChainFire(phase, success);
    return;
  }
  if (phase.state.step === STEP.DWELLING) {
    completeStandardFire(host, phase, state, success);
  }
}

/** Countdown: move toward target then orbit. */
function tickCountdown(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): void {
  if (!phase.crosshairTarget) {
    phase.crosshairTarget = host.strategy.pickTarget(
      state,
      host.playerId,
      host.crosshair,
    );
  }
  if (!phase.crosshairTarget) return;

  if (phase.state.step !== STEP.COUNTDOWN) return;
  const phaseState = phase.state;

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
      phase.orbitAngle += phaseState.orbit.speed * ORBIT_DT;
      host.crosshair.x =
        phase.crosshairTarget.x +
        Math.cos(phase.orbitAngle) * phaseState.orbit.rx;
      host.crosshair.y =
        phase.crosshairTarget.y +
        Math.sin(phase.orbitAngle) * phaseState.orbit.ry;
    }
  } else {
    host.stepCrosshairToward(phase.crosshairTarget.x, phase.crosshairTarget.y);
  }
}

/** Chain attack: move crosshair toward next chain target, skip destroyed walls. */
function tickChainMoving(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
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
  if (host.stepCrosshairToward(center.x, center.y)) {
    phase.state = {
      step: STEP.CHAIN_DWELLING,
      timer: host.scaledDelay(CHAIN_DWELL_DELAY_SEC, CHAIN_DWELL_SPREAD_SEC),
    };
  }
}

/** Chain attack: dwell then produce a fire intent at the chain target.
 *  Brain holds CHAIN_DWELLING until the controller reports the commit
 *  result via `onBattleFireResult` — that's how the
 *  CANNON_RETRY_WAIT (cannon mid-reload) semantics survive moving the
 *  commit out of the brain. */
function tickChainDwelling(
  host: BattleHost,
  phase: BattlePhase,
): BattleTickResult {
  if (phase.state.step !== STEP.CHAIN_DWELLING) return {};
  const phaseState = phase.state;
  phaseState.timer--;
  if (phaseState.timer > 0) return {};

  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    phase.state = { step: STEP.PICKING };
    return {};
  }
  const target = phase.chainTargets[phase.chainIdx]!;
  const intent: FireIntent = {
    playerId: host.playerId,
    targetRow: target.row,
    targetCol: target.col,
  };
  return {
    commit: intent,
    origin: phase.originTag ?? CHAIN_TO_ORIGIN[phase.chainType],
  };
}

function completeChainFire(phase: BattlePhase, success: boolean): void {
  if (phase.state.step !== STEP.CHAIN_DWELLING) return;
  const phaseState = phase.state;
  if (!success) {
    phaseState.timer = CANNON_RETRY_WAIT;
    return;
  }
  if (!phase.chainTargets) {
    phase.state = { step: STEP.PICKING };
    return;
  }
  phase.chainIdx++;
  if (phase.chainIdx >= phase.chainTargets.length) {
    phase.chainTargets = undefined;
    phase.crosshairTarget = null;
    phase.state = { step: STEP.PICKING };
  } else {
    phase.state = { step: STEP.CHAIN_MOVING };
  }
}

/** Standard fire: dwell on target then produce a fire intent at the
 *  current crosshair. Brain holds DWELLING until the controller reports
 *  the commit result via `onBattleFireResult` — `trackShot` and the
 *  post-fire `pickTarget` only run after a successful commit.
 *  CANNON_RETRY_WAIT semantics for "no cannon ready" survive moving the
 *  commit out of the brain. */
function tickDwelling(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): BattleTickResult {
  if (phase.state.step !== STEP.DWELLING) return {};
  const phaseState = phase.state;
  phaseState.timer--;
  if (phaseState.timer > 0) return {};

  const intent = host.fire(state);
  if (!intent) {
    phaseState.timer = CANNON_RETRY_WAIT;
    return {};
  }
  const origin: FireOrigin =
    host.strategy.focusFirePlayerId !== undefined ? "focus_fire" : "default";
  // pickPath is the sub-branch of pickTarget that produced the tile we're
  // firing at — still on crosshairTarget here (overwritten only later in
  // completeStandardFire's anticipatesTarget pre-pick).
  return { commit: intent, origin, pickPath: phase.crosshairTarget?.pickPath };
}

function completeStandardFire(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  success: boolean,
): void {
  if (phase.state.step !== STEP.DWELLING) return;
  const phaseState = phase.state;
  if (!success) {
    phaseState.timer = CANNON_RETRY_WAIT;
    return;
  }
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
  } else {
    phase.crosshairTarget = null;
  }
  phase.state = { step: STEP.THINKING, timer: thinkTime };
}
