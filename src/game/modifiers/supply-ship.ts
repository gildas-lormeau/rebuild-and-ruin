/**
 * Supply Ship modifier — 3 neutral cargo ships sail the Y-river during
 * battle. Spawn at battle start (one per `map.exits`), tick toward
 * `map.junction` along the river Bezier. Each ship has 2 HP: a cannonball
 * hit within `HIT_RADIUS` damages it, and sinking it (2 hits) awards the
 * shooter a hidden one-round bonus. Ships still afloat auto-sink once the
 * battle timer drops below `AUTO_SINK_AT_TIMER`. Cleared at battle end.
 */

import { BATTLE_MESSAGE } from "../../shared/core/battle-events.ts";
import type { Cannonball } from "../../shared/core/battle-types.ts";
import {
  BALL_SPEED,
  CROSSHAIR_SPEED,
} from "../../shared/core/game-constants.ts";
import type {
  PixelPos,
  TileGridPos,
  TilePos,
} from "../../shared/core/geometry-types.ts";
import { TILE_SIZE, type TileKey } from "../../shared/core/grid.ts";
import type {
  SupplyBonusId,
  SupplyShip,
} from "../../shared/core/modifier-defs.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type { GameState, ModifierImpl } from "../../shared/core/types.ts";
import type { Rng } from "../../shared/platform/rng.ts";

/** Three ships per battle — one per Y-river arm (map.exits has 3 entries). */
const SUPPLY_SHIP_COUNT = 3;
/** HP at spawn. First hit reveals damage; second hit triggers sink. */
const SUPPLY_SHIP_HP = 2;
/** Distance (tiles) along the river Bezier to inset the spawn from
 *  the `exit` point. Exits sit 1 tile outside the grid; inset ~3 tiles
 *  along the curve so the entire 1×2 hull is fully on-screen when the
 *  modifier-reveal banner captures the post-apply scene snapshot. */
const SUPPLY_SHIP_SPAWN_INSET = 3;
/** Sink animation duration in seconds — drives `sinking.progress` from
 *  0 → 1. Matches the renderer's tilt-then-descend window. */
const SUPPLY_SHIP_SINK_DURATION = 1.2;
/** Battle-timer threshold (seconds remaining) at which any still-alive
 *  ship starts auto-sinking. Set ~0.3s above SUPPLY_SHIP_SINK_DURATION
 *  so the sink animation completes before the battle banner kicks in.
 *  Replaces the old junction-arrival distance check — auto-sink is now
 *  driven by the battle clock so behavior is consistent across all map
 *  layouts (short arms used to cause ships to reach the junction). */
const AUTO_SINK_AT_TIMER = 1.5;
/** Distance threshold (tiles) for a cannonball impact to count as a ship
 *  hit. Generous (~1 tile) so leading a moving target feels rewarding
 *  rather than punishing. Tuned with playtest. */
const HIT_RADIUS = 1.0;
/** Symmetric aim jitter (tiles) added to the AI's lead-predicted target
 *  so it doesn't snipe every ship — humans with manual lead still come
 *  out ahead, but the AI lands a meaningful fraction of its shots. Tightened
 *  from 0.5 to 0.3: at 0.5 the AI hit ~31% of attempts but almost never
 *  landed the second hit needed to sink a 2-HP ship (1 sink in 30 seeds).
 *  0.3 keeps a visible miss margin (humans still lead) while letting the
 *  engagement-priority follow-up shot land often enough to occasionally
 *  complete the two-hit combo. */
const SUPPLY_SHIP_AIM_NOISE = 0.3;
/** Seconds between target-pick and cannonball-fire. Matches the AI battle
 *  phase's `PRE_FIRE_DELAY_SEC` (dwell after arrival, before fire). Folded
 *  into the lead so the AI compensates for the dwell on top of crosshair
 *  travel + ball flight; without it the second-shot follow-up consistently
 *  lands behind a damaged ship. */
const PICK_TO_FIRE_DWELL_SEC = 0.15;
/** Radius (tiles) for "ship engaged by my cannonball" detection. A ship
 *  whose current position is within this distance of any in-flight ball's
 *  predicted impact counts as already-committed and is preferred for the
 *  next pick. Tuned wider than HIT_RADIUS (1.0) because in-flight balls
 *  were leaded to a future ship position — at pick time the ship is up
 *  to `SUPPLY_SHIP_SPEED * flightTime` tiles behind that impact point. */
const SHIP_ENGAGED_RADIUS = 4.0;
/** Seconds added to WALL_BUILD timer per consumed `extra_build_time`
 *  bonus. Matches Master Builder's `MASTER_BUILDER_BONUS_SECONDS` so
 *  the player intuition of "+5s build" is consistent across sources. */
const EXTRA_BUILD_TIME_SECONDS = 5;
/** One-round bonus pool. Each ship rolls one at spawn (hidden until
 *  sunk). On sink the bonus is queued via `queueSupplyBonus` and consumed
 *  the following round by the relevant phase hook (see `consumeSupplyBonuses`
 *  / `consumeOneSupplyBonus`). */
const BONUS_POOL: readonly SupplyBonusId[] = [
  "extra_cannon",
  "extra_build_time",
  "mortar_shot",
  "small_pieces_bias",
];
/** Speed in tiles per second. A ship covers ~9 tiles per 10s battle.
 *  Ships that aren't hit start sinking when the battle timer falls
 *  below AUTO_SINK_AT_TIMER (well before they could reach the
 *  junction on any arm), so the sink animation completes inside the
 *  battle window and the post-battle banner snapshot is clean.
 *  Exported so observers (e.g. the mcp-play harness) can surface a
 *  lead-able velocity vector without re-deriving the magnitude. */
export const SUPPLY_SHIP_SPEED = 0.9;
export const supplyShipImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => ({
    changedTiles: applySupplyShip(state),
    gruntsSpawned: 0,
  }),
  clear: (state: GameState) => {
    if (state.modern) state.modern.supplyShips = null;
  },
  // Ships are entity-layer; no tile or wall mutation.
  skipsRecheck: true,
  // Post-battle trace: which players banked which hidden bonuses. Read
  // AFTER `finalizeBattle` (which nulls `supplyShips` but leaves the queued
  // `pendingSupplyBonuses` for next round's consume hooks). Log-only.
  resolutionLog: (state: GameState) => {
    const pending = state.modern?.pendingSupplyBonuses;
    const summary = pending?.size
      ? [...pending.entries()]
          .map(([playerId, bonuses]) => `P${playerId}=${bonuses.join(",")}`)
          .join(" ")
      : "(no hits)";
    return `supply ships resolved: ${summary}`;
  },
};

/** Advance ship positions during battle. Called from `tickBattlePhase`
 *  each frame; cheap early-out when no ships are active. Pushes one
 *  `TilePos` to `impactsOut` per ship reaching sink-completion (sinking
 *  progress crossing ≥ 1) so the runtime's existing impact-splash
 *  pipeline renders the foam ring without a dedicated effect manager.
 *
 *  Ships follow the river's Bezier curve (control points: exit,
 *  midpoint, junction) rather than a straight line — straight motion
 *  would clip onto grass at the curve's peak where the painted river
 *  bends 1–3 tiles off the chord. */
export function tickSupplyShips(
  state: GameState,
  dt: number,
  impactsOut: TilePos[],
): void {
  const ships = state.modern?.supplyShips;
  if (!ships || ships.length === 0) return;

  const { exits, junction, riverMidpoints } = state.map;

  for (let i = ships.length - 1; i >= 0; i--) {
    const ship = ships[i]!;

    if (ship.sinking) {
      ship.sinking.progress += dt / SUPPLY_SHIP_SINK_DURATION;
      if (ship.sinking.progress >= 1) {
        impactsOut.push({
          row: Math.round(ship.position.row),
          col: Math.round(ship.position.col),
        });
        ships.splice(i, 1);
      }
      continue;
    }

    // Auto-sink near the end of the battle window so ships don't ride
    // out the final seconds clipped to the screen edge. Driven by the
    // battle timer (not by junction arrival) so behavior is uniform
    // across all map layouts.
    if (state.timer < AUTO_SINK_AT_TIMER) {
      ship.sinking = { progress: 0 };
      continue;
    }

    const exit = exits[ship.spawnArm]!;
    const midpoint = riverMidpoints[ship.spawnArm]!;
    const sample = sampleRiverBezier(exit, midpoint, junction, ship.pathT);
    // Advance by exact arc-length step: dt_param = (speed · dt) / |B'(t)|.
    // Keeps the ship at a constant tiles/sec regardless of local curve
    // tangent magnitude (which varies along quadratic Beziers when the
    // midpoint is off-chord). pathT is clamped at 1 as a safety cap
    // against numerical drift — speed × battle-length never reaches the
    // far end of the shortest arm in normal play.
    const stepT =
      sample.tangentMag > 0 ? (SUPPLY_SHIP_SPEED * dt) / sample.tangentMag : 0;
    ship.pathT = Math.min(1, ship.pathT + stepT);
    const advanced = sampleRiverBezier(exit, midpoint, junction, ship.pathT);
    ship.position.col = advanced.col;
    ship.position.row = advanced.row;
    ship.headingRad = advanced.headingRad;
  }
}

/** Register a cannonball hit on the supply ship nearest the impact tile,
 *  if any are within `HIT_RADIUS`. Sinking ships and ships at hp 0 are
 *  ignored (already done). Returns the hit outcome or null if no ship
 *  was in range. Called by `tickCannonballs` after each impact resolves.
 *
 *  Deterministic: positions and hp are mirror-simulated, so host and
 *  watcher reach the same hit/sink result without wire traffic. */
export function tryHitSupplyShip(
  state: GameState,
  impactCol: number,
  impactRow: number,
  shooterId: ValidPlayerId,
): void {
  const ships = state.modern?.supplyShips;
  if (!ships || ships.length === 0) return;

  let closestIndex = -1;
  let closestDistSq = HIT_RADIUS * HIT_RADIUS;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    if (ship.sinking || ship.hp <= 0) continue;
    const deltaCol = ship.position.col - impactCol;
    const deltaRow = ship.position.row - impactRow;
    const distSq = deltaCol * deltaCol + deltaRow * deltaRow;
    if (distSq <= closestDistSq) {
      closestDistSq = distSq;
      closestIndex = i;
    }
  }
  if (closestIndex < 0) return;

  const ship = ships[closestIndex]!;
  ship.hp -= 1;
  state.bus.emit(BATTLE_MESSAGE.SHIP_HIT, {
    type: BATTLE_MESSAGE.SHIP_HIT,
    shipId: ship.id,
    shooterId,
    newHp: ship.hp,
  });
  if (ship.hp <= 0) {
    ship.sinking = { progress: 0 };
    queueSupplyBonus(state, shooterId, ship.bonus);
    state.bus.emit(BATTLE_MESSAGE.SHIP_SUNK, {
      type: BATTLE_MESSAGE.SHIP_SUNK,
      shipId: ship.id,
      shooterId,
    });
  }
}

/** Total seconds added to the WALL_BUILD timer this round from supply
 *  ship `extra_build_time` bonuses across all players. Each consumed
 *  bonus contributes `EXTRA_BUILD_TIME_SECONDS`. Called from
 *  `enterWallBuildPhase`. Drains the consumed entries. */
export function supplyShipBuildTimerBonus(state: GameState): number {
  const pending = state.modern?.pendingSupplyBonuses;
  if (!pending) return 0;
  let totalSeconds = 0;
  for (const playerId of [...pending.keys()]) {
    const consumed = consumeSupplyBonuses(state, playerId, "extra_build_time");
    totalSeconds += consumed * EXTRA_BUILD_TIME_SECONDS;
  }
  return totalSeconds;
}

/** Pick a non-sinking supply ship as a shot target for AI cannons and
 *  return a lead-predicted pixel position so a ball fired from
 *  `shooterTile` actually lands near the ship by the time it arrives.
 *  The lead accounts for the full pick→impact window:
 *    crosshair travel (current `crosshair` → lead position)
 *    + AI pre-fire dwell
 *    + ball flight (`shooterTile` → lead position)
 *  Earlier versions leaded only by ball flight, which under-predicted by
 *  ~1–2s of ship motion and pushed every shot behind the ship — the
 *  follow-up that would sink a damaged ship reliably missed.
 *
 *  Pool priority (highest first):
 *    1. ships already engaged by one of my in-flight cannonballs — the
 *       AI re-picks a think-delay (~0.1–0.3s) after firing, usually well
 *       before the previous ball has landed, so `ship.hp` hasn't
 *       decremented yet. Without this engagement signal the AI scatters
 *       shots across all three ships and never lands the two-hit combo
 *       needed to sink one.
 *    2. damaged ships (hp < SUPPLY_SHIP_HP) — finishes off humans'
 *       wounded ships, and catches the case where my own in-flight ball
 *       has already landed by the time I re-pick.
 *    3. all targetable — uniform random over fresh ships.
 *  Symmetric noise (±SUPPLY_SHIP_AIM_NOISE) keeps humans with manual
 *  lead ahead. Returns null when no targetable ship exists (modifier
 *  inactive, ships cleared, or all sinking). */
export function pickSupplyShipTarget(
  ships: readonly SupplyShip[] | null | undefined,
  shooterTile: TilePos,
  crosshair: PixelPos,
  cannonballs: readonly Cannonball[],
  shooterId: ValidPlayerId,
  rng: Rng,
): PixelPos | null {
  if (!ships || ships.length === 0) return null;
  const targetable = ships.filter((ship) => !ship.sinking && ship.hp > 0);
  if (targetable.length === 0) return null;
  const engaged = targetable.filter((ship) =>
    isShipEngagedBy(ship, cannonballs, shooterId),
  );
  const damaged = targetable.filter((ship) => ship.hp < SUPPLY_SHIP_HP);
  const pool =
    engaged.length > 0 ? engaged : damaged.length > 0 ? damaged : targetable;
  const ship = rng.pick(pool);

  const ballSpeedTiles = BALL_SPEED / TILE_SIZE;
  const crosshairSpeedTiles = (2 * CROSSHAIR_SPEED) / TILE_SIZE;
  const flightDCol = ship.position.col - shooterTile.col;
  const flightDRow = ship.position.row - shooterTile.row;
  const flightTime =
    Math.sqrt(flightDCol * flightDCol + flightDRow * flightDRow) /
    ballSpeedTiles;
  const moveDCol = ship.position.col - crosshair.x / TILE_SIZE;
  const moveDRow = ship.position.row - crosshair.y / TILE_SIZE;
  const moveTime =
    Math.sqrt(moveDCol * moveDCol + moveDRow * moveDRow) / crosshairSpeedTiles;
  const totalLeadTime = flightTime + moveTime + PICK_TO_FIRE_DWELL_SEC;
  const leadCol =
    ship.position.col +
    Math.cos(ship.headingRad) * SUPPLY_SHIP_SPEED * totalLeadTime;
  const leadRow =
    ship.position.row +
    Math.sin(ship.headingRad) * SUPPLY_SHIP_SPEED * totalLeadTime;
  const noiseCol = (rng.next() - 0.5) * 2 * SUPPLY_SHIP_AIM_NOISE;
  const noiseRow = (rng.next() - 0.5) * 2 * SUPPLY_SHIP_AIM_NOISE;
  return {
    x: (leadCol + noiseCol) * TILE_SIZE,
    y: (leadRow + noiseRow) * TILE_SIZE,
  };
}

/** Peek: does the player have at least one bonus of `type` queued?
 *  Used by fire paths to decide whether to elevate a normal cannon shot
 *  to a mortar shot WITHOUT consuming yet — the consume runs on every
 *  peer in `applyCannonFired` for cross-peer parity. */
export function hasSupplyBonus(
  state: GameState,
  playerId: ValidPlayerId,
  bonusType: SupplyBonusId,
): boolean {
  const queue = state.modern?.pendingSupplyBonuses?.get(playerId);
  return queue !== undefined && queue.includes(bonusType);
}

/** Consume exactly one bonus of `type` for `playerId` if any are queued.
 *  Returns true if a bonus was drained. Drives per-use consumables
 *  (e.g. mortar_shot) where each event consumes one — contrast with
 *  `consumeSupplyBonuses` which drains all of a type at once. */
export function consumeOneSupplyBonus(
  state: GameState,
  playerId: ValidPlayerId,
  bonusType: SupplyBonusId,
): boolean {
  const pending = state.modern?.pendingSupplyBonuses;
  const queue = pending?.get(playerId);
  if (!queue) return false;
  const idx = queue.indexOf(bonusType);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) pending!.delete(playerId);
  if (pending && pending.size === 0 && state.modern) {
    state.modern.pendingSupplyBonuses = null;
  }
  return true;
}

/** Consume all queued bonuses of `bonusType` for `playerId`, returning
 *  the count. Each call drains the matching entries; subsequent calls
 *  return 0 until new bonuses are queued. Used by phase-entry hooks
 *  (e.g. cannon-limit computation) to materialize one-round effects. */
export function consumeSupplyBonuses(
  state: GameState,
  playerId: ValidPlayerId,
  bonusType: SupplyBonusId,
): number {
  const pending = state.modern?.pendingSupplyBonuses;
  if (!pending) return 0;
  const queue = pending.get(playerId);
  if (!queue) return 0;
  let count = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i] === bonusType) {
      count += 1;
      queue.splice(i, 1);
    }
  }
  if (queue.length === 0) pending.delete(playerId);
  if (pending.size === 0 && state.modern)
    state.modern.pendingSupplyBonuses = null;
  return count;
}

function isShipEngagedBy(
  ship: SupplyShip,
  cannonballs: readonly Cannonball[],
  shooterId: ValidPlayerId,
): boolean {
  for (const ball of cannonballs) {
    if (ball.playerId !== shooterId) continue;
    const ballCol = ball.impactX / TILE_SIZE;
    const ballRow = ball.impactY / TILE_SIZE;
    const dCol = ship.position.col - ballCol;
    const dRow = ship.position.row - ballRow;
    if (dCol * dCol + dRow * dRow <= SHIP_ENGAGED_RADIUS * SHIP_ENGAGED_RADIUS)
      return true;
  }
  return false;
}

function queueSupplyBonus(
  state: GameState,
  playerId: ValidPlayerId,
  bonus: SupplyBonusId,
): void {
  if (!state.modern) return;
  if (!state.modern.pendingSupplyBonuses) {
    state.modern.pendingSupplyBonuses = new Map();
  }
  const queue = state.modern.pendingSupplyBonuses.get(playerId) ?? [];
  queue.push(bonus);
  state.modern.pendingSupplyBonuses.set(playerId, queue);
}

function applySupplyShip(state: GameState): readonly TileKey[] {
  const { exits, junction, riverMidpoints } = state.map;
  const ships: SupplyShip[] = [];
  const armCount = Math.min(SUPPLY_SHIP_COUNT, exits.length);
  for (let armIndex = 0; armIndex < armCount; armIndex++) {
    const exit = exits[armIndex]!;
    const midpoint = riverMidpoints[armIndex]!;
    const bonus = BONUS_POOL[state.rng.int(0, BONUS_POOL.length - 1)]!;
    // Initial pathT = inset_tiles / approx_arc_length. Quadratic Bezier
    // arc length is within a few % of chord length for the small
    // midpoint jitter the map generator uses (±3 cols, ±2 rows), so
    // the chord makes a good cheap approximation.
    const chordCol = junction.x - exit.x;
    const chordRow = junction.y - exit.y;
    const chordLen = Math.sqrt(chordCol * chordCol + chordRow * chordRow) || 1;
    const pathT = SUPPLY_SHIP_SPAWN_INSET / chordLen;
    const sample = sampleRiverBezier(exit, midpoint, junction, pathT);
    ships.push({
      id: armIndex,
      spawnArm: armIndex as 0 | 1 | 2,
      pathT,
      position: { col: sample.col, row: sample.row },
      headingRad: sample.headingRad,
      hp: SUPPLY_SHIP_HP,
      bonus,
    });
  }
  if (state.modern) state.modern.supplyShips = ships;
  // Entity-layer modifier — no tile mutation to surface in the reveal banner.
  return [];
}

/** Evaluate the quadratic Bezier `B(t) = (1−t)²·P0 + 2(1−t)·t·P1 + t²·P2`
 *  along a river arm. Returns position + heading (atan2 of the tangent)
 *  + tangent magnitude so callers can advance `t` at constant
 *  arc-length speed. Matches the same Bezier the map generator paints
 *  in `interpolatePath`. */
function sampleRiverBezier(
  exit: TileGridPos,
  midpoint: TileGridPos,
  junction: TileGridPos,
  t: number,
): {
  col: number;
  row: number;
  headingRad: number;
  tangentMag: number;
} {
  const oneMinusT = 1 - t;
  const col =
    oneMinusT * oneMinusT * exit.x +
    2 * oneMinusT * t * midpoint.x +
    t * t * junction.x;
  const row =
    oneMinusT * oneMinusT * exit.y +
    2 * oneMinusT * t * midpoint.y +
    t * t * junction.y;
  // B'(t) = 2(1−t)·(P1−P0) + 2t·(P2−P1)
  const tangentCol =
    2 * oneMinusT * (midpoint.x - exit.x) + 2 * t * (junction.x - midpoint.x);
  const tangentRow =
    2 * oneMinusT * (midpoint.y - exit.y) + 2 * t * (junction.y - midpoint.y);
  return {
    col,
    row,
    headingRad: Math.atan2(tangentRow, tangentCol),
    tangentMag: Math.sqrt(tangentCol * tangentCol + tangentRow * tangentRow),
  };
}
