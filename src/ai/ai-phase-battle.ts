/**
 * AI battle-phase state machine — targeting, chain attacks, countdown
 * orbit, and fire timing.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { canPlayerFire, nextReadyCannon } from "../game/index.ts";
import { isSuperCannon } from "../shared/core/battle-types.ts";
import { SIM_TICK_DT } from "../shared/core/game-constants.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { getCannon, hasTowerAt } from "../shared/core/occupancy-queries.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { packTile, pxToTile, tileCenterPx } from "../shared/core/spatial.ts";
import type {
  BattleViewState,
  FireIntent,
} from "../shared/core/system-interfaces.ts";
import type { FireOrigin } from "./ai-battle-diag.ts";
import {
  CHAIN,
  type ChainType,
  OFFENSIVE_TACTICS,
  type TacticId,
} from "./ai-chain.ts";
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
  /** Diag-only: the tile the planner wanted for the current standard shot,
   *  BEFORE aim occlusion redirected it. Set alongside `crosshairTarget`;
   *  reported with the fire so observers can spot occlusion redirects. */
  intendedTarget: TilePos | null;
  /** Diag-only: pre-occlusion twin of `chainTargets`, parallel by index, so a
   *  chain fire can report the tile it meant to hit before occlusion snapped
   *  it onto a camera-near wall. */
  chainIntended: TilePos[] | undefined;
  /** Offensive tactics already fired this battle. Fed to each re-plan so the
   *  attack sequence varies instead of repeating the dominant tactic. Cleared
   *  at every battle entry (`initBattle`). */
  usedTactics: Set<TacticId>;
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
    intendedTarget: null,
    chainTargets: undefined,
    chainIntended: undefined,
    chainIdx: 0,
    chainType: CHAIN.WALL,
    usedTactics: new Set(),
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
  phase.intendedTarget = null;
  phase.chainTargets = undefined;
  phase.chainIntended = undefined;
  phase.chainIdx = 0;
  phase.chainType = CHAIN.WALL;
  phase.usedTactics.clear();
}

/** Plan chain attacks and enter COUNTDOWN state. */
export function initBattle(
  host: BattleHost,
  phase: BattlePhase,
  state?: BattleViewState,
): void {
  phase.crosshairTarget = null;
  phase.intendedTarget = null;
  phase.chainTargets = undefined;
  phase.chainIntended = undefined;
  phase.chainIdx = 0;
  phase.chainType = CHAIN.WALL;
  phase.originTag = undefined;
  phase.usedTactics.clear();
  if (state) {
    const plan = host.strategy.planBattle(state, host.playerId);
    phase.chainIntended = plan.chainTargets
      ? [...plan.chainTargets]
      : undefined;
    phase.chainTargets = occludeChainTargets(host, state, plan.chainTargets);
    phase.chainType = plan.chainType;
    phase.originTag = plan.originTag;
    recordTactic(phase, plan.tacticId);
  }
  phase.state = { step: STEP.COUNTDOWN, orbit: null };
}

export function tickBattle(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): BattleTickResult {
  // No ready cannon: freeze the brain until one reloads — except for
  // anticipatesTarget AIs, which keep aiming through the reload (the dwell
  // states' CANNON_RETRY_WAIT fires the moment a cannon comes back).
  // `canPlayerFire` still freezes them once truly disarmed (every cannon
  // dead and the last ball landed), so a cannonless brain can't spin.
  if (
    !nextReadyCannon(state, host.playerId) &&
    !(host.anticipatesTarget && canPlayerFire(state, host.playerId))
  ) {
    return {};
  }

  // Cannon barrels follow the crosshair cosmetically (computed by the
  // cannon-animator from `host.crosshair`), so the brain only steers the
  // crosshair here — no explicit aim call.

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
      return tickChainDwelling(host, phase, state);
    case STEP.THINKING:
      phase.state.timer--;
      if (phase.state.timer <= 0) {
        phase.state = { step: STEP.PICKING };
      }
      return {};
    case STEP.PICKING:
      phase.crosshairTarget = pickAndSnap(host, phase, state);
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
      // COUNTDOWN is handled by the countdown early-returns at the top of
      // this function. IDLE is the pre-battle resting state (createBattlePhase
      // / resetBattlePhaseKeepOrbit); initBattle always moves to COUNTDOWN
      // before battle ticks run, so IDLE never ticks here in practice.
      // If a new BattleState step is added, add its case here.
      return {};
  }
}

/** Apply the controller's fire-commit result to the brain's
 *  CHAIN_DWELLING or DWELLING state. On success: trackShot + advance
 *  (chain → next target / end-of-chain pivot, standard → think then
 *  pick fresh). On failure: hold the dwell with CANNON_RETRY_WAIT so
 *  the same aim is retried once a cannon is ready. Phase.state.step
 *  (preserved across the commit) discriminates the two paths. */
export function onBattleFireResult(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  success: boolean,
): void {
  if (phase.state.step === STEP.CHAIN_DWELLING) {
    completeChainFire(host, phase, state, success);
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
    phase.crosshairTarget = pickAndSnap(host, phase, state);
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
    // Drop any stale countdown chain-aim so PICKING picks fresh.
    phase.crosshairTarget = null;
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
      if (
        phase.chainIdx >= phase.chainTargets.length &&
        !replanChain(host, phase, state)
      ) {
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
  state: BattleViewState,
): BattleTickResult {
  if (phase.state.step !== STEP.CHAIN_DWELLING) return {};
  const phaseState = phase.state;
  phaseState.timer--;
  if (phaseState.timer > 0) return {};

  if (!phase.chainTargets || phase.chainIdx >= phase.chainTargets.length) {
    // Drop any stale countdown chain-aim so PICKING picks fresh.
    phase.crosshairTarget = null;
    phase.state = { step: STEP.PICKING };
    return {};
  }
  // Never spend a super gun on our OWN walls: a pocket-destruction chain fires
  // at the player's own bordering walls, and a super gun's incendiary ball
  // scorches our own territory (burning pit) instead of cleanly opening the
  // pocket. If the next round-robin cannon is a super gun, abandon the cleanup
  // and re-pick — the super gun gets an offensive target instead. (Super guns
  // in grunt/wall chains are fine; only own-wall cleanup is off-limits.)
  if (
    phase.chainType === CHAIN.POCKET &&
    nextReadyCannonIsSuper(state, host.playerId, host.cannonRotationIdx)
  ) {
    phase.chainTargets = undefined;
    phase.crosshairTarget = null;
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
    intendedTarget: phase.chainIntended?.[phase.chainIdx],
  };
}

/** Peek the cannon the next round-robin fire would use and report whether it's
 *  a super gun. Mirrors the lookup `fireNextReadyCannon` does at commit time
 *  (same `cannonRotationIdx`), so the brain's prediction matches the cannon
 *  that actually fires. Pure — no rng, no rotation advance. */
function nextReadyCannonIsSuper(
  state: BattleViewState,
  playerId: ValidPlayerId,
  rotationIdx: number | undefined,
): boolean {
  const next = nextReadyCannon(state, playerId, rotationIdx);
  if (!next) return false;
  const cannon =
    next.type === "own"
      ? getCannon(state, playerId, next.ownIdx)
      : next.captured.cannon;
  return cannon != null && isSuperCannon(cannon);
}

function completeChainFire(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
  success: boolean,
): void {
  if (phase.state.step !== STEP.CHAIN_DWELLING) return;
  const phaseState = phase.state;
  if (!success) {
    phaseState.timer = CANNON_RETRY_WAIT;
    return;
  }
  if (!phase.chainTargets) {
    // Drop any stale countdown chain-aim so PICKING picks fresh.
    phase.crosshairTarget = null;
    phase.state = { step: STEP.PICKING };
    return;
  }
  phase.chainIdx++;
  if (phase.chainIdx < phase.chainTargets.length) {
    phase.state = { step: STEP.CHAIN_MOVING };
  } else if (replanChain(host, phase, state)) {
    // Chain finished — plan the next (varied) attack against the live board.
    phase.state = { step: STEP.CHAIN_MOVING };
  } else {
    phase.chainTargets = undefined;
    phase.crosshairTarget = null;
    phase.state = { step: STEP.PICKING };
  }
}

/** Re-plan a fresh chain when the current one finishes, against the LIVE board
 *  (reactive to mid-battle wall/cannon destruction) and excluding offensive
 *  tactics already used this battle. Returns true and loads the new chain when
 *  one is found; false when no eligible tactic remains (caller falls through to
 *  per-shot picking for the rest of the battle). */
function replanChain(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): boolean {
  const plan = host.strategy.planBattle(
    state,
    host.playerId,
    phase.usedTactics,
  );
  if (!plan.chainTargets || plan.chainTargets.length === 0) return false;
  phase.chainIntended = [...plan.chainTargets];
  phase.chainTargets = occludeChainTargets(host, state, plan.chainTargets);
  phase.chainType = plan.chainType;
  phase.originTag = plan.originTag;
  phase.chainIdx = 0;
  phase.crosshairTarget = null;
  recordTactic(phase, plan.tacticId);
  return true;
}

/** Snap a freshly-planned chain's targets through the controller's `aim()`
 *  seam. A chain builds both its moving crosshair (`tickChainMoving`) and its
 *  `FireIntent` (`tickChainDwelling`) straight from these tiles, so snapping
 *  the array once at plan-load time keeps the two in lockstep — and keeps
 *  occlusion owned entirely by the aim seam, not the target-selection
 *  strategy. */
function occludeChainTargets(
  host: BattleHost,
  state: BattleViewState,
  targets: readonly TilePos[] | undefined,
): TilePos[] | undefined {
  return targets?.map((target) => {
    const center = tileCenterPx(target.row, target.col);
    const world = host.aim(state, center.x, center.y);
    return { row: pxToTile(world.wy), col: pxToTile(world.wx) };
  });
}

/** Track a fired tactic so subsequent re-plans skip it (force variety). Only
 *  offensive wall-breaching tactics are excluded; defensive / utility ones
 *  (grunt sweep, ice trench, charity, pocket) stay re-selectable. */
function recordTactic(
  phase: BattlePhase,
  tacticId: TacticId | undefined,
): void {
  if (tacticId && OFFENSIVE_TACTICS.has(tacticId))
    phase.usedTactics.add(tacticId);
}

/** Standard fire: dwell on target then produce a fire intent at the
 *  current crosshair. Brain holds DWELLING until the controller reports
 *  the commit result via `onBattleFireResult` — `trackShot` and the
 *  post-fire think only run after a successful commit.
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
  // firing at — still on crosshairTarget here (nulled only after the
  // commit resolves in completeStandardFire).
  return {
    commit: intent,
    origin,
    pickPath: phase.crosshairTarget?.pickPath,
    intendedTarget: phase.intendedTarget ?? undefined,
  };
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
  // Random thinking delay before picking next target. The pick itself
  // happens in PICKING, after the delay — against the board as it is
  // then, not as it was at fire time.
  phase.crosshairTarget = null;
  phase.state = {
    step: STEP.THINKING,
    timer: host.scaledDelay(POST_FIRE_THINK_SEC, POST_FIRE_THINK_SPREAD_SEC),
  };
}

/** Pick a standard target, record the pre-occlusion tile on `phase` (diag), and
 *  return the occlusion-snapped aim. The recorded `intendedTarget` is reported
 *  with the fire so observers can see when occlusion redirected the shot. */
function pickAndSnap(
  host: BattleHost,
  phase: BattlePhase,
  state: BattleViewState,
): StrategicPixelPos | null {
  const picked = host.strategy.pickTarget(state, host.playerId, host.crosshair);
  phase.intendedTarget = picked
    ? { row: pxToTile(picked.y), col: pxToTile(picked.x) }
    : null;
  const snapped = snapAimToOcclusion(host, state, picked);
  // Final guard: drop a pick the occlusion seam redirected onto an invulnerable
  // tower — that cannonball is always wasted. `pickTarget`'s candidate-list
  // filters already drop tower-occluded WALLS (so the breach walk can't fixate
  // on one), leaving only residual cases here: e.g. a cannon whose jittered aim
  // lands on a tower behind it. Returning null re-picks next tick (jitter + rng
  // advance → a reachable aim) instead of firing into the tower.
  if (snapped && phase.intendedTarget) {
    const aimRow = pxToTile(snapped.y);
    const aimCol = pxToTile(snapped.x);
    if (
      (aimRow !== phase.intendedTarget.row ||
        aimCol !== phase.intendedTarget.col) &&
      hasTowerAt(state, aimRow, aimCol)
    ) {
      return null;
    }
  }
  return snapped;
}

/** Snap a single-shot aim target through the controller's `aim()` seam so the
 *  AI (and assisted-human) can't aim at a tile a human's crosshair could never
 *  reach: if a nearer wall/tower hides the target under the battle tilt, the
 *  aim redirects onto that occluder (where the pointer pick would land),
 *  carrying the strategic metadata along. The occlusion geometry lives behind
 *  the seam (`host.aim`), not here. Chain targets are snapped at plan time (see
 *  `planBattle`); this covers the standard pick. */
function snapAimToOcclusion(
  host: BattleHost,
  state: BattleViewState,
  target: StrategicPixelPos | null,
): StrategicPixelPos | null {
  if (target === null) return null;
  const world = host.aim(state, target.x, target.y);
  return { ...target, x: world.wx, y: world.wy };
}
