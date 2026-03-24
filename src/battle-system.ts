/**
 * Battle system — cannon firing, cannonball physics, impacts, and balloon capture.
 */

import { MSG } from "../server/protocol.ts";
import { isCannonEnclosed } from "./cannon-system.ts";
import type { TilePos } from "./geometry-types.ts";
import { TILE_SIZE } from "./grid.ts";
import { findGruntSpawnNear } from "./grunt-system.ts";
import {
  cannonCenter,
  computeFacing45,
  inBounds,
  isAtTile,
  isCannonAlive,
  isCannonTile,
  isPitAt,
  packTile,
  rotateToward,
  TILE_CENTER_OFFSET,
} from "./spatial.ts";
import type { Cannon, Cannonball, CapturedCannon, GameState } from "./types.ts";
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
} from "./types.ts";

/** Result from nextReadyCombined — either an own cannon or a captured one. */
export type CombinedCannonResult =
  | { type: "own"; combinedIdx: number; ownIdx: number }
  | { type: "captured"; combinedIdx: number; cc: CapturedCannon };

/** An event emitted by applyImpact for network relay. */
export type ImpactEvent =
  | {
      type: typeof MSG.WALL_DESTROYED;
      row: number;
      col: number;
      playerId: number;
      shooterId?: number;
    }
  | {
      type: typeof MSG.CANNON_DAMAGED;
      playerId: number;
      cannonIdx: number;
      newHp: number;
      shooterId?: number;
    }
  | { type: typeof MSG.HOUSE_DESTROYED; row: number; col: number }
  | { type: typeof MSG.GRUNT_KILLED; row: number; col: number; shooterId?: number }
  | { type: typeof MSG.GRUNT_SPAWNED; row: number; col: number; targetPlayerId: number }
  | { type: typeof MSG.PIT_CREATED; row: number; col: number; roundsLeft: number };

/** Result of updateCannonballs: impact positions (for VFX) + detailed events (for network). */
interface CannonballUpdateResult {
  impacts: TilePos[];
  events: ImpactEvent[];
}

/** Flight path for a balloon animation. */
export interface BalloonFlight {
  /** Start position in pixels (balloon base center). */
  startX: number;
  startY: number;
  /** Target position in pixels (captured cannon center). */
  endX: number;
  endY: number;
}

/** Cannon rotation speed in radians per second. */
const CANNON_ROTATE_SPEED = Math.PI * 3;
/** Countdown thresholds for battle announcement phases. */
const COUNTDOWN_READY = 3;
const COUNTDOWN_AIM = 1;

/** Map battleCountdown to the corresponding announcement text. */
export function countdownAnnouncement(battleCountdown: number): string | undefined {
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
  after: number = -1,
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
  if (cannon.balloon) return false;
  // Captured cannons cannot be fired by their original owner
  if (
    state.capturedCannons.some(
      (cc) => cc.cannon === cannon && cc.victimId === playerId,
    )
  )
    return false;
  // Cannon must be inside enclosed territory
  if (!isCannonEnclosed(cannon, player.interior)) return false;
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
    if (!isCannonEnclosed(cannon, player.interior)) continue;
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
export function updateCannonballs(
  state: GameState,
  dt: number,
): CannonballUpdateResult {
  const impacts: TilePos[] = [];
  const events: ImpactEvent[] = [];
  const remaining: Cannonball[] = [];

  for (const ball of state.cannonballs) {
    const dx = ball.targetX - ball.x;
    const dy = ball.targetY - ball.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const move = ball.speed * dt;

    if (dist <= move) {
      // Ball has arrived — compute and apply impact
      const impactRow = Math.floor(ball.targetY / TILE_SIZE);
      const impactCol = Math.floor(ball.targetX / TILE_SIZE);
      const shooterId = ball.scoringPlayerId ?? ball.playerId;
      const impactEvents = computeImpact(
        state,
        impactRow,
        impactCol,
        shooterId,
        ball.incendiary,
      );
      for (const evt of impactEvents) {
        applyImpactEvent(state, evt, shooterId);
        events.push(evt);
      }
      impacts.push({ row: impactRow, col: impactCol });
    } else {
      // Move toward target
      ball.x += (dx / dist) * move;
      ball.y += (dy / dist) * move;
      remaining.push(ball);
    }
  }

  state.cannonballs = remaining;
  return { impacts, events };
}

/**
 * Apply a single impact event to game state. Used by both host and watcher.
 */
export function applyImpactEvent(
  state: GameState,
  event: ImpactEvent,
  shooterId?: number,
): void {
  // Use shooterId from event (network) or parameter (host)
  const sid =
    "shooterId" in event && event.shooterId !== undefined
      ? event.shooterId
      : shooterId;
  switch (event.type) {
    case MSG.WALL_DESTROYED: {
      const player = state.players[event.playerId];
      if (player) {
        player.walls.delete(packTile(event.row, event.col));
        const shooter = sid !== undefined ? state.players[sid] : undefined;
        if (shooter && event.playerId !== sid)
          shooter.score += DESTROY_WALL_POINTS;
      }
      break;
    }
    case MSG.CANNON_DAMAGED: {
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
    case MSG.PIT_CREATED:
      state.burningPits.push({
        row: event.row,
        col: event.col,
        roundsLeft: event.roundsLeft,
      });
      break;
    case MSG.HOUSE_DESTROYED:
      for (const house of state.map.houses) {
        if (house.alive && isAtTile(house, event.row, event.col)) {
          house.alive = false;
        }
      }
      break;
    case MSG.GRUNT_SPAWNED:
      state.grunts.push({
        row: event.row,
        col: event.col,
        targetPlayerId: event.targetPlayerId,
      });
      break;
    case MSG.GRUNT_KILLED: {
      const shooter = sid !== undefined ? state.players[sid] : undefined;
      state.grunts = state.grunts.filter(
        (g) => !isAtTile(g, event.row, event.col),
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
    const entry = state.balloonHits.get(target) ?? { count: 0, capturerIds: [] as number[] };
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

/** Clean up balloon hit tracking at the end of a battle round. */
export function cleanupBalloonHitTrackingAfterBattle(state: GameState): void {
  // Reset balloon hit counters for cannons that were captured (used this battle)
  for (const cc of state.capturedCannons) {
    state.balloonHits.delete(cc.cannon);
  }

  // Also clean up hit counters for destroyed cannons
  for (const [cannon] of state.balloonHits) {
    if (!isCannonAlive(cannon)) state.balloonHits.delete(cannon);
  }

  // Clear capturerIds for non-captured cannons so only the deciding
  // battle's contributors can win (hit count persists across battles)
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
    incendiary: cannon.super || undefined,
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

  let hitWall = false;
  for (const player of state.players) {
    if (player.walls.has(key)) {
      hitWall = true;
      events.push({
        type: MSG.WALL_DESTROYED,
        row,
        col,
        playerId: player.id,
        shooterId,
      });
    }

    for (let ci = 0; ci < player.cannons.length; ci++) {
      const cannon = player.cannons[ci]!;
      if (!isCannonAlive(cannon) || cannon.balloon) continue;
      if (isCannonTile(cannon, row, col)) {
        events.push({
          type: MSG.CANNON_DAMAGED,
          playerId: player.id,
          cannonIdx: ci,
          newHp: cannon.hp - 1,
          shooterId,
        });
      }
    }
  }

  if (incendiary && hitWall && !isPitAt(state.burningPits, row, col)) {
    events.push({
      type: MSG.PIT_CREATED,
      row,
      col,
      roundsLeft: BURNING_PIT_DURATION,
    });
  }

  // Towers are NOT damaged by cannonballs — only grunts can destroy towers.

  for (const house of state.map.houses) {
    if (house.alive && isAtTile(house, row, col)) {
      events.push({ type: MSG.HOUSE_DESTROYED, row, col });
      // Grunt spawn is RNG-based — compute it here so the host decides
      if (state.rng.bool(HOUSE_GRUNT_SPAWN_CHANCE)) {
        // Find spawn position near the destroyed house
        const spawnPos = findGruntSpawnNear(state, row, col);
        if (spawnPos) {
          events.push({
            type: MSG.GRUNT_SPAWNED,
            row: spawnPos.row,
            col: spawnPos.col,
            targetPlayerId: shooterId,
          });
        }
      }
    }
  }

  for (const g of state.grunts) {
    if (isAtTile(g, row, col)) {
      events.push({ type: MSG.GRUNT_KILLED, row: g.row, col: g.col, shooterId });
    }
  }

  return events;
}

/** Collect all active balloons across all players. */
function collectAllBalloons(
  state: GameState,
): { balloon: Cannon; ownerId: number }[] {
  const result: { balloon: Cannon; ownerId: number }[] = [];
  for (const player of state.players) {
    if (player.eliminated) continue;
    for (const c of player.cannons) {
      if (c.balloon && isCannonAlive(c))
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
  let bestVictimId = -1;
  let bestScore = -1;

  for (const other of state.players) {
    if (other.id === ownerId || other.eliminated) continue;
    for (const cannon of other.cannons) {
      if (!isCannonAlive(cannon) || cannon.balloon) continue;
      const needed = balloonHitsNeeded(cannon);
      const prevHits = state.balloonHits.get(cannon)?.count ?? 0;
      const roundHits = assignedThisRound.get(cannon) ?? 0;
      if (prevHits + roundHits >= needed) continue;
      if (!isCannonEnclosed(cannon, other.interior)) continue;
      const score = (cannon.super ? SUPER_GUN_THREAT_WEIGHT : 0) + cannon.hp;
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
    const needed = balloonHitsNeeded(cannon);
    if (hit.count >= needed) {
      const target = thisRoundTargets.get(cannon);
      let victimId = target?.victimId ?? -1;
      if (victimId < 0) {
        for (const p of state.players) {
          if (p.cannons.includes(cannon)) {
            victimId = p.id;
            break;
          }
        }
      }
      const winnerId = state.rng.pick(hit.capturerIds);
      const cannonIdx = state.players[victimId]?.cannons.indexOf(cannon) ?? -1;
      state.capturedCannons.push({ cannon, cannonIdx, victimId, capturerId: winnerId });
    }
  }
}

/** How many balloon hits are required to capture a cannon. */
function balloonHitsNeeded(cannon: Cannon): number {
  return cannon.super ? SUPER_BALLOON_HITS_NEEDED : BALLOON_HITS_NEEDED;
}
