/**
 * Battle system — cannon firing, cannonball physics, impacts, and balloon capture.
 */

import { MESSAGE } from "../server/protocol.ts";
import { filterActiveEnemies } from "./board-occupancy.ts";
import {
  filterActiveFiringCannons,
  isCannonEnclosed,
} from "./cannon-system.ts";
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
} from "./game-constants.ts";
import type { TilePos } from "./geometry-types.ts";
import { TILE_SIZE } from "./grid.ts";
import { findGruntSpawnNear } from "./grunt-system.ts";
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
  packTile,
  pxToTile,
  rotateToward,
  TILE_CENTER_OFFSET,
} from "./spatial.ts";
import type {
  BalloonFlight,
  Cannon,
  Cannonball,
  CapturedCannon,
  CombinedCannonResult,
  GameState,
} from "./types.ts";

/** An event emitted by applyImpact for network relay. */
export type ImpactEvent =
  | {
      type: typeof MESSAGE.WALL_DESTROYED;
      row: number;
      col: number;
      playerId: number;
      shooterId?: number;
    }
  | {
      type: typeof MESSAGE.CANNON_DAMAGED;
      playerId: number;
      cannonIdx: number;
      newHp: number;
      shooterId?: number;
    }
  | { type: typeof MESSAGE.HOUSE_DESTROYED; row: number; col: number }
  | {
      type: typeof MESSAGE.GRUNT_KILLED;
      row: number;
      col: number;
      shooterId?: number;
    }
  | {
      type: typeof MESSAGE.GRUNT_SPAWNED;
      row: number;
      col: number;
      targetPlayerId: number;
    }
  | {
      type: typeof MESSAGE.PIT_CREATED;
      row: number;
      col: number;
      roundsLeft: number;
    };

/** Result of tickCannonballs: impact positions (for VFX) + detailed events (for network). */
interface CannonballUpdateResult {
  impacts: TilePos[];
  events: ImpactEvent[];
}

/** Cannon rotation speed in radians per second. */
const CANNON_ROTATE_SPEED = Math.PI * 3;
/** Countdown thresholds for battle announcement phases:
 *    > 3s → "Ready"   |   1–3s → "Aim"   |   ≤ 1s → "FIRE!" */
const COUNTDOWN_READY = 3;
const COUNTDOWN_AIM = 1;

/** Map battleCountdown to the corresponding announcement text. */
export function getCountdownAnnouncement(
  battleCountdown: number,
): string | undefined {
  if (battleCountdown > COUNTDOWN_READY) return "Ready";
  if (battleCountdown > COUNTDOWN_AIM) return "Aim";
  if (battleCountdown > 0) return "Fire!";
  return undefined;
}

/**
 * Fire a cannonball from a player's cannon toward a target tile (row, col).
 */
export function fireCannon(
  state: GameState,
  playerId: number,
  cannonIdx: number,
  targetRow: number,
  targetCol: number,
): boolean {
  if (!canFire(state, playerId, cannonIdx)) return false;
  const cannon = state.players[playerId]!.cannons[cannonIdx]!;
  launchCannonball(state, cannon, cannonIdx, playerId, targetRow, targetCol);
  state.shotsFired++;
  return true;
}

/** Whether a player has a cannon ready to fire or a cannonball in flight. */
export function canPlayerFire(state: GameState, playerId: number): boolean {
  if (nextReadyCombined(state, playerId)) return true;
  return state.cannonballs.some(
    (b) => b.playerId === playerId || b.scoringPlayerId === playerId,
  );
}

/**
 * Round-robin through own cannons + captured cannons (captured appended at end).
 * Returns the next ready cannon after `after` in the combined index space, or null.
 */
export function nextReadyCombined(
  state: GameState,
  playerId: number,
  after: number = -1 /* -1 = start from beginning (no previous cannon) */,
): CombinedCannonResult | null {
  const player = state.players[playerId];
  if (!player) return null;
  const ownCount = player.cannons.length;
  const captured = state.capturedCannons.filter(
    (cc) => cc.capturerId === playerId,
  );
  const total = ownCount + captured.length;
  if (total === 0) return null;

  for (let j = 0; j < total; j++) {
    const i = (after + 1 + j) % total;
    if (i < ownCount) {
      if (canFire(state, playerId, i)) {
        return { type: "own", combinedIdx: i, ownIdx: i };
      }
    } else {
      const cc = captured[i - ownCount]!;
      if (canFireCaptured(state, cc)) {
        return { type: "captured", combinedIdx: i, cc };
      }
    }
  }
  return null;
}

/**
 * Check if a cannon is ready to fire (no ball currently in flight from it).
 */
export function canFire(
  state: GameState,
  playerId: number,
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
      (cc) => cc.cannon === cannon && cc.victimId === playerId,
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
export function fireSingleCaptured(
  state: GameState,
  cc: CapturedCannon,
  targetRow: number,
  targetCol: number,
): boolean {
  return fireCapturedCannon(state, cc, targetRow, targetCol);
}

/** Point all of a player's live cannons toward a crosshair position (pixels).
 *  Also aims any cannons this player has captured via propaganda balloons.
 *  When dt > 0, rotation is smooth; when dt <= 0, rotation snaps instantly. */
export function aimCannons(
  state: GameState,
  playerId: number,
  cx: number,
  cy: number,
  dt = 0,
): void {
  const player = state.players[playerId];
  if (!player) return;
  // Collect captured cannon refs so we skip them from the owner's own aiming
  const capturedByOthers = new Set<Cannon>();
  for (const cc of state.capturedCannons) {
    capturedByOthers.add(cc.cannon);
  }
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
  for (const cc of state.capturedCannons) {
    if (cc.capturerId !== playerId) continue;
    if (!isCannonAlive(cc.cannon)) continue;
    aimAt(cc.cannon);
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
      const shooterId = ball.scoringPlayerId ?? ball.playerId;
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
      impacts.push(hit);
    } else {
      remaining.push(ball);
    }
  }

  state.cannonballs = remaining;
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
 * @param shooterId — fallback owner for scoring when event lacks embedded shooterId
 *   (host passes it from the firing loop; network events embed it in the payload).
 */
export function applyImpactEvent(
  state: GameState,
  event: ImpactEvent,
  shooterId?: number,
): void {
  // Prefer shooterId from event (network payload) over parameter (host fallback)
  const sid =
    "shooterId" in event && event.shooterId !== undefined
      ? event.shooterId
      : shooterId;
  switch (event.type) {
    case MESSAGE.WALL_DESTROYED: {
      const player = state.players[event.playerId];
      if (player) {
        player.walls.delete(packTile(event.row, event.col));
        // No markWallsDirty — battle wall destruction is intentionally not
        // tracked. Interior is stale during battle by design; isCannonEnclosed
        // checks pre-battle interior. claimTerritory runs at next phase start.
        const shooter = sid !== undefined ? state.players[sid] : undefined;
        if (shooter && event.playerId !== sid)
          shooter.score += DESTROY_WALL_POINTS;
      }
      break;
    }
    case MESSAGE.CANNON_DAMAGED: {
      const cannon = state.players[event.playerId]?.cannons[event.cannonIdx];
      if (cannon) {
        cannon.hp = event.newHp;
        if (!isCannonAlive(cannon)) {
          const shooter = sid !== undefined ? state.players[sid] : undefined;
          if (shooter && event.playerId !== sid)
            shooter.score += DESTROY_CANNON_POINTS;
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
        targetPlayerId: event.targetPlayerId,
      });
      break;
    case MESSAGE.GRUNT_KILLED: {
      const shooter = sid !== undefined ? state.players[sid] : undefined;
      state.grunts = state.grunts.filter(
        (grunt) => !isAtTile(grunt, event.row, event.col),
      );
      if (shooter) shooter.score += DESTROY_GRUNT_POINTS;
      break;
    }
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
  const thisRoundTargets = new Map<Cannon, { victimId: number }>();
  const assignedThisRound = new Map<Cannon, number>();

  // Assign each balloon to a target (deferred to avoid double-counting)
  const assignments: {
    balloon: Cannon;
    ownerId: number;
    target: Cannon;
    victimId: number;
  }[] = [];

  for (const { balloon, ownerId } of allBalloons) {
    const best = findBestBalloonTarget(state, ownerId, assignedThisRound);
    if (best) {
      assignedThisRound.set(
        best.cannon,
        (assignedThisRound.get(best.cannon) ?? 0) + 1,
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
  for (const cc of state.capturedCannons) {
    state.balloonHits.delete(cc.cannon);
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

function fireCapturedCannon(
  state: GameState,
  cc: CapturedCannon,
  targetRow: number,
  targetCol: number,
): boolean {
  if (!canFireCaptured(state, cc)) return false;
  launchCannonball(
    state,
    cc.cannon,
    cc.cannonIdx,
    cc.victimId,
    targetRow,
    targetCol,
    cc.capturerId,
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
  playerId: number,
  targetRow: number,
  targetCol: number,
  scoringPlayerId?: number,
): void {
  const { x: startX, y: startY } = cannonCenter(cannon);
  const tX = (targetCol + TILE_CENTER_OFFSET) * TILE_SIZE;
  const tY = (targetRow + TILE_CENTER_OFFSET) * TILE_SIZE;
  cannon.facing = computeFacing45(startX, startY, tX, tY);
  state.cannonballs.push({
    cannonIdx,
    startX,
    startY,
    x: startX,
    y: startY,
    targetX: tX,
    targetY: tY,
    speed: BALL_SPEED,
    playerId,
    scoringPlayerId,
    incendiary: isSuperCannon(cannon) ? true : undefined,
  });
}

/** Check if a captured cannon is ready to fire (not destroyed, no ball in flight). */
function canFireCaptured(state: GameState, cc: CapturedCannon): boolean {
  if (!isCannonAlive(cc.cannon)) return false;
  if (cc.cannonIdx < 0) return false;
  return !state.cannonballs.some(
    (b) => b.playerId === cc.victimId && b.cannonIdx === cc.cannonIdx,
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
 * New collectors that don't depend on hitWall can go after step 3.
 */
function computeImpact(
  state: GameState,
  row: number,
  col: number,
  shooterId: number,
  incendiary?: boolean,
): ImpactEvent[] {
  const events: ImpactEvent[] = [];
  if (!inBounds(row, col)) return events;
  const key = packTile(row, col);

  // Step 1: walls (must be first — hitWall gates incendiary pit below)
  const hitWall = collectWallImpacts(state, events, key, row, col, shooterId);
  // Step 2: cannons (independent)
  collectCannonImpacts(state, events, row, col, shooterId);

  // Step 3: incendiary pit (depends on hitWall from step 1)
  if (incendiary && hitWall && !hasPitAt(state.burningPits, row, col)) {
    events.push({
      type: MESSAGE.PIT_CREATED,
      row,
      col,
      roundsLeft: BURNING_PIT_DURATION,
    });
  }

  // Step 4: houses and grunts (independent — towers NOT damaged by cannonballs)
  collectHouseImpacts(state, events, row, col, shooterId);
  collectGruntImpacts(state, events, row, col, shooterId);

  return events;
}

/** Collect wall destruction events at a tile. Returns true if any wall was hit. */
function collectWallImpacts(
  state: GameState,
  events: ImpactEvent[],
  key: number,
  row: number,
  col: number,
  shooterId: number,
): boolean {
  let hitWall = false;
  for (const player of state.players) {
    if (player.walls.has(key)) {
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
  return hitWall;
}

/** Collect cannon damage events at a tile. */
function collectCannonImpacts(
  state: GameState,
  events: ImpactEvent[],
  row: number,
  col: number,
  shooterId: number,
): void {
  for (const player of state.players) {
    for (let ci = 0; ci < player.cannons.length; ci++) {
      const cannon = player.cannons[ci]!;
      if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        events.push({
          type: MESSAGE.CANNON_DAMAGED,
          playerId: player.id,
          cannonIdx: ci,
          newHp: cannon.hp - 1,
          shooterId,
        });
      }
    }
  }
}

/** Collect house destruction + grunt spawn events at a tile. */
function collectHouseImpacts(
  state: GameState,
  events: ImpactEvent[],
  row: number,
  col: number,
  shooterId: number,
): void {
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
            targetPlayerId: shooterId,
          });
        }
      }
    }
  }
}

/** Collect grunt kill events at a tile. */
function collectGruntImpacts(
  state: GameState,
  events: ImpactEvent[],
  row: number,
  col: number,
  shooterId: number,
): void {
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
}

/** Collect all active balloons across all players. */
function collectAllBalloons(
  state: GameState,
): { balloon: Cannon; ownerId: number }[] {
  const result: { balloon: Cannon; ownerId: number }[] = [];
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
  ownerId: number,
  assignedThisRound: Map<Cannon, number>,
): { cannon: Cannon; victimId: number } | null {
  let bestCannon: Cannon | null = null;
  let bestVictimId = -1; // sentinel: no target found yet
  let bestScore = -1;

  for (const other of filterActiveEnemies(state, ownerId)) {
    for (const cannon of filterActiveFiringCannons(other)) {
      const needed = balloonHitThreshold(cannon);
      const prevHits = state.balloonHits.get(cannon)?.count ?? 0;
      const roundHits = assignedThisRound.get(cannon) ?? 0;
      if (prevHits + roundHits >= needed) continue;
      if (!isCannonEnclosed(cannon, other)) continue;
      const score =
        (isSuperCannon(cannon) ? SUPER_GUN_THREAT_WEIGHT : 0) + cannon.hp;
      if (score > bestScore) {
        bestScore = score;
        bestCannon = cannon;
        bestVictimId = other.id;
      }
    }
  }

  return bestCannon ? { cannon: bestCannon, victimId: bestVictimId } : null;
}

/** Resolve balloon captures from accumulated hits. */
function resolveBalloonCaptures(
  state: GameState,
  thisRoundTargets: Map<Cannon, { victimId: number }>,
): void {
  state.capturedCannons = [];
  for (const [cannon, hit] of state.balloonHits) {
    const needed = balloonHitThreshold(cannon);
    if (hit.count >= needed) {
      const target = thisRoundTargets.get(cannon);
      let victimId = target?.victimId ?? -1;
      if (victimId < 0) {
        for (const player of state.players) {
          if (player.cannons.includes(cannon)) {
            victimId = player.id;
            break;
          }
        }
      }
      const winnerId = state.rng.pick(hit.capturerIds);
      const cannonIdx = state.players[victimId]?.cannons.indexOf(cannon) ?? -1;
      state.capturedCannons.push({
        cannon,
        cannonIdx,
        victimId,
        capturerId: winnerId,
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
