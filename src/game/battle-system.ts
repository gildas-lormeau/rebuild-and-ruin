/**
 * Battle system — cannon firing, cannonball physics, impacts, and balloon capture.
 */

import {
  BATTLE_MESSAGE,
  type CannonFiredMessage,
  createCannonFiredMsg,
  type ImpactEvent,
  type TowerKilledMessage,
} from "../shared/core/battle-events.ts";
import type {
  BalloonFlight,
  Cannon,
  Cannonball,
  CapturedCannon,
  CombinedCannonResult,
} from "../shared/core/battle-types.ts";
import {
  filterActiveEnemies,
  zoneOwnerIdAt,
} from "../shared/core/board-occupancy.ts";
import {
  BALL_SPEED,
  BALLOON_HITS_NEEDED,
  BURNING_PIT_DURATION,
  DESTROY_CANNON_POINTS,
  DESTROY_GRUNT_POINTS,
  DESTROY_WALL_POINTS,
  HOUSE_GRUNT_SPAWN_CHANCE,
  SUPER_BALLOON_HITS_NEEDED,
  SUPER_GUN_THREAT_WEIGHT,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../shared/core/grid.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  isPlayerEliminated,
  type Player,
} from "../shared/core/player-types.ts";
import { deletePlayerWallBattle } from "../shared/core/player-walls.ts";
import {
  cannonCenter,
  hasPitAt,
  inBounds,
  isAtTile,
  isBalloonCannon,
  isCannonAlive,
  isCannonTile,
  isRampartCannon,
  isSuperCannon,
  isWater,
  packTile,
  pxToTile,
  rotateToward,
  TILE_CENTER_OFFSET,
} from "../shared/core/spatial.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  filterActiveFiringCannons,
  isCannonEnclosed,
} from "./cannon-system.ts";
import {
  COMBO_CANNON,
  COMBO_GRUNT,
  COMBO_WALL,
  scoreImpactCombo,
  tickComboTracking,
} from "./combo-system.ts";
import { findGruntSpawnNear, gruntAttackTowers } from "./grunt-system.ts";
import { applyDustStormJitter } from "./modifier-system.ts";
import {
  ballSpeedMult,
  onCannonKilled,
  onGruntKilled,
  onImpactResolved,
} from "./upgrade-system.ts";
import { resolveWallShield, ShieldKind } from "./wall-impact.ts";

/** Result of tickCannonballs: impact positions (for VFX) + detailed events (for network). */
interface CannonballUpdateResult {
  impacts: TilePos[];
  events: ImpactEvent[];
}

/** Combined per-frame battle tick result: grunt tower kills, cannonball impact
 *  events, and visual impact positions. Returned by `tickBattleCombat`. */
export interface BattleCombatResult {
  towerEvents: TowerKilledMessage[];
  impactEvents: ImpactEvent[];
  newImpacts: TilePos[];
}

/** Pairs each announcement text with its matching bus-event type so
 *  `setBattleCountdown` can emit without re-deriving the type from the
 *  text. Instances are compared by identity, which also means the
 *  string literals here are the single source of truth — no copies
 *  scattered across the file. */
interface AnnouncementStep {
  readonly text: string;
  readonly eventType: "battleReady" | "battleAim" | "battleFire";
}

/** Cannon barrel rotation speed: 3π rad/s ≈ 540°/s.
 *  Tuned for snappy visual feedback — cannons should visually track
 *  the crosshair with minimal lag but not feel instant. */
const CANNON_ROTATE_SPEED = Math.PI * 3;
/** Firework-whistle variant durations (seconds), indexed by variant id.
 *  The sample audio contains a rising whistle followed by a built-in
 *  explosion pop — so the whole duration must fit inside the ball's
 *  remaining travel time for the pop to land on impact. At launch we
 *  filter to the variants whose duration ≤ total travel time and pick
 *  one at random via `state.rng`. Balls whose trajectory is shorter
 *  than every variant skip the whistle entirely (point-blank shots).
 *
 *  The variant id is what travels on the bus + ball state. sfx-player
 *  owns the id → sample name mapping and MUST keep its array in the
 *  same order as this one. Order is not numeric: fastest-to-slowest. */
const WHISTLE_VARIANT_DURATIONS_SEC: readonly number[] = [
  1.888, // matches sfx-player's variant 0 ("fwwhist1")
  2.4, //   matches sfx-player's variant 1 ("fwwhist3")
  3.168, // matches sfx-player's variant 2 ("fwwhist2")
];
/** Countdown thresholds for battle announcement phases:
 *    > 3s → "Ready"   |   1–3s → "Aim"   |   ≤ 1s → "FIRE!" */
const COUNTDOWN_READY_SEC = 3;
const COUNTDOWN_AIM_SEC = 1;
const READY_STEP: AnnouncementStep = {
  text: "Ready",
  eventType: GAME_EVENT.BATTLE_READY,
};
const AIM_STEP: AnnouncementStep = {
  text: "Aim",
  eventType: GAME_EVENT.BATTLE_AIM,
};
const FIRE_STEP: AnnouncementStep = {
  text: "Fire!",
  eventType: GAME_EVENT.BATTLE_FIRE,
};
/** Sentinel: no target found (used for victimId lookups). */
const VICTIM_ID_UNKNOWN = -1;
/** Sentinel: cannon index not found in victim's array. */
const CANNON_NOT_FOUND = -1;

/** Called by both the host tick and the watcher recompute after they
 *  mutate `state.timer`. If the timer just crossed from > 0 to 0 during
 *  BATTLE, emit `battleCease` — the "stop firing" beat. Distinct from
 *  phaseEnd because the phase keeps running until airborne cannonballs
 *  land. */
export function emitBattleCeaseIfTimerCrossed(
  state: GameState,
  prevTimer: number,
): void {
  if (state.phase !== Phase.BATTLE) return;
  if (prevTimer <= 0 || state.timer > 0) return;
  emitGameEvent(state.bus, GAME_EVENT.BATTLE_CEASE, { round: state.round });
}

/** Decrement the battle countdown timer, emit a transition event on each
 *  Ready/Aim/Fire threshold crossing, and return the announcement text.
 *  Pure game logic — no rendering or crosshair sync. */
export function advanceBattleCountdown(
  state: GameState,
  dt: number,
): string | undefined {
  return setBattleCountdown(state, state.battleCountdown - dt);
}

/** Set `state.battleCountdown` directly (clamped to ≥ 0) and emit the
 *  announcement transition event on a threshold crossing. Both the host
 *  tick (advanceBattleCountdown) and the watcher (timing-derived recompute)
 *  flow through this so the Ready/Aim/Fire voice-line SFX fire on every
 *  client regardless of who owns the simulation. */
export function setBattleCountdown(
  state: GameState,
  next: number,
): string | undefined {
  const prev = getAnnouncementStep(state.battleCountdown);
  state.battleCountdown = Math.max(0, next);
  const current = getAnnouncementStep(state.battleCountdown);
  if (current && current !== prev) {
    emitGameEvent(state.bus, current.eventType, { round: state.round });
  }
  return current?.text;
}

/** Whether a player has a cannon ready to fire or a cannonball in flight. */
export function canPlayerFire(
  state: GameViewState & {
    readonly capturedCannons: readonly CapturedCannon[];
    readonly cannonballs: readonly Cannonball[];
  },
  playerId: ValidPlayerSlot,
): boolean {
  if (nextReadyCombined(state, playerId)) return true;
  return state.cannonballs.some(
    (b) => b.playerId === playerId || b.scoringPlayerId === playerId,
  );
}

/** Point all of a player's live cannons toward a crosshair position (pixels).
 *  Also aims any cannons this player has captured via propaganda balloons.
 *  When dt > 0, rotation is smooth; when dt <= 0, rotation snaps instantly. */
export function aimCannons(
  state: GameViewState & {
    readonly capturedCannons: readonly CapturedCannon[];
  },
  playerId: ValidPlayerSlot,
  cx: number,
  cy: number,
  dt = 0,
): void {
  const player = state.players[playerId];
  if (!player) return;
  // Collect captured cannon refs so we skip them from the owner's own aiming
  const capturedByOthers = new Set<Cannon>();
  for (const captured of state.capturedCannons) {
    capturedByOthers.add(captured.cannon);
  }
  // Infinity = snap instantly (used when dt <= 0, e.g. initial facing setup)
  const maxStep = dt > 0 ? CANNON_ROTATE_SPEED * dt : Infinity;
  const aimAt = (cannon: Cannon) => {
    const { x: ox, y: oy } = cannonCenter(cannon);
    const target = Math.atan2(cx - ox, -(cy - oy));
    const current = cannon.facing ?? 0;
    cannon.facing =
      maxStep === Infinity ? target : rotateToward(current, target, maxStep);
  };

  // Aim own cannons (excluding ones captured by someone else or not enclosed)
  for (const cannon of player.cannons) {
    if (!isCannonAlive(cannon) || capturedByOthers.has(cannon)) continue;
    // Only rotate cannons inside enclosed territory
    if (!isCannonEnclosed(cannon, player)) continue;
    aimAt(cannon);
  }
  // Aim captured cannons toward the capturer's crosshair
  for (const captured of state.capturedCannons) {
    if (captured.capturerId !== playerId) continue;
    if (!isCannonAlive(captured.cannon)) continue;
    aimAt(captured.cannon);
  }
}

/**
 * Per-frame battle tick: runs grunt tower attacks then advances cannonballs.
 *
 * Load-bearing event order (do not split or reorder):
 *   1. gruntAttackTowers — emits tower kill/damage events
 *   2. tickCannonballs   — emits impact events + visual impact positions
 *
 * Caller is responsible for collecting controller `fireEvents` *before* calling
 * this; those depend on controller ticks producing new cannonballs first.
 */
export function tickBattlePhase(
  state: GameState,
  dt: number,
): BattleCombatResult {
  const towerEvents = gruntAttackTowers(state, dt);
  const { impacts: newImpacts, events: impactEvents } = tickCannonballs(
    state,
    dt,
  );
  return { towerEvents, impactEvents, newImpacts };
}

/**
 * Resolve all placed propaganda balloons at the CANNON_PLACE → BATTLE transition.
 * For each balloon, find the "most dangerous" enemy cannon and capture it.
 * Returns flight paths for animation.
 *
 * Balloon hit lifecycle (persistent counts, per-battle capturers):
 *   - cannon.balloonHits accumulates across battles — a cannon that
 *     survives multiple rounds keeps its prior hit count toward capture.
 *   - cannon.balloonCapturerIds tracks which players contributed hits
 *     THIS battle only — cleared each round by cleanupBalloonHitTrackingAfterBattle()
 *     so only the deciding battle's contributors can claim the capture.
 *   - Fields are cleared when a cannon is captured or destroyed.
 */
export function resolveBalloons(state: GameState): BalloonFlight[] {
  const flights: BalloonFlight[] = [];
  const allBalloons = collectAllBalloons(state);
  const thisRoundTargets = new Map<Cannon, { victimId: ValidPlayerSlot }>();
  const balloonCountPerTarget = new Map<Cannon, number>();

  // Assign each balloon to a target (deferred to avoid double-counting)
  const assignments: {
    balloon: Cannon;
    ownerId: number;
    target: Cannon;
    victimId: ValidPlayerSlot;
  }[] = [];

  for (const { balloon, ownerId } of allBalloons) {
    const best = findBestBalloonTarget(state, ownerId, balloonCountPerTarget);
    if (best) {
      balloonCountPerTarget.set(
        best.cannon,
        (balloonCountPerTarget.get(best.cannon) ?? 0) + 1,
      );
      assignments.push({
        balloon,
        ownerId,
        target: best.cannon,
        victimId: best.victimId,
      });
    }
  }

  // Apply hit updates and build flight animations
  for (const { balloon, ownerId, target, victimId } of assignments) {
    target.balloonHits = (target.balloonHits ?? 0) + 1;
    const capturerIds = target.balloonCapturerIds ?? [];
    if (!capturerIds.includes(ownerId)) capturerIds.push(ownerId);
    target.balloonCapturerIds = capturerIds;
    thisRoundTargets.set(target, { victimId });

    const start = cannonCenter(balloon);
    const end = cannonCenter(target);
    flights.push({
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
    });
  }

  resolveBalloonCaptures(state, thisRoundTargets);
  return flights;
}

/** Clean up balloon hit tracking at the end of a battle round.
 *
 *  Order is load-bearing:
 *  1. Delete captured cannons (fully resolved — no longer need tracking)
 *  2. Delete destroyed cannons (dead target — hits are moot)
 *  3. Clear capturerIds on survivors (hit count persists, but next battle
 *     must earn its own capturer credit)
 *
 *  Reordering breaks invariant: clearing capturerIds before deleting captured
 *  would leave stale entries; deleting destroyed before captured would miss
 *  cannons that died from capture-related combat this round.
 */
export function cleanupBalloonHitTrackingAfterBattle(state: GameState): void {
  // 1. Clear balloon state on captured cannons (capture is resolved)
  for (const captured of state.capturedCannons) {
    captured.cannon.balloonHits = undefined;
    captured.cannon.balloonCapturerIds = undefined;
  }

  // 2. Clear balloon state on destroyed cannons (no longer targetable)
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (!isCannonAlive(cannon)) {
        cannon.balloonHits = undefined;
        cannon.balloonCapturerIds = undefined;
      }
    }
  }

  // 3. Clear capturerIds on survivors — hit count persists across battles,
  //    but only the deciding battle's contributors can claim a capture
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (cannon.balloonCapturerIds) cannon.balloonCapturerIds = undefined;
    }
  }
}

/** Snapshot per-player interior territory for battle rendering. Walls are
 *  NOT included — they're drawn separately via `battleWalls`, and
 *  including them here would paint cobblestone under destroyed walls
 *  once the wall sprite/mesh is removed. With walls out of the set, a
 *  destroyed-wall tile falls back to plain grass (its real terrain). */
export function snapshotTerritory(players: readonly Player[]): Set<number>[] {
  return players.map((player) => new Set(getInterior(player)));
}

/**
 * Fire the next ready cannon in round-robin order and return the result.
 * Combines nextReadyCombined lookup + fire dispatch into a single call.
 * @param rotationIdx — current round-robin position (null = start from 0)
 * @returns fired result with updated rotation index, or null if no cannon ready.
 */
export function fireNextReadyCannon(
  state: GameState,
  playerId: ValidPlayerSlot,
  rotationIdx: number | undefined,
  targetRow: number,
  targetCol: number,
): { result: CombinedCannonResult; rotationIdx: number } | null {
  const result = nextReadyCombined(state, playerId, rotationIdx);
  if (!result) return null;
  if (result.type === "own") {
    fireCannon(state, playerId, result.ownIdx, targetRow, targetCol);
  } else {
    fireCapturedCannon(state, result.captured, targetRow, targetCol);
  }
  return { result, rotationIdx: result.combinedIdx };
}

/**
 * Round-robin through own cannons + captured cannons (captured appended at end).
 * Returns the next ready cannon after `after` in the combined index space, or null.
 */
export function nextReadyCombined(
  state: GameViewState & {
    readonly capturedCannons: readonly CapturedCannon[];
    readonly cannonballs: readonly Cannonball[];
  },
  playerId: ValidPlayerSlot,
  after?: number,
): CombinedCannonResult | null {
  const player = state.players[playerId];
  if (!player) return null;
  const ownCount = player.cannons.length;
  const captured = state.capturedCannons.filter(
    (captured) => captured.capturerId === playerId,
  );
  const total = ownCount + captured.length;
  if (total === 0) return null;

  const start = after === undefined ? 0 : (after + 1) % total;
  for (let j = 0; j < total; j++) {
    const i = (start + j) % total;
    if (i < ownCount) {
      if (canFireOwnCannon(state, playerId, i)) {
        return { type: "own", combinedIdx: i, ownIdx: i };
      }
    } else {
      const cannon = captured[i - ownCount]!;
      if (canFireCapturedCannon(state, cannon)) {
        return { type: "captured", combinedIdx: i, captured: cannon };
      }
    }
  }
  return null;
}

/** Network-replay primitive for `BATTLE_MESSAGE.CANNON_FIRED` events.
 *  Host path: `launchCannonball` pushes a ball and emits via `createCannonFiredMsg`. */
export function spawnCannonballFromMessage(
  state: GameState,
  msg: CannonFiredMessage,
): void {
  state.cannonballs.push({
    cannonIdx: msg.cannonIdx,
    startX: msg.startX,
    startY: msg.startY,
    x: msg.startX,
    y: msg.startY,
    targetX: msg.targetX,
    targetY: msg.targetY,
    speed: msg.speed,
    playerId: msg.playerId,
    incendiary: msg.incendiary,
    mortar: msg.mortar,
  });
}

/** Network-replay primitive for `BATTLE_MESSAGE.TOWER_KILLED` events.
 *  Host path: `grunt-system.ts` mutates `state.towerAlive` directly before emitting. */
export function applyTowerKilled(
  state: GameState,
  event: TowerKilledMessage,
): void {
  state.towerAlive[event.towerIdx] = false;
}

function getAnnouncementStep(
  battleCountdown: number,
): AnnouncementStep | undefined {
  if (battleCountdown > COUNTDOWN_READY_SEC) return READY_STEP;
  if (battleCountdown > COUNTDOWN_AIM_SEC) return AIM_STEP;
  if (battleCountdown > 0) return FIRE_STEP;
  return undefined;
}

/**
 * Update all cannonballs. Move them toward their target. On arrival, apply damage.
 * Returns impact positions (for visual effects) and detailed events (for network relay).
 *
 * Private to battle-system — call `tickBattleCombat` from outside this file.
 */
function tickCannonballs(state: GameState, dt: number): CannonballUpdateResult {
  const impacts: TilePos[] = [];
  const events: ImpactEvent[] = [];
  const remaining: Cannonball[] = [];

  for (const ball of state.cannonballs) {
    maybeEmitDescendingWhistle(state, ball);
    const hit = advanceCannonball(ball, dt);
    if (hit) {
      // Ball has arrived — compute and apply impact
      const shooterId = getCannonballScorer(ball);
      if (ball.mortar) {
        // Mortar: 3×3 splash damage + burning pit at center.
        // Deduplicate cannon hits — a multi-tile cannon overlapping several
        // splash tiles must only take one hit per mortar shot.
        // Suppress combo scoring for non-center tiles so a single mortar
        // shot can't inflate wall/grunt streaks from splash alone.
        const hitCannons = new Set<string>();
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const splashRow = hit.row + dr;
            const splashCol = hit.col + dc;
            const isCenter = dr === 0 && dc === 0;
            const splashEvents = computeImpact(
              state,
              splashRow,
              splashCol,
              shooterId,
              isCenter,
            );
            for (const evt of splashEvents) {
              if (evt.type === BATTLE_MESSAGE.CANNON_DAMAGED) {
                const key = `${evt.playerId}:${evt.cannonIdx}`;
                if (hitCannons.has(key)) continue;
                hitCannons.add(key);
              }
              // Only center tile feeds into combo tracker
              applyImpactEvent(state, evt, shooterId, !isCenter);
              events.push(evt);
              state.bus.emit(evt.type, evt);
            }
          }
        }
      } else {
        const impactEvents = computeImpact(
          state,
          hit.row,
          hit.col,
          shooterId,
          ball.incendiary,
        );
        for (const evt of impactEvents) {
          applyImpactEvent(state, evt, shooterId);
          events.push(evt);
          state.bus.emit(evt.type, evt);
        }
        onImpactResolved(
          state,
          shooterId,
          hit.row,
          hit.col,
          impactEvents,
          (bounceRow, bounceCol, hitCannons) => {
            const bounceEvents = computeImpact(
              state,
              bounceRow,
              bounceCol,
              shooterId,
              false,
            );
            for (const evt of bounceEvents) {
              if (evt.type === BATTLE_MESSAGE.CANNON_DAMAGED) {
                const key = `${evt.playerId}:${evt.cannonIdx}`;
                if (hitCannons.has(key)) continue;
                hitCannons.add(key);
              }
              // Ricochet bounces don't feed into combo tracker
              applyImpactEvent(state, evt, shooterId, true);
              events.push(evt);
              state.bus.emit(evt.type, evt);
            }
            impacts.push({ row: bounceRow, col: bounceCol });
          },
        );
      }
      impacts.push(hit);
    } else {
      remaining.push(ball);
    }
  }

  state.cannonballs = remaining;
  tickComboTracking(state, dt);
  return { impacts, events };
}

/**
 * Advance a cannonball by one tick (`dt` seconds). Mutates `ball.x`/`ball.y`.
 * Returns the impact tile position if the ball arrived, or null if still in flight.
 *
 * Shared between host (tickCannonballs) and watcher (tickWatcherBattlePhase)
 * to eliminate drift in speed/arrival logic.
 */
export function advanceCannonball(
  ball: Pick<Cannonball, "x" | "y" | "targetX" | "targetY" | "speed">,
  dt: number,
): TilePos | null {
  const dx = ball.targetX - ball.x;
  const dy = ball.targetY - ball.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) {
    return { row: pxToTile(ball.targetY), col: pxToTile(ball.targetX) };
  }
  const move = ball.speed * dt;
  if (dist <= move) {
    return { row: pxToTile(ball.targetY), col: pxToTile(ball.targetX) };
  }
  ball.x += (dx / dist) * move;
  ball.y += (dy / dist) * move;
  return null;
}

/**
 * Apply a single impact event to game state. Used by both host and watcher.
 *
 * **INTERIOR STALENESS CONTRACT — canonical source of truth.** Battle-phase
 * wall destruction MUST NOT trigger territory/interior recomputation here. The
 * interior stays stale for the entire battle phase and is rebuilt exactly once
 * at the next phase boundary via `recheckTerritory` /
 * `finalizeTerritoryWithScoring` in phase-setup.ts. Every other caller that
 * mutates walls during battle (grunt-system.ts:removeWallFromAllPlayers,
 * impact handlers below, network watcher replays) relies on this invariant —
 * do not add interior recomputation anywhere in the battle hot path, including
 * this function or its helpers.
 *
 * @param shooterId — fallback owner for scoring when event lacks embedded shooterId
 *   (host passes it from the firing loop; network events embed it in the payload).
 */
export function applyImpactEvent(
  state: GameState,
  event: ImpactEvent,
  shooterId?: number,
  suppressCombo?: boolean,
): void {
  // Prefer shooterId from event (network payload) over parameter (host fallback)
  const sid = (
    "shooterId" in event && event.shooterId !== undefined
      ? event.shooterId
      : shooterId
  ) as ValidPlayerSlot | undefined;
  switch (event.type) {
    case BATTLE_MESSAGE.WALL_DESTROYED: {
      const player = state.players[event.playerId];
      if (player) {
        // See applyImpactEvent JSDoc above for the interior-staleness contract.
        deletePlayerWallBattle(player, packTile(event.row, event.col));
        const shooter = sid !== undefined ? state.players[sid] : undefined;
        if (shooter && event.playerId !== sid) {
          shooter.score +=
            DESTROY_WALL_POINTS +
            (suppressCombo ? 0 : scoreImpactCombo(state, COMBO_WALL, sid));
        }
      }
      break;
    }
    case BATTLE_MESSAGE.CANNON_DAMAGED: {
      const cannon = state.players[event.playerId]?.cannons[event.cannonIdx];
      if (cannon) {
        cannon.hp = event.newHp;
        if (!isCannonAlive(cannon)) {
          const shooter = sid !== undefined ? state.players[sid] : undefined;
          if (shooter && event.playerId !== sid) {
            shooter.score +=
              DESTROY_CANNON_POINTS +
              (suppressCombo ? 0 : scoreImpactCombo(state, COMBO_CANNON, sid));
            if (sid !== undefined) onCannonKilled(state, sid);
          }
        }
      }
      break;
    }
    case BATTLE_MESSAGE.PIT_CREATED:
      state.burningPits.push({
        row: event.row,
        col: event.col,
        roundsLeft: event.roundsLeft,
      });
      break;
    case BATTLE_MESSAGE.HOUSE_DESTROYED:
      for (const house of state.map.houses) {
        if (house.alive && isAtTile(house, event.row, event.col)) {
          house.alive = false;
        }
      }
      break;
    case BATTLE_MESSAGE.GRUNT_SPAWNED:
      state.grunts.push({
        row: event.row,
        col: event.col,
        victimPlayerId: event.victimPlayerId,
        blockedRounds: 0,
      });
      break;
    case BATTLE_MESSAGE.GRUNT_KILLED: {
      const shooter = sid !== undefined ? state.players[sid] : undefined;
      state.grunts = state.grunts.filter(
        (grunt) => !isAtTile(grunt, event.row, event.col),
      );
      if (shooter) {
        shooter.score +=
          DESTROY_GRUNT_POINTS +
          (suppressCombo ? 0 : scoreImpactCombo(state, COMBO_GRUNT, sid));
      }
      break;
    }
    case BATTLE_MESSAGE.ICE_THAWED:
      state.modern?.frozenTiles?.delete(packTile(event.row, event.col));
      state.map.mapVersion++;
      break;
    case BATTLE_MESSAGE.WALL_ABSORBED: {
      const player = state.players[event.playerId];
      if (player) player.damagedWalls.add(event.tileKey);
      break;
    }
    case BATTLE_MESSAGE.WALL_SHIELDED: {
      const cannon = state.players[event.playerId]?.cannons[event.cannonIdx];
      // Normalize 0 → undefined so serialization roundtrips are lossless
      if (cannon)
        cannon.shieldHp = event.newShieldHp > 0 ? event.newShieldHp : undefined;
      break;
    }
  }
}

/** Map battleCountdown to the corresponding announcement step (text +
 *  matching bus-event type). Returns a stable const object per step so
 *  callers can compare by identity instead of re-running the threshold
 *  ladder. */
/** Emit `cannonballDescending` once per ball when the remaining travel
 *  time drops below its pre-selected whistle variant's full duration.
 *  The variant was chosen at launch (see `selectWhistleVariant`) such
 *  that the sample's built-in explosion pop lands on impact.
 *  Speed-independent by construction: both the lead and the variant
 *  selection are rooted in time (distance / speed), so rapid-fire and
 *  any future speed upgrade stay in sync automatically. Balls whose
 *  trajectory was too short for any variant got no `whistleVariant`
 *  set at launch and are skipped here. */
function maybeEmitDescendingWhistle(state: GameState, ball: Cannonball): void {
  if (ball.whistled) return;
  if (ball.whistleVariant === undefined) return;
  if (ball.speed <= 0) return;
  const lead = WHISTLE_VARIANT_DURATIONS_SEC[ball.whistleVariant];
  if (lead === undefined) return;
  const dx = ball.targetX - ball.x;
  const dy = ball.targetY - ball.y;
  const distRemaining = Math.sqrt(dx * dx + dy * dy);
  const timeRemaining = distRemaining / ball.speed;
  if (timeRemaining > lead) return;
  ball.whistled = true;
  emitGameEvent(state.bus, GAME_EVENT.CANNONBALL_DESCENDING, {
    variant: ball.whistleVariant,
  });
}

/**
 * Fire a cannonball from a player's cannon toward a target tile (row, col).
 */
function fireCannon(
  state: GameState,
  playerId: ValidPlayerSlot,
  cannonIdx: number,
  targetRow: number,
  targetCol: number,
): boolean {
  if (isPlayerEliminated(state.players[playerId])) return false;
  if (!canFireOwnCannon(state, playerId, cannonIdx)) return false;
  const cannon = state.players[playerId]!.cannons[cannonIdx]!;
  launchCannonball(state, cannon, cannonIdx, playerId, targetRow, targetCol);
  state.shotsFired++;
  const ball = state.cannonballs[state.cannonballs.length - 1]!;
  state.bus.emit(BATTLE_MESSAGE.CANNON_FIRED, createCannonFiredMsg(ball));
  return true;
}

/**
 * Check if a cannon is ready to fire (no ball currently in flight from it).
 */
export function canFireOwnCannon(
  state: GameViewState & {
    readonly capturedCannons: readonly CapturedCannon[];
    readonly cannonballs: readonly Cannonball[];
  },
  playerId: ValidPlayerSlot,
  cannonIdx: number,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  const cannon = player.cannons[cannonIdx];
  if (!cannon || !isCannonAlive(cannon)) return false;
  if (isBalloonCannon(cannon) || isRampartCannon(cannon)) return false;
  // Captured cannons cannot be fired by their original owner
  if (
    state.capturedCannons.some(
      (captured) =>
        captured.cannon === cannon && captured.victimId === playerId,
    )
  )
    return false;
  // Cannon must be inside enclosed territory
  if (!isCannonEnclosed(cannon, player)) return false;
  // Check no ball in flight from this cannon
  return !state.cannonballs.some(
    (b) => b.playerId === playerId && b.cannonIdx === cannonIdx,
  );
}

/** The player who gets credit for this cannonball's effects.
 *  For captured cannons, scoringPlayerId is the capturer (not the cannon's original owner). */
function getCannonballScorer(ball: {
  playerId: ValidPlayerSlot;
  scoringPlayerId?: ValidPlayerSlot;
}): ValidPlayerSlot {
  return ball.scoringPlayerId ?? ball.playerId;
}

function fireCapturedCannon(
  state: GameState,
  captured: CapturedCannon,
  targetRow: number,
  targetCol: number,
): boolean {
  if (!canFireCapturedCannon(state, captured)) return false;
  launchCannonball(
    state,
    captured.cannon,
    captured.cannonIdx,
    captured.victimId,
    targetRow,
    targetCol,
    captured.capturerId,
  );
  state.shotsFired++;
  const ball = state.cannonballs[state.cannonballs.length - 1]!;
  state.bus.emit(BATTLE_MESSAGE.CANNON_FIRED, createCannonFiredMsg(ball));
  return true;
}

/**
 * Build and push a cannonball from a cannon toward a target tile.
 * Updates cannon facing. Used by all three firing paths.
 */
function launchCannonball(
  state: GameState,
  cannon: Cannon,
  cannonIdx: number,
  playerId: ValidPlayerSlot,
  targetRow: number,
  targetCol: number,
  scoringPlayerId?: ValidPlayerSlot,
): void {
  const { x: startX, y: startY } = cannonCenter(cannon);
  const initialTargetX = (targetCol + TILE_CENTER_OFFSET) * TILE_SIZE;
  const initialTargetY = (targetRow + TILE_CENTER_OFFSET) * TILE_SIZE;
  const { x: finalTargetX, y: finalTargetY } = applyDustStormJitter(
    state,
    startX,
    startY,
    initialTargetX,
    initialTargetY,
  );
  cannon.facing = Math.atan2(finalTargetX - startX, -(finalTargetY - startY));
  const isMortar = !!cannon.mortar;
  const speedMult = ballSpeedMult(state.players[playerId]!, isMortar);
  const speed = BALL_SPEED * speedMult;
  const totalDx = finalTargetX - startX;
  const totalDy = finalTargetY - startY;
  const totalTravelSec =
    Math.sqrt(totalDx * totalDx + totalDy * totalDy) / speed;
  const whistleVariant = selectWhistleVariant(state, totalTravelSec);
  state.cannonballs.push({
    cannonIdx,
    startX,
    startY,
    x: startX,
    y: startY,
    targetX: finalTargetX,
    targetY: finalTargetY,
    speed,
    playerId,
    scoringPlayerId,
    incendiary: isSuperCannon(cannon) ? true : undefined,
    mortar: isMortar || undefined,
    whistleVariant,
  });
}

/** Pick a random whistle variant whose duration fits in the ball's total
 *  travel time, drawn from state.rng for determinism. Returns undefined
 *  when the shot is too short for any variant — caller then stores no
 *  whistle id on the ball. */
function selectWhistleVariant(
  state: GameState,
  totalTravelSec: number,
): number | undefined {
  const eligible: number[] = [];
  for (let i = 0; i < WHISTLE_VARIANT_DURATIONS_SEC.length; i += 1) {
    if (WHISTLE_VARIANT_DURATIONS_SEC[i]! <= totalTravelSec) eligible.push(i);
  }
  if (eligible.length === 0) return undefined;
  return state.rng.pick(eligible);
}

/** Check if a captured cannon is ready to fire (not destroyed, no ball in flight).
 *  Fewer checks than canFireOwnCannon() because captured cannons are pre-validated at capture time:
 *  - No player/cannon existence check (CapturedCannon holds direct references)
 *  - No balloon check (balloons can't be captured)
 *  - No enclosure check (irrelevant — capturer fires from victim's position)
 *  - No "already captured" check (it IS the captured entry) */
function canFireCapturedCannon(
  state: { readonly cannonballs: readonly Cannonball[] },
  captured: CapturedCannon,
): boolean {
  if (!isCannonAlive(captured.cannon)) return false;
  if (captured.cannonIdx === CANNON_NOT_FOUND) return false;
  return !state.cannonballs.some(
    (b) =>
      b.playerId === captured.victimId && b.cannonIdx === captured.cannonIdx,
  );
}

/**
 * Compute impact events at a tile position (no state mutation except RNG consumption).
 * Returns events describing what should happen: wall destroyed, wall absorbed,
 * cannon damaged, etc. All state mutations happen in applyImpactEvent.
 *
 * Collector order matters — adding a new impact type:
 *   1. collectWallImpacts must run first (its `hitWall` return gates incendiary pit creation)
 *   2. collectCannonImpacts is independent
 *   3. PIT_CREATED depends on step 1's hitWall + incendiary flag
 *   4. collectHouseImpacts / collectGruntImpacts are independent
 *   5. collectFrozenWaterImpacts is independent (modern mode only)
 * New collectors that don't depend on hitWall can go after step 3.
 */
function computeImpact(
  state: GameState,
  row: number,
  col: number,
  shooterId: ValidPlayerSlot,
  incendiary?: boolean,
): ImpactEvent[] {
  if (!inBounds(row, col)) return [];
  const key = packTile(row, col);

  // Step 1: walls (must be first — hitWall gates incendiary pit below)
  const { events: wallEvents, hitWall } = collectWallImpacts(
    state,
    key,
    row,
    col,
    shooterId,
  );
  // Step 2: cannons (independent)
  const cannonEvents = collectCannonImpacts(state, row, col, shooterId);

  // Step 3: incendiary pit (depends on hitWall from step 1)
  const pitEvents: ImpactEvent[] =
    incendiary && hitWall && !hasPitAt(state.burningPits, row, col)
      ? [
          {
            type: BATTLE_MESSAGE.PIT_CREATED,
            row,
            col,
            roundsLeft: BURNING_PIT_DURATION,
          },
        ]
      : [];

  // Step 4: houses and grunts (independent — towers NOT damaged by cannonballs)
  const houseEvents = collectHouseImpacts(state, row, col);
  const gruntEvents = collectGruntImpacts(state, row, col, shooterId);

  // Step 5: frozen water thaw (independent — modern mode only)
  const iceEvents = collectFrozenWaterImpacts(state, row, col);

  return [
    ...wallEvents,
    ...cannonEvents,
    ...pitEvents,
    ...houseEvents,
    ...gruntEvents,
    ...iceEvents,
  ];
}

/** Collect wall destruction events at a tile. Returns events and whether any wall was hit. */
function collectWallImpacts(
  state: GameState,
  key: number,
  row: number,
  col: number,
  shooterId: ValidPlayerSlot,
): { events: ImpactEvent[]; hitWall: boolean } {
  const events: ImpactEvent[] = [];
  const result = resolveWallShield(state, row, col, key);
  if (result === null) return { events, hitWall: false };
  if (result.absorbed && result.kind === ShieldKind.Reinforced) {
    // Reinforced Walls: wall survives, no pit (hitWall stays false).
    events.push({
      type: BATTLE_MESSAGE.WALL_ABSORBED,
      playerId: result.playerId,
      tileKey: result.tileKey,
    });
    return { events, hitWall: false };
  }
  if (result.absorbed && result.kind === ShieldKind.Rampart) {
    events.push({
      type: BATTLE_MESSAGE.WALL_SHIELDED,
      playerId: result.playerId,
      cannonIdx: result.cannonIdx,
      newShieldHp: result.newShieldHp,
    });
    return { events, hitWall: false };
  }
  events.push({
    type: BATTLE_MESSAGE.WALL_DESTROYED,
    row,
    col,
    playerId: result.playerId,
    shooterId,
  });
  return { events, hitWall: true };
}

/** Collect cannon damage events at a tile. */
function collectCannonImpacts(
  state: GameState,
  row: number,
  col: number,
  shooterId: ValidPlayerSlot,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  for (const player of state.players) {
    for (let cannonIdx = 0; cannonIdx < player.cannons.length; cannonIdx++) {
      const cannon = player.cannons[cannonIdx]!;
      if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
      if (cannon.shielded) continue;
      if (isCannonTile(cannon, row, col)) {
        events.push({
          type: BATTLE_MESSAGE.CANNON_DAMAGED,
          playerId: player.id,
          cannonIdx,
          newHp: cannon.hp - 1,
          shooterId,
        });
      }
    }
  }
  return events;
}

/** Collect house destruction + grunt spawn events at a tile. */
function collectHouseImpacts(
  state: GameState,
  row: number,
  col: number,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  for (const house of state.map.houses) {
    if (house.alive && isAtTile(house, row, col)) {
      events.push({ type: BATTLE_MESSAGE.HOUSE_DESTROYED, row, col });
      // Grunt spawn is RNG-based — compute it here so the host decides
      if (state.rng.bool(HOUSE_GRUNT_SPAWN_CHANCE)) {
        const spawnPos = findGruntSpawnNear(state, row, col);
        if (spawnPos) {
          events.push({
            type: BATTLE_MESSAGE.GRUNT_SPAWNED,
            row: spawnPos.row,
            col: spawnPos.col,
            victimPlayerId: zoneOwnerIdAt(state, spawnPos.row, spawnPos.col),
          });
        }
      }
    }
  }
  return events;
}

/** Collect grunt kill events at a tile.
 *  Conscription: killed grunts have a chance to respawn on a random enemy zone. */
function collectGruntImpacts(
  state: GameState,
  row: number,
  col: number,
  shooterId: ValidPlayerSlot,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  for (const grunt of state.grunts) {
    if (isAtTile(grunt, row, col)) {
      events.push({
        type: BATTLE_MESSAGE.GRUNT_KILLED,
        row: grunt.row,
        col: grunt.col,
        shooterId,
      });
      const respawn = onGruntKilled(state, shooterId);
      if (respawn) {
        const spawnPos = findGruntSpawnNear(
          state,
          respawn.anchorRow,
          respawn.anchorCol,
        );
        if (spawnPos) {
          events.push({
            type: BATTLE_MESSAGE.GRUNT_SPAWNED,
            row: spawnPos.row,
            col: spawnPos.col,
            victimPlayerId: respawn.victimId,
          });
        }
      }
    }
  }
  return events;
}

/** Collect frozen water thaw events at a tile (modern mode only).
 *  A cannonball hitting a frozen water tile thaws it, reverting it to
 *  impassable water. Grunts standing on the tile are already killed by
 *  collectGruntImpacts (runs earlier in the collector chain). */
function collectFrozenWaterImpacts(
  state: GameState,
  row: number,
  col: number,
): ImpactEvent[] {
  if (!state.modern?.frozenTiles) return [];
  const key = packTile(row, col);
  if (!state.modern.frozenTiles.has(key)) return [];
  if (!isWater(state.map.tiles, row, col)) return [];
  return [{ type: BATTLE_MESSAGE.ICE_THAWED, row, col }];
}

/** Collect all active balloons across all players. */
function collectAllBalloons(
  state: GameState,
): { balloon: Cannon; ownerId: ValidPlayerSlot }[] {
  const result: { balloon: Cannon; ownerId: ValidPlayerSlot }[] = [];
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    for (const c of player.cannons) {
      if (isBalloonCannon(c) && isCannonAlive(c) && isCannonEnclosed(c, player))
        result.push({ balloon: c, ownerId: player.id });
    }
  }
  return result;
}

/** Find the best enemy cannon target for a balloon owned by ownerId. */
function findBestBalloonTarget(
  state: GameState,
  ownerId: ValidPlayerSlot,
  balloonCountPerTarget: Map<Cannon, number>,
): { cannon: Cannon; victimId: ValidPlayerSlot } | null {
  let bestCannon: Cannon | undefined;
  let bestVictimId = VICTIM_ID_UNKNOWN;
  let bestScore = -1;

  for (const other of filterActiveEnemies(state, ownerId)) {
    for (const cannon of filterActiveFiringCannons(other)) {
      const needed = balloonHitThreshold(cannon);
      const prevHits = cannon.balloonHits ?? 0;
      const roundHits = balloonCountPerTarget.get(cannon) ?? 0;
      if (prevHits + roundHits >= needed) continue;
      if (!isCannonEnclosed(cannon, other)) continue;
      // Threat score: super guns ~10x boost via SUPER_GUN_THREAT_WEIGHT, tie-broken by HP.
      const score =
        (isSuperCannon(cannon) ? SUPER_GUN_THREAT_WEIGHT : 0) + cannon.hp;
      if (score > bestScore) {
        bestScore = score;
        bestCannon = cannon;
        bestVictimId = other.id;
      }
    }
  }

  return bestCannon
    ? { cannon: bestCannon, victimId: bestVictimId as ValidPlayerSlot }
    : null;
}

/** Resolve balloon captures from accumulated hits. */
function resolveBalloonCaptures(
  state: GameState,
  thisRoundTargets: Map<Cannon, { victimId: ValidPlayerSlot }>,
): void {
  state.capturedCannons = [];
  for (const player of state.players) {
    for (let cannonIdx = 0; cannonIdx < player.cannons.length; cannonIdx++) {
      const cannon = player.cannons[cannonIdx]!;
      const hits = cannon.balloonHits ?? 0;
      if (hits < balloonHitThreshold(cannon)) continue;
      const capturerIds = cannon.balloonCapturerIds ?? [];
      if (capturerIds.length === 0) continue;
      const target = thisRoundTargets.get(cannon);
      const victimId = target?.victimId ?? player.id;
      const winnerId = state.rng.pick(capturerIds);
      state.capturedCannons.push({
        cannon,
        cannonIdx,
        victimId: victimId as ValidPlayerSlot,
        capturerId: winnerId as ValidPlayerSlot,
      });
    }
  }
}

/** Number of balloon hits required to capture a cannon (super guns need more). */
function balloonHitThreshold(cannon: Cannon): number {
  return isSuperCannon(cannon)
    ? SUPER_BALLOON_HITS_NEEDED
    : BALLOON_HITS_NEEDED;
}
