/**
 * Battle system — cannon firing, cannonball physics, impacts, and balloon capture.
 */

import {
  type CannonFiredMessage,
  type ImpactEvent,
  MESSAGE,
} from "../../server/protocol.ts";
import type {
  BalloonFlight,
  Cannon,
  Cannonball,
  CapturedCannon,
  CombinedCannonResult,
  Crosshair,
} from "../shared/battle-types.ts";
import {
  deletePlayerWallBattle,
  filterActiveEnemies,
  getInterior,
  zoneOwnerIdAt,
} from "../shared/board-occupancy.ts";
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
} from "../shared/game-constants.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { Player } from "../shared/player-types.ts";
import {
  cannonCenter,
  computeFacing45,
  hasPitAt,
  inBounds,
  isAtTile,
  isBalloonCannon,
  isCannonAlive,
  isCannonTile,
  isSuperCannon,
  isWater,
  packTile,
  pxToTile,
  rotateToward,
  TILE_CENTER_OFFSET,
} from "../shared/spatial.ts";
import type {
  BattleController,
  ControllerIdentity,
  GameViewState,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../shared/upgrade-defs.ts";
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
import { findGruntSpawnNear } from "./grunt-system.ts";

/** Result of tickCannonballs: impact positions (for VFX) + detailed events (for network). */
interface CannonballUpdateResult {
  impacts: TilePos[];
  events: ImpactEvent[];
}

/** Cannon barrel rotation speed: 3π rad/s ≈ 540°/s.
 *  Tuned for snappy visual feedback — cannons should visually track
 *  the crosshair with minimal lag but not feel instant. */
const CANNON_ROTATE_SPEED = Math.PI * 3;
/** Countdown thresholds for battle announcement phases:
 *    > 3s → "Ready"   |   1–3s → "Aim"   |   ≤ 1s → "FIRE!" */
const COUNTDOWN_READY_SEC = 3;
const COUNTDOWN_AIM_SEC = 1;
/** Cannonball speed multiplier when the Rapid Fire upgrade is active. */
const RAPID_FIRE_SPEED_MULT = 1.5;
/** Mortar cannonball speed multiplier (half speed). */
const MORTAR_SPEED_MULT = 0.5;
/** Number of random bounces after a ricochet impact. */
const RICOCHET_BOUNCES = 2;
/** Max Chebyshev distance for each successive bounce (decays to simulate energy loss). */
const RICOCHET_RADII: readonly number[] = [5, 3];
const SALVAGE_CAP = 2;
/** Sentinel: no target found (used for victimId lookups). */
const VICTIM_ID_UNKNOWN = -1;
/** Sentinel: cannon index not found in victim's array. */
const CANNON_NOT_FOUND = -1;

/** Map battleCountdown to the corresponding announcement text. */
export function getCountdownAnnouncement(
  battleCountdown: number,
): string | undefined {
  if (battleCountdown > COUNTDOWN_READY_SEC) return "Ready";
  if (battleCountdown > COUNTDOWN_AIM_SEC) return "Aim";
  if (battleCountdown > 0) return "Fire!";
  return undefined;
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
    const target = computeFacing45(ox, oy, cx, cy);
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
 * Update all cannonballs. Move them toward their target. On arrival, apply damage.
 * Returns impact positions (for visual effects) and detailed events (for network relay).
 */
export function tickCannonballs(
  state: GameState,
  dt: number,
): CannonballUpdateResult {
  const impacts: TilePos[] = [];
  const events: ImpactEvent[] = [];
  const remaining: Cannonball[] = [];

  for (const ball of state.cannonballs) {
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
        const savedTracker = state.modern?.comboTracker ?? null;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const splashRow = hit.row + dr;
            const splashCol = hit.col + dc;
            const isCenter = dr === 0 && dc === 0;
            // Only center tile feeds into combo tracker
            if (!isCenter && state.modern) {
              state.modern.comboTracker = null;
            }
            const splashEvents = computeImpact(
              state,
              splashRow,
              splashCol,
              shooterId,
              isCenter,
            );
            for (const evt of splashEvents) {
              if (evt.type === MESSAGE.CANNON_DAMAGED) {
                const key = `${evt.playerId}:${evt.cannonIdx}`;
                if (hitCannons.has(key)) continue;
                hitCannons.add(key);
              }
              applyImpactEvent(state, evt, shooterId);
              events.push(evt);
            }
            if (!isCenter && state.modern) {
              state.modern.comboTracker = savedTracker;
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
        }
        // Ricochet: 2 additional bounces at random nearby positions
        if (state.players[shooterId]?.upgrades.get(UID.RICOCHET)) {
          const hitCannons = new Set<string>();
          for (const evt of impactEvents) {
            if (evt.type === MESSAGE.CANNON_DAMAGED) {
              hitCannons.add(`${evt.playerId}:${evt.cannonIdx}`);
            }
          }
          const savedTracker = state.modern?.comboTracker ?? null;
          let bounceRow = hit.row;
          let bounceCol = hit.col;
          for (let bounce = 0; bounce < RICOCHET_BOUNCES; bounce++) {
            const radius = RICOCHET_RADII[bounce]!;
            const span = radius * 2 + 1;
            let dr: number;
            let dc: number;
            do {
              dr = Math.floor(state.rng.next() * span) - radius;
              dc = Math.floor(state.rng.next() * span) - radius;
            } while (dr === 0 && dc === 0);
            bounceRow = Math.max(0, Math.min(bounceRow + dr, GRID_ROWS - 1));
            bounceCol = Math.max(0, Math.min(bounceCol + dc, GRID_COLS - 1));
            if (state.modern) state.modern.comboTracker = null;
            const bounceEvents = computeImpact(
              state,
              bounceRow,
              bounceCol,
              shooterId,
              false,
            );
            for (const evt of bounceEvents) {
              if (evt.type === MESSAGE.CANNON_DAMAGED) {
                const key = `${evt.playerId}:${evt.cannonIdx}`;
                if (hitCannons.has(key)) continue;
                hitCannons.add(key);
              }
              applyImpactEvent(state, evt, shooterId);
              events.push(evt);
            }
            if (state.modern) state.modern.comboTracker = savedTracker;
            impacts.push({ row: bounceRow, col: bounceCol });
          }
        }
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
 * IMPORTANT: This function does NOT recompute territory/interior after wall
 * destruction. Interior is intentionally left stale during battle — it will
 * be recomputed at the next phase boundary (recheckTerritoryOnly / finalizeTerritoryWithScoring).
 * Do not add interior recomputation here.
 *
 * @param shooterId — fallback owner for scoring when event lacks embedded shooterId
 *   (host passes it from the firing loop; network events embed it in the payload).
 */
export function applyImpactEvent(
  state: GameState,
  event: ImpactEvent,
  shooterId?: number,
): void {
  // Interior is intentionally left stale during battle — recomputed at the next
  // phase boundary (recheckTerritoryOnly / finalizeTerritoryWithScoring). This function does NOT
  // recompute territory, so impacts during non-battle phases (e.g. test harness,
  // watcher replaying host events) won't corrupt interior unless callers assume
  // interior is fresh afterward. Do not add interior recomputation here.
  // Prefer shooterId from event (network payload) over parameter (host fallback)
  const sid = (
    "shooterId" in event && event.shooterId !== undefined
      ? event.shooterId
      : shooterId
  ) as ValidPlayerSlot | undefined;
  switch (event.type) {
    case MESSAGE.WALL_DESTROYED: {
      const player = state.players[event.playerId];
      if (player) {
        // Interior intentionally stale during battle; recheckTerritoryOnly() runs at next build phase.
        deletePlayerWallBattle(player, packTile(event.row, event.col));
        const shooter = sid !== undefined ? state.players[sid] : undefined;
        if (shooter && event.playerId !== sid) {
          shooter.score +=
            DESTROY_WALL_POINTS + scoreImpactCombo(state, COMBO_WALL, sid);
        }
      }
      break;
    }
    case MESSAGE.CANNON_DAMAGED: {
      const cannon = state.players[event.playerId]?.cannons[event.cannonIdx];
      if (cannon) {
        cannon.hp = event.newHp;
        if (!isCannonAlive(cannon)) {
          const shooter = sid !== undefined ? state.players[sid] : undefined;
          if (shooter && event.playerId !== sid) {
            shooter.score +=
              DESTROY_CANNON_POINTS +
              scoreImpactCombo(state, COMBO_CANNON, sid);
            if (sid !== undefined && isSalvageActive(state)) {
              state.salvageSlots[sid] = Math.min(
                (state.salvageSlots[sid] ?? 0) + 1,
                SALVAGE_CAP,
              );
            }
          }
        }
      }
      break;
    }
    case MESSAGE.PIT_CREATED:
      state.burningPits.push({
        row: event.row,
        col: event.col,
        roundsLeft: event.roundsLeft,
      });
      break;
    case MESSAGE.HOUSE_DESTROYED:
      for (const house of state.map.houses) {
        if (house.alive && isAtTile(house, event.row, event.col)) {
          house.alive = false;
        }
      }
      break;
    case MESSAGE.GRUNT_SPAWNED:
      state.grunts.push({
        row: event.row,
        col: event.col,
        victimPlayerId: event.victimPlayerId,
        blockedRounds: 0,
      });
      break;
    case MESSAGE.GRUNT_KILLED: {
      const shooter = sid !== undefined ? state.players[sid] : undefined;
      state.grunts = state.grunts.filter(
        (grunt) => !isAtTile(grunt, event.row, event.col),
      );
      if (shooter) {
        shooter.score +=
          DESTROY_GRUNT_POINTS + scoreImpactCombo(state, COMBO_GRUNT, sid);
      }
      break;
    }
    case MESSAGE.ICE_THAWED:
      state.modern?.frozenTiles?.delete(packTile(event.row, event.col));
      break;
  }
}

/**
 * Resolve all placed propaganda balloons at the CANNON_PLACE → BATTLE transition.
 * For each balloon, find the "most dangerous" enemy cannon and capture it.
 * Returns flight paths for animation.
 *
 * Balloon hit lifecycle (persistent counts, per-battle capturers):
 *   - state.balloonHits.count accumulates across battles — a cannon that
 *     survives multiple rounds keeps its prior hit count toward capture.
 *   - state.balloonHits.capturerIds tracks which players contributed hits
 *     THIS battle only — cleared each round by cleanupBalloonHitTrackingAfterBattle()
 *     so only the deciding battle's contributors can claim the capture.
 *   - Entries are deleted when a cannon is captured or destroyed.
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
    const entry = state.balloonHits.get(target) ?? {
      count: 0,
      capturerIds: [] as number[],
    };
    entry.count++;
    if (!entry.capturerIds.includes(ownerId)) entry.capturerIds.push(ownerId);
    state.balloonHits.set(target, entry);
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
  // 1. Remove entries for captured cannons (capture is resolved)
  for (const captured of state.capturedCannons) {
    state.balloonHits.delete(captured.cannon);
  }

  // 2. Remove entries for destroyed cannons (no longer targetable)
  for (const [cannon] of state.balloonHits) {
    if (!isCannonAlive(cannon)) state.balloonHits.delete(cannon);
  }

  // 3. Clear capturerIds for survivors — hit count persists across battles,
  //    but only the deciding battle's contributors can claim a capture
  for (const [, hit] of state.balloonHits) {
    hit.capturerIds = [];
  }
}

/** Create a CANNON_FIRED message from a cannonball's launch data. */
export function createCannonFiredMsg(ball: {
  playerId: ValidPlayerSlot;
  cannonIdx: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  speed: number;
  incendiary?: boolean;
  mortar?: boolean;
}): CannonFiredMessage {
  return {
    type: MESSAGE.CANNON_FIRED,
    playerId: ball.playerId,
    cannonIdx: ball.cannonIdx,
    startX: ball.startX,
    startY: ball.startY,
    targetX: ball.targetX,
    targetY: ball.targetY,
    speed: ball.speed,
    incendiary: ball.incendiary ? true : undefined,
    mortar: ball.mortar ? true : undefined,
  };
}

/** Snapshot per-player territory (interior + walls) for battle rendering. */
export function snapshotTerritory(players: readonly Player[]): Set<number>[] {
  return players.map((player) => {
    const combined = new Set(getInterior(player));
    for (const key of player.walls) combined.add(key);
    return combined;
  });
}

/** Collect crosshairs from local controllers. */
export function collectLocalCrosshairs<
  T extends ControllerIdentity & BattleController = ControllerIdentity &
    BattleController,
>(params: {
  state: GameState;
  controllers: T[];
  canFireNow: boolean;
  skipController?: (playerId: ValidPlayerSlot) => boolean;
  onCrosshairCollected?: (
    ctrl: T,
    ch: { x: number; y: number },
    readyCannon: boolean,
  ) => void;
}): Crosshair[] {
  const {
    state,
    controllers,
    canFireNow,
    skipController,
    onCrosshairCollected,
  } = params;
  const crosshairs: Crosshair[] = [];

  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    // Check if any cannon (own or captured) can fire right now
    const readyCannon = nextReadyCombined(state, ctrl.playerId);
    // If none ready, check if any ball is in flight (own or captured) — still reloading
    const anyReloading =
      !readyCannon &&
      state.cannonballs.some(
        (b) =>
          b.playerId === ctrl.playerId || b.scoringPlayerId === ctrl.playerId,
      );
    // Hide crosshair only when nothing can fire and nothing is reloading
    if (!readyCannon && !anyReloading) continue;
    const ch = ctrl.getCrosshair();
    crosshairs.push({
      x: ch.x,
      y: ch.y,
      playerId: ctrl.playerId,
      cannonReady: canFireNow && !!readyCannon,
    });
    onCrosshairCollected?.(ctrl, ch, !!readyCannon);
  }

  return crosshairs;
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
    fireSingleCaptured(state, result.captured, targetRow, targetCol);
  }
  return { result, rotationIdx: result.combinedIdx };
}

/**
 * Fire a cannonball from a player's cannon toward a target tile (row, col).
 */
export function fireCannon(
  state: GameState,
  playerId: ValidPlayerSlot,
  cannonIdx: number,
  targetRow: number,
  targetCol: number,
): boolean {
  if (state.players[playerId]?.eliminated) return false;
  if (!canFireOwnCannon(state, playerId, cannonIdx)) return false;
  const cannon = state.players[playerId]!.cannons[cannonIdx]!;
  launchCannonball(state, cannon, cannonIdx, playerId, targetRow, targetCol);
  state.shotsFired++;
  return true;
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
  if (isBalloonCannon(cannon)) return false;
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

/**
 * Fire a single captured cannon at a target tile. Returns true if fired.
 */
function fireSingleCaptured(
  state: GameState,
  captured: CapturedCannon,
  targetRow: number,
  targetCol: number,
): boolean {
  return fireCapturedCannon(state, captured, targetRow, targetCol);
}

/** The player who gets credit for this cannonball's effects.
 *  For captured cannons, scoringPlayerId is the capturer (not the cannon's original owner). */
function getCannonballScorer(ball: {
  playerId: ValidPlayerSlot;
  scoringPlayerId?: number;
}): number {
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
  scoringPlayerId?: number,
): void {
  const { x: startX, y: startY } = cannonCenter(cannon);
  const targetX = (targetCol + TILE_CENTER_OFFSET) * TILE_SIZE;
  const targetY = (targetRow + TILE_CENTER_OFFSET) * TILE_SIZE;
  cannon.facing = computeFacing45(startX, startY, targetX, targetY);
  const hasRapidFire = !!state.players[playerId]?.upgrades.get(UID.RAPID_FIRE);
  const isMortar = !!cannon.mortar;
  // Rapid Fire + Mortar cancel out on speed (normal speed mortar shots)
  let speedMult = 1;
  if (isMortar && hasRapidFire) speedMult = 1;
  else if (isMortar) speedMult = MORTAR_SPEED_MULT;
  else if (hasRapidFire) speedMult = RAPID_FIRE_SPEED_MULT;
  state.cannonballs.push({
    cannonIdx,
    startX,
    startY,
    x: startX,
    y: startY,
    targetX,
    targetY,
    speed: BALL_SPEED * speedMult,
    playerId,
    scoringPlayerId,
    incendiary: isSuperCannon(cannon) ? true : undefined,
    mortar: isMortar || undefined,
  });
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
 * Compute impact events at a tile position (pure — no state mutation).
 * Returns events describing what should happen: wall destroyed, cannon damaged, etc.
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
  shooterId: number,
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
            type: MESSAGE.PIT_CREATED,
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
  shooterId: number,
): { events: ImpactEvent[]; hitWall: boolean } {
  const events: ImpactEvent[] = [];
  let hitWall = false;
  for (const player of state.players) {
    if (player.walls.has(key)) {
      // Reinforced Walls: first hit is absorbed, wall survives (no pit either)
      if (
        player.upgrades.get(UID.REINFORCED_WALLS) &&
        !player.damagedWalls.has(key)
      ) {
        player.damagedWalls.add(key);
        continue;
      }
      hitWall = true;
      events.push({
        type: MESSAGE.WALL_DESTROYED,
        row,
        col,
        playerId: player.id,
        shooterId,
      });
    }
  }
  return { events, hitWall };
}

/** Collect cannon damage events at a tile. */
function collectCannonImpacts(
  state: GameState,
  row: number,
  col: number,
  shooterId: number,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  for (const player of state.players) {
    for (let cannonIdx = 0; cannonIdx < player.cannons.length; cannonIdx++) {
      const cannon = player.cannons[cannonIdx]!;
      if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        events.push({
          type: MESSAGE.CANNON_DAMAGED,
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
      events.push({ type: MESSAGE.HOUSE_DESTROYED, row, col });
      // Grunt spawn is RNG-based — compute it here so the host decides
      if (state.rng.bool(HOUSE_GRUNT_SPAWN_CHANCE)) {
        const spawnPos = findGruntSpawnNear(state, row, col);
        if (spawnPos) {
          events.push({
            type: MESSAGE.GRUNT_SPAWNED,
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

/** Collect grunt kill events at a tile. */
function collectGruntImpacts(
  state: GameState,
  row: number,
  col: number,
  shooterId: number,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  for (const grunt of state.grunts) {
    if (isAtTile(grunt, row, col)) {
      events.push({
        type: MESSAGE.GRUNT_KILLED,
        row: grunt.row,
        col: grunt.col,
        shooterId,
      });
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
  return [{ type: MESSAGE.ICE_THAWED, row, col }];
}

/** Collect all active balloons across all players. */
function collectAllBalloons(
  state: GameState,
): { balloon: Cannon; ownerId: ValidPlayerSlot }[] {
  const result: { balloon: Cannon; ownerId: ValidPlayerSlot }[] = [];
  for (const player of state.players) {
    if (player.eliminated) continue;
    for (const c of player.cannons) {
      if (isBalloonCannon(c) && isCannonAlive(c))
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
      const prevHits = state.balloonHits.get(cannon)?.count ?? 0;
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
  for (const [cannon, hit] of state.balloonHits) {
    const needed = balloonHitThreshold(cannon);
    if (hit.count >= needed) {
      const target = thisRoundTargets.get(cannon);
      let victimId: ValidPlayerSlot | number =
        target?.victimId ?? VICTIM_ID_UNKNOWN;
      if (victimId === VICTIM_ID_UNKNOWN) {
        for (const player of state.players) {
          if (player.cannons.includes(cannon)) {
            victimId = player.id;
            break;
          }
        }
      }
      const winnerId = state.rng.pick(hit.capturerIds);
      const cannonIdx =
        state.players[victimId]?.cannons.indexOf(cannon) ?? CANNON_NOT_FOUND;
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

function isSalvageActive(state: GameState): boolean {
  return isGlobalUpgradeActive(state.players, UID.SALVAGE);
}
