import {
  canFireOwnCannon,
  filterActiveFiringCannons,
  getGruntTargetTower,
  pickSupplyShipTarget,
} from "../game/index.ts";
import {
  type Cannonball,
  isBalloonCannon,
  isCannonAlive,
} from "../shared/core/battle-types.ts";
import {
  computeCardinalObstacleMask,
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/core/board-occupancy.ts";
import { MODIFIER_ID, TOWER_SIZE } from "../shared/core/game-constants.ts";
import type {
  CannonIdx,
  GameMap,
  PixelPos,
  TilePos,
} from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  type TileKey,
} from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  cannonSize,
  computeOutside,
  DIRS_4,
  DIRS_8,
  inBounds,
  isCannonTile,
  isGrass,
  manhattanDistance,
  orderByNearest,
  packTile,
  pxToTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type {
  PrioritizedTilePos,
  StrategicPixelPos,
} from "./ai-build-types.ts";
import { traitLookup } from "./ai-constants.ts";

type TargetCandidate = PrioritizedTilePos & { isCannon?: boolean };

/** Persistent target memory — keeps the AI locked onto one enclosure across
 *  shots so it doesn't oscillate between random enclosures. The anchor is any
 *  interior tile of the chosen enclosure; reuse lasts as long as that tile is
 *  still inside an eligible enemy's interior. */
export type BattleTargetMemory = {
  ownerId: ValidPlayerId | undefined;
  anchorTileKey: number | undefined;
};

type StructuralHitCandidate = {
  tiles: TilePos[];
  enclosuresBroken: number;
};

/** Minimum grunts targeting a player before a grunt sweep is considered.
 *  Lowered during grunt-heavy modifiers (grunt_surge, frozen_river) so the
 *  AI reacts sooner to the increased threat. */
const GRUNT_SWEEP_THRESHOLD = 15;
const GRUNT_SWEEP_THRESHOLD_MODIFIER = 8;
/** Skip charity sweep if the enemy has more usable cannons than this. */
const CHARITY_CANNON_THRESHOLD = 6;
/** Pockets smaller than this are worth destroying — can't fit a 2×2 cannon.
 *  Distinct from DESTROY_POCKET_MAX_SIZE (build scoring) which is higher (9)
 *  because build prevention is stricter than battle destruction. */
const DESTROY_POCKET_MAX_SIZE = 4;
/** Minimum number of small pockets before pocket destruction triggers. */
const POCKET_COUNT_THRESHOLD = 5;
/** Maximum wall tiles targeted in a single pocket destruction chain. */
const MAX_POCKET_TARGETS = 5;
/** Minimum connected wall tiles needed to start a wall demolition run. */
const MIN_WALL_SEGMENT_LENGTH = 4;
/** Maximum wall tiles targeted in a single wall demolition chain. */
const MAX_WALL_DEMOLITION_TARGETS = 10;
/** Timer ticks remaining that define the "second half" of battle. */
const BATTLE_SECOND_HALF_TIMER = 5;
/** Chance to switch focus to a different enemy in the second half. */
const TARGET_SWITCH_PROBABILITY = 0.25;
/** Chance to target a strategic wall tile (flanked by 2+ obstacles). */
const STRATEGIC_TARGET_PROBABILITY = 1 / 4;
/** Chance to target a supply ship sailing the river. No lead prediction —
 *  the AI fires at the ship's current position, so cannonball flight
 *  time + ship motion create natural miss-chance. Bonuses still
 *  favour humans (who can lead and time shots), but AIs occasionally
 *  land a hit. */
const SUPPLY_SHIP_TARGET_PROBABILITY = 1 / 8;
/** Chance to target a wall tile blocking a grunt's path to its tower. */
const GRUNT_WALL_TARGET_PROBABILITY = 1 / 8;
/** Chance to target a fresh (undamaged) enemy cannon before defaulting to
 *  enclosure-wall sieging. Damaged cannons are handled by the priority pool. */
const FRESH_CANNON_TARGET_PROBABILITY = 1 / 3;
/** How many of the closest candidates to pick randomly from. */
const TOP_TARGET_PICK_COUNT = 3;
/** Minimum preferred distance (in tiles) from crosshair for target spread. */
const SWEET_SPOT_MIN_DISTANCE = 0;
/** Width of the preferred distance band (sweet spot = min .. min + range). */
const SWEET_SPOT_DISTANCE_RANGE = 5;
/** Tiles per side of the base (lateral from anchor). */
const ICE_TRENCH_BASE_HALF = 3;
/** Tiles per arm extending from each end of the base toward the enemy. */
const ICE_TRENCH_ARM_LENGTH = 1;

/** Count cannons that are alive and enclosed (usable for firing). */
export function countUsableCannons(
  state: BattleViewState,
  playerId: ValidPlayerId,
): number {
  const player = state.players[playerId]!;
  let count = 0;
  for (let i = 0; i < player.cannons.length; i++) {
    if (canFireOwnCannon(state, playerId, i as CannonIdx)) count++;
  }
  return count;
}

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't. */
export function planCharitySweep(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  for (const enemy of state.players) {
    if (enemy.id === playerId || isPlayerEliminated(enemy)) continue;
    if (filterActiveFiringCannons(enemy).length > CHARITY_CANNON_THRESHOLD)
      continue;
    const targets = planGruntSweep(state, enemy.id, usableCannonCount, rng);
    if (targets) return targets;
  }
  return null;
}

/** Plan pocket destruction: find small enclosures (< 2x2) and non-square 4-tile pockets, target one wall per pocket.
 *
 *  Uses getBattleInterior() — interior is intentionally stale during battle
 *  (walls destroyed by cannonballs are not reflected until the next build phase).
 *  Pocket detection uses the last-known enclosure state to pick wall targets. */
export function planPocketDestruction(
  state: BattleViewState,
  playerId: ValidPlayerId,
): TilePos[] | null {
  const player = state.players[playerId]!;
  const interior = getBattleInterior(player);
  if (interior.size === 0) return null;
  const components = findEnclosureComponents(interior);
  const pockets = components.filter(
    (comp) =>
      comp.length < DESTROY_POCKET_MAX_SIZE ||
      (comp.length === DESTROY_POCKET_MAX_SIZE && !is2x2(comp)),
  );
  if (pockets.length <= POCKET_COUNT_THRESHOLD) return null;
  // Build a set of all small-pocket tiles for quick lookup
  const pocketTiles = new Set<number>();
  for (const pocket of pockets) {
    for (const k of pocket) pocketTiles.add(k);
  }

  const targets: TilePos[] = [];
  const picked = new Set<number>();
  for (const pocket of pockets) {
    let found = false;
    for (const key of pocket) {
      if (found) break;
      const { r, c } = unpackTile(key as TileKey);
      for (const [dr, dc] of DIRS_4) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        if (!player.walls.has(neighborKey) || picked.has(neighborKey)) continue;
        // Check that this wall doesn't also border a large enclosure
        let bordersLarge = false;
        for (const [dr2, dc2] of DIRS_4) {
          const ar = nr + dr2;
          const ac = nc + dc2;
          if (!inBounds(ar, ac)) continue;
          const adjacentKey = packTile(ar, ac);
          if (interior.has(adjacentKey) && !pocketTiles.has(adjacentKey)) {
            bordersLarge = true;
            break;
          }
        }
        if (bordersLarge) continue;
        targets.push({ row: nr, col: nc });
        picked.add(neighborKey);
        found = true;
        break;
      }
    }
  }
  if (targets.length === 0) return null;
  if (targets.length > MAX_POCKET_TARGETS) targets.length = MAX_POCKET_TARGETS;
  return orderByNearest(targets);
}

/** Plan a super attack: like wall demolition but hit every other tile (stride of 2). */
export function planSuperAttack(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const segment = planWallDemolition(
    state,
    playerId,
    usableCannonCount * 2,
    rng,
  );
  if (!segment) return null;
  // Keep every other tile
  const strided = segment.filter((_, i) => i % 2 === 0);
  return strided.length >= 2 ? strided : null;
}

/** Plan a wall demolition run: find connected enemy wall segment. */
export function planWallDemolition(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.walls.size < MIN_WALL_SEGMENT_LENGTH) continue;
    const wallKeys = [...enemy.walls];
    const startKey = rng.pick(wallKeys);
    const segment = findConnectedWalls(
      enemy.walls,
      startKey,
      usableCannonCount,
      rng,
    );
    if (segment.length >= MIN_WALL_SEGMENT_LENGTH) {
      const maxLength = Math.min(
        segment.length,
        usableCannonCount,
        MAX_WALL_DEMOLITION_TARGETS,
      );
      const length = rng.int(MIN_WALL_SEGMENT_LENGTH, maxLength);
      return segment.slice(0, length).map((k) => {
        const { r, c } = unpackTile(k as TileKey);
        return { row: r, col: c };
      });
    }
  }
  return null;
}

/** Plan a structural hit: find 1–2 wall tiles whose removal breaks 2+ large
 *  enclosures simultaneously.  Analyses each enemy's wall layout, finds
 *  "outer-shell" wall tiles adjacent to the outside flood, and simulates
 *  removal to count how many enclosures would be breached.
 *  Falls back to 2-tile pairs when single-tile hits aren't available
 *  (thick walls).  Returns up to `maxHits` worth of targets, ordered by
 *  nearest-neighbor for chain execution. */
export function planStructuralHit(
  state: BattleViewState,
  playerId: ValidPlayerId,
  maxHits: number,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  const allHits: StructuralHitCandidate[] = [];

  for (const enemy of enemies) {
    if (enemy.walls.size === 0) continue;
    const hits = findStructuralHits(enemy.walls, state.map.tiles);
    for (const hit of hits) allHits.push(hit);
  }

  if (allHits.length === 0) return null;

  // Prioritize hits that break the most enclosures
  allHits.sort((a, b) => b.enclosuresBroken - a.enclosuresBroken);

  // Collect up to maxHits distinct opportunities (no overlapping tiles)
  const usedTiles = new Set<number>();
  const targets: TilePos[] = [];
  let picked = 0;
  for (const hit of allHits) {
    if (picked >= maxHits) break;
    const overlaps = hit.tiles.some((tile) =>
      usedTiles.has(packTile(tile.row, tile.col)),
    );
    if (overlaps) continue;
    for (const tile of hit.tiles) {
      usedTiles.add(packTile(tile.row, tile.col));
      targets.push(tile);
    }
    picked++;
  }

  return targets.length > 0 ? orderByNearest(targets) : null;
}

/** Plan an ice trench to block enemy grunts crossing the frozen river.
 *  Builds two wings from an anchor point near the AI's most threatened tower,
 *  each extending diagonally toward the enemy zone.  Shape adapts to the ice
 *  layout — produces V shapes on diagonal rivers, U shapes on straight ones.
 *  Only fires when enemy grunts are on the opposite side heading toward us. */
export function planIceTrench(
  state: BattleViewState,
  playerId: ValidPlayerId,
  rng: Rng,
): TilePos[] | null {
  const frozenTiles = state.modern?.frozenTiles;
  if (!frozenTiles || frozenTiles.size === 0) return null;

  const player = state.players[playerId]!;
  if (player.ownedTowers.length === 0) return null;
  const playerZone = state.playerZones[playerId];

  const bankGrunts = collectBankGrunts(state, frozenTiles, playerZone);
  if (bankGrunts.length === 0) return null;

  const shoreline = findIceShoreline(state, frozenTiles, playerZone);
  if (shoreline.length === 0) return null;

  const bestAnchorKey = pickAnchor(shoreline, bankGrunts, rng);
  const anchor = unpackTile(bestAnchorKey as TileKey);

  const inward = inwardFromShore(state, anchor, playerZone);
  if (!inward) return null;

  const trenchKeys = buildUTrench(frozenTiles, anchor, bestAnchorKey, inward);

  const result: TilePos[] = [];
  for (const key of trenchKeys) {
    const { r, c } = unpackTile(key as TileKey);
    result.push({ row: r, col: c });
  }
  return result.length > 0 ? orderByNearest(result) : null;
}

export function pickTarget(
  state: BattleViewState,
  playerId: ValidPlayerId,
  crosshair: PixelPos,
  focusFirePlayerId: ValidPlayerId | undefined,
  shotCounts: Map<number, number>,
  targetMemory: BattleTargetMemory,
  rng: Rng,
  wallsOnly?: boolean,
  battleTactics = 2,
): StrategicPixelPos | null {
  const rand = () => rng.next();
  // Second half of battle: 1/4 chance to switch to the other enemy.
  // Gated on `battleCountdown <= 0` so the check only fires once battle
  // is actually running. During the countdown (battleCountdown > 0),
  // pickTarget is also called from `tickCountdown`, but `state.timer`
  // still reflects the prior phase's value (≈ 0 in modern-with-modifier
  // because MODIFIER_REVEAL decayed it; BATTLE_TIMER in classic) — both
  // paths must agree, and only post-countdown is "second half" meaningful.
  const secondHalf =
    state.battleCountdown <= 0 && state.timer <= BATTLE_SECOND_HALF_TIMER;
  const switchTarget =
    secondHalf &&
    focusFirePlayerId != null &&
    rand() < TARGET_SWITCH_PROBABILITY;

  const targets = collectEnemyTargets(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    shotCounts,
    wallsOnly,
  );

  // Filter out any target tile that already has a cannonball in flight
  const filtered = targets.filter(
    (tile) => !isTileTargetedByInFlightBall(state, tile.row, tile.col),
  );
  if (filtered.length === 0) return null;

  const currentRow = crosshair.y / TILE_SIZE;
  const currentCol = crosshair.x / TILE_SIZE;

  // Supply-ship targeting — first early gate so it competes fairly with
  // the other tactical picks. Skipped during `wallsOnly` (grunt-sweep
  // mode) since that mode is explicitly about clearing grunts off our
  // territory, not chasing river bonuses. Gated on `supplyShips != null`
  // so the rng roll only happens when ships are actually present —
  // preserves classic-mode determinism (no extra rng consumption when
  // the modifier is inactive).
  const supplyShips = state.modern?.supplyShips;
  if (!wallsOnly && supplyShips != null) {
    const shipProb = traitLookup(battleTactics, [
      0,
      SUPPLY_SHIP_TARGET_PROBABILITY,
      2 * SUPPLY_SHIP_TARGET_PROBABILITY,
    ] as const);
    if (rand() < shipProb) {
      const cannons = state.players[playerId]!.cannons;
      let sumRow = 0;
      let sumCol = 0;
      for (const cannon of cannons) {
        sumRow += cannon.row;
        sumCol += cannon.col;
      }
      const shooterTile = {
        row: sumRow / cannons.length,
        col: sumCol / cannons.length,
      };
      const shipTarget = pickSupplyShipTarget(supplyShips, shooterTile, rng);
      if (shipTarget) {
        return { x: shipTarget.x, y: shipTarget.y };
      }
    }
  }

  // Strategic targeting — controlled by battleTactics
  const strategicProb = traitLookup(battleTactics, [
    0,
    STRATEGIC_TARGET_PROBABILITY,
    1 / 2,
  ] as const);
  if (rand() < strategicProb) {
    const strategic = collectStrategicWallTargets(
      state,
      playerId,
      focusFirePlayerId,
    );
    if (strategic.length > 0) {
      // Prefer closer strategic targets
      const jitter = pickJitteredNearestTarget(
        strategic,
        currentRow,
        currentCol,
        rand,
      );
      return {
        x: jitter.x,
        y: jitter.y,
        strategic: true,
      };
    }
  }

  // Grunt-blocking targeting — controlled by battleTactics
  const gruntWallProb = traitLookup(battleTactics, [
    0,
    GRUNT_WALL_TARGET_PROBABILITY,
    1 / 4,
  ] as const);
  if (rand() < gruntWallProb) {
    const gruntWalls = collectGruntBlockingWallTargets(state, playerId);
    if (gruntWalls.length > 0) {
      // Prefer closer grunt-wall targets
      const jitter = pickJitteredNearestTarget(
        gruntWalls,
        currentRow,
        currentCol,
        rand,
      );
      return {
        x: jitter.x,
        y: jitter.y,
      };
    }
  }

  // Prefer priority targets (cannons we already shot at) to finish them off
  const priorityTargets = filtered.filter((target) => target.priority);
  if (priorityTargets.length > 0) {
    const target = pickSweetSpotTarget(
      priorityTargets,
      currentRow,
      currentCol,
      rand,
    );
    return jitterWithinTile(target.row, target.col, rand);
  }

  // Fresh cannon targeting — without this, enclosure-wall sieging always wins
  // and undamaged cannons are never shot. Damaged cannons already fire above.
  const freshCannonProb = traitLookup(battleTactics, [
    0,
    FRESH_CANNON_TARGET_PROBABILITY,
    1 / 2,
  ] as const);
  if (rand() < freshCannonProb) {
    const freshCannons = filtered.filter(
      (cand) => cand.isCannon && !cand.priority,
    );
    if (freshCannons.length > 0) {
      const target = pickSweetSpotTarget(
        freshCannons,
        currentRow,
        currentCol,
        rand,
      );
      return jitterWithinTile(target.row, target.col, rand);
    }
  }

  // Pick a random enclosure of the enemy, then target a wall bordering it.
  // This distributes fire across the enemy's fortress instead of clustering
  // near the AI's crosshair (which starts at the AI's own home tower).
  // `targetMemory` keeps the AI locked onto one enclosure across shots so
  // it doesn't oscillate between enclosures 10-15 tiles apart.
  const enclosureWall = pickEnclosureWallTarget(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    targetMemory,
    rand,
  );
  if (enclosureWall)
    return jitterWithinTile(enclosureWall.row, enclosureWall.col, rand);

  // Fallback: sweet-spot pick from the flat candidate pool.
  const target = pickSweetSpotTarget(filtered, currentRow, currentCol, rand);
  // Jitter within the target tile (never spill into adjacent tiles)
  return jitterWithinTile(target.row, target.col, rand);
}

export function trackShot(
  state: BattleViewState,
  playerId: ValidPlayerId,
  crosshair: PixelPos,
  shotCounts: Map<number, number>,
): void {
  const row = pxToTile(crosshair.y);
  const col = pxToTile(crosshair.x);
  for (const other of filterActiveEnemies(state, playerId)) {
    for (let idx = 0; idx < other.cannons.length; idx++) {
      const cannon = other.cannons[idx]!;
      if (isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        const key = shotCountKey(other.id, idx as CannonIdx);
        shotCounts.set(key, (shotCounts.get(key) ?? 0) + 1);
        return;
      }
    }
  }
}

/** Plan a grunt sweep: chain-fire at enemy grunts attacking a specific player,
 *  ordered by nearest neighbor from a random start.
 *  @param victimPlayerId — the player whose territory the grunts are attacking
 *    (the AI when called for our own defense; an enemy when called by
 *    `planCharitySweep` to clean up someone who can't fight back).
 *  Grunts are ownerless: "attacking the victim" means "currently sitting
 *  in the victim's zone", per the rule that grunts attack towers in
 *  their current territory. */
export function planGruntSweep(
  state: BattleViewState,
  victimPlayerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const victimZone = state.playerZones[victimPlayerId];
  const grunts = state.grunts.filter(
    (grunt) => zoneAt(state.map, grunt.row, grunt.col) === victimZone,
  );
  const mod = state.modern?.activeModifier;
  const threshold =
    mod === MODIFIER_ID.GRUNT_SURGE || mod === MODIFIER_ID.FROZEN_RIVER
      ? GRUNT_SWEEP_THRESHOLD_MODIFIER
      : GRUNT_SWEEP_THRESHOLD;
  if (grunts.length <= threshold) return null;
  const positions = grunts.map((grunt) => ({ row: grunt.row, col: grunt.col }));
  // Random starting point
  const startIndex = rng.int(0, positions.length - 1);
  [positions[0], positions[startIndex]] = [
    positions[startIndex]!,
    positions[0]!,
  ];
  return orderByNearest(positions, usableCannonCount);
}

/** Precondition: collect grunts on the opposite bank (enemy zone, 4-dir
 *  adjacent to frozen water). Grunts are ownerless — partition by current
 *  zone, not by any stored "victim" field. */
function collectBankGrunts(
  state: BattleViewState,
  frozenTiles: ReadonlySet<number>,
  playerZone: ZoneId | undefined,
): TilePos[] {
  const out: TilePos[] = [];
  for (const grunt of state.grunts) {
    const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
    if (gruntZone === undefined || gruntZone === playerZone) continue;
    for (const [dr, dc] of DIRS_4) {
      const nr = grunt.row + dr;
      const nc = grunt.col + dc;
      if (!inBounds(nr, nc)) continue;
      if (frozenTiles.has(packTile(nr, nc))) {
        out.push({ row: grunt.row, col: grunt.col });
        break;
      }
    }
  }
  return out;
}

/** Frozen tiles 4-dir adjacent to AI-zone grass — the shore from which the
 *  trench will extend across the river. */
function findIceShoreline(
  state: BattleViewState,
  frozenTiles: ReadonlySet<number>,
  playerZone: ZoneId | undefined,
): number[] {
  const out: number[] = [];
  for (const key of frozenTiles) {
    const { r, c } = unpackTile(key as TileKey);
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      if (
        isGrass(state.map.tiles, nr, nc) &&
        zoneAt(state.map, nr, nc) === playerZone
      ) {
        out.push(key);
        break;
      }
    }
  }
  return out;
}

/** Score each shoreline tile by distance to the nearest bank grunt, then
 *  pick randomly among the top 5 for variety. */
function pickAnchor(
  shoreline: readonly number[],
  bankGrunts: readonly TilePos[],
  rng: Rng,
): number {
  const scored = shoreline.map((shoreKey) => {
    const { r, c } = unpackTile(shoreKey as TileKey);
    let minDist = Infinity;
    for (const grunt of bankGrunts) {
      const dist = manhattanDistance(grunt.row, grunt.col, r, c);
      if (dist < minDist) minDist = dist;
    }
    return { key: shoreKey, dist: minDist };
  });
  scored.sort((a, b) => a.dist - b.dist);
  const topCount = Math.min(scored.length, 5);
  return scored[rng.int(0, topCount - 1)]!.key;
}

/** Direction from the anchor pointing across the river (opposite of the
 *  cardinal that lands on AI-zone grass). null if the anchor is unexpectedly
 *  not adjacent to AI-zone grass. */
function inwardFromShore(
  state: BattleViewState,
  anchor: { r: number; c: number },
  playerZone: ZoneId | undefined,
): readonly [number, number] | null {
  for (const [dr, dc] of DIRS_4) {
    const nr = anchor.r + dr;
    const nc = anchor.c + dc;
    if (!inBounds(nr, nc)) continue;
    if (zoneAt(state.map, nr, nc) === playerZone) {
      return [-dr, -dc] as const;
    }
  }
  return null;
}

/** U-shape trench: base walks laterally along the shore from the anchor,
 *  arms then curve diagonally inward from each base end toward the enemy. */
function buildUTrench(
  frozenTiles: ReadonlySet<number>,
  anchor: { r: number; c: number },
  anchorKey: number,
  inward: readonly [number, number],
): Set<number> {
  const lateral1: [number, number] = inward[0] === 0 ? [1, 0] : [0, 1];
  const lateral2: [number, number] = inward[0] === 0 ? [-1, 0] : [0, -1];

  const trenchKeys = new Set<number>();
  trenchKeys.add(anchorKey);

  const armStarts: [number, number][] = [];
  for (const lateral of [lateral1, lateral2]) {
    const end = walkAlongIce(
      frozenTiles,
      trenchKeys,
      anchor.r,
      anchor.c,
      (cr, cc) => [cr + lateral[0], cc + lateral[1]],
      ICE_TRENCH_BASE_HALF,
    );
    armStarts.push(end);
  }

  for (let idx = 0; idx < armStarts.length; idx++) {
    const [startR, startC] = armStarts[idx]!;
    const lateral = idx === 0 ? lateral1 : lateral2;
    walkAlongIce(
      frozenTiles,
      trenchKeys,
      startR,
      startC,
      (cr, cc) => {
        // Prefer diagonal, fall back to straight inward.
        const diagR = cr + inward[0] + lateral[0];
        const diagC = cc + inward[1] + lateral[1];
        if (inBounds(diagR, diagC) && frozenTiles.has(packTile(diagR, diagC))) {
          return [diagR, diagC];
        }
        return [cr + inward[0], cc + inward[1]];
      },
      ICE_TRENCH_ARM_LENGTH,
    );
  }

  return trenchKeys;
}

/** Walk up to `maxSteps` along frozen tiles, adding each to `trenchKeys`.
 *  `nextStep` picks the next (row, col) from the current cursor. Stops on
 *  out-of-bounds or non-frozen tile. Returns the final cursor position. */
function walkAlongIce(
  frozenTiles: ReadonlySet<number>,
  trenchKeys: Set<number>,
  startR: number,
  startC: number,
  nextStep: (cr: number, cc: number) => [number, number],
  maxSteps: number,
): [number, number] {
  let cr = startR;
  let cc = startC;
  for (let step = 0; step < maxSteps; step++) {
    const [nr, nc] = nextStep(cr, cc);
    if (!inBounds(nr, nc)) break;
    const tileKey = packTile(nr, nc);
    if (!frozenTiles.has(tileKey)) break;
    trenchKeys.add(tileKey);
    cr = nr;
    cc = nc;
  }
  return [cr, cc];
}

function collectStrategicWallTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
): TilePos[] {
  const strategic: TilePos[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (focusFirePlayerId != null && other.id !== focusFirePlayerId) continue;
    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
      // Skip walls already targeted by a cannonball in flight
      if (isTileTargetedByInFlightBall(state, wallRow, wallCol)) continue;
      // Track obstacle directions: [north, south, west, east]
      const obstacles = computeCardinalObstacleMask(state, wallRow, wallCol, {
        excludeBalloonCannons: true,
      });
      // Require 2+ obstacles with at least one opposite pair (N/S or W/E)
      const total = obstacles.filter(Boolean).length;
      const hasOpposite =
        (obstacles[0] && obstacles[1]) || (obstacles[2] && obstacles[3]);
      if (total >= 2 && hasOpposite)
        strategic.push({ row: wallRow, col: wallCol });
    }
  }
  return strategic;
}

function collectGruntBlockingWallTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
): TilePos[] {
  const gruntWalls: TilePos[] = [];
  const myZone = state.playerZones[playerId];
  for (const grunt of state.grunts) {
    const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
    // Skip grunts in my own zone (they attack me — not a "charity" target).
    if (gruntZone === undefined || gruntZone === myZone) continue;
    if (grunt.targetTowerIdx == null) continue;
    const tower = getGruntTargetTower(state, grunt);
    if (!tower) continue;
    // "Enemy" = owner of the zone the grunt is currently in (the player
    // it's attacking, under the current-zone attack rule).
    const enemyId = state.playerZones.indexOf(gruntZone);
    const enemy = enemyId >= 0 ? state.players[enemyId] : undefined;
    if (!enemy || isPlayerEliminated(enemy)) continue;
    let bestTowerRow = tower.row,
      bestTowerCol = tower.col,
      bestDistance = Infinity;
    for (let tileRow = tower.row; tileRow < tower.row + TOWER_SIZE; tileRow++) {
      for (
        let tileCol = tower.col;
        tileCol < tower.col + TOWER_SIZE;
        tileCol++
      ) {
        const distance = manhattanDistance(
          tileRow,
          tileCol,
          grunt.row,
          grunt.col,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestTowerRow = tileRow;
          bestTowerCol = tileCol;
        }
      }
    }
    const dr = Math.sign(bestTowerRow - grunt.row);
    const dc = Math.sign(bestTowerCol - grunt.col);
    const dirs: [number, number][] = [];
    if (dr !== 0) dirs.push([dr, 0]);
    if (dc !== 0) dirs.push([0, dc]);
    for (const [ddr, ddc] of dirs) {
      const nr = grunt.row + ddr;
      const nc = grunt.col + ddc;
      const neighborKey = packTile(nr, nc);
      if (
        enemy.walls.has(neighborKey) &&
        !isTileTargetedByInFlightBall(state, nr, nc)
      ) {
        gruntWalls.push({ row: nr, col: nc });
      }
    }
  }
  return gruntWalls;
}

function collectEnemyTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
  shotCounts: Map<number, number>,
  wallsOnly?: boolean,
): TargetCandidate[] {
  const targets: TargetCandidate[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;

    if (!wallsOnly) {
      for (let idx = 0; idx < other.cannons.length; idx++) {
        const cannon = other.cannons[idx]!;
        if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
        if (
          state.capturedCannons.some(
            (cc) => cc.cannon === cannon && cc.capturerId === playerId,
          )
        ) {
          continue;
        }
        // Skip if we've already fired enough shots to destroy it
        const key = shotCountKey(other.id, idx as CannonIdx);
        const shots = shotCounts.get(key) ?? 0;
        if (shots >= state.cannonMaxHp) continue;
        const size = cannonSize(cannon.mode);
        const targetRow = cannon.row + (size - 1) / 2;
        const targetCol = cannon.col + (size - 1) / 2;
        targets.push({
          row: targetRow,
          col: targetCol,
          priority: shots > 0,
          isCannon: true,
        });
      }
    }

    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
      // Prioritize already-damaged reinforced walls (one more hit destroys them)
      targets.push({
        row: wallRow,
        col: wallCol,
        priority: other.damagedWalls.has(key),
      });
    }
  }

  return targets;
}

/** Stable numeric key for shotCounts: survives cannon object replacement. */
function shotCountKey(playerId: ValidPlayerId, cannonIdx: CannonIdx): number {
  return (playerId << 8) | cannonIdx;
}

/** Pick an enclosure of an eligible enemy, then return a random wall
 *  bordering it (skipping tiles already targeted by in-flight cannonballs).
 *  Reuses the cached enclosure from `targetMemory` if its anchor tile is
 *  still interior to an eligible enemy; otherwise picks a new random
 *  enclosure and updates the memory. Returns null when no enclosure has
 *  untargeted border walls. */
function pickEnclosureWallTarget(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
  targetMemory: BattleTargetMemory,
  rand: () => number,
): TilePos | null {
  // Collect all enclosures across eligible enemies, tagged with their owner
  type CachedEnclosure = {
    ownerId: ValidPlayerId;
    walls: ReadonlySet<number>;
    tiles: number[];
  };
  const allEnclosures: CachedEnclosure[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;
    const interior = getBattleInterior(other);
    if (interior.size === 0) continue;
    const components = findEnclosureComponents(interior);
    for (const comp of components) {
      allEnclosures.push({
        ownerId: other.id,
        walls: other.walls,
        tiles: comp,
      });
    }
  }
  if (allEnclosures.length === 0) {
    targetMemory.ownerId = undefined;
    targetMemory.anchorTileKey = undefined;
    return null;
  }

  // Try to reuse the cached enclosure: find the component that still contains
  // the anchor tile (owner must match too, so focus-fire switches re-pick).
  let enclosure: CachedEnclosure | undefined;
  if (targetMemory.anchorTileKey !== undefined) {
    const anchor = targetMemory.anchorTileKey;
    const ownerId = targetMemory.ownerId;
    for (const candidate of allEnclosures) {
      if (candidate.ownerId !== ownerId) continue;
      if (candidate.tiles.includes(anchor)) {
        enclosure = candidate;
        break;
      }
    }
  }

  if (enclosure === undefined) {
    // Pick a random enclosure (uniform — every enclosure equally likely)
    enclosure = allEnclosures[Math.floor(rand() * allEnclosures.length)]!;
    targetMemory.ownerId = enclosure.ownerId;
    targetMemory.anchorTileKey = enclosure.tiles[0];
  }

  // Find walls bordering this enclosure (4-dir adjacent to an enclosure tile)
  const enclosureTileSet = new Set(enclosure.tiles);
  const seen = new Set<number>();
  const borderWalls: TilePos[] = [];
  for (const key of enclosureTileSet) {
    const { r, c } = unpackTile(key as TileKey);
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      const neighborKey = packTile(nr, nc);
      if (
        !seen.has(neighborKey) &&
        enclosure.walls.has(neighborKey) &&
        !isTileTargetedByInFlightBall(state, nr, nc)
      ) {
        seen.add(neighborKey);
        borderWalls.push({ row: nr, col: nc });
      }
    }
  }
  if (borderWalls.length === 0) return null;
  return borderWalls[Math.floor(rand() * borderWalls.length)]!;
}

/** True if any cannonball in flight is targeting (row, col). */
function isTileTargetedByInFlightBall(
  state: BattleViewState,
  row: number,
  col: number,
): boolean {
  return state.cannonballs.some((b) => ballTargeting(b, row, col));
}

/** True if a cannonball in flight is targeting (row, col). */
function ballTargeting(
  b: Pick<Cannonball, "targetY" | "targetX">,
  row: number,
  col: number,
): boolean {
  return pxToTile(b.targetY) === row && pxToTile(b.targetX) === col;
}

function isEnemyEligibleForFocus(
  enemyId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
): boolean {
  if (focusFirePlayerId == null) return true;
  if (!switchTarget) return enemyId === focusFirePlayerId;
  return enemyId !== focusFirePlayerId;
}

function pickSweetSpotTarget(
  targets: readonly TargetCandidate[],
  currentRow: number,
  currentCol: number,
  rand: () => number,
): TargetCandidate {
  const sweetSpot =
    SWEET_SPOT_MIN_DISTANCE + rand() * SWEET_SPOT_DISTANCE_RANGE;
  const sorted = [...targets].sort((a, b) => {
    const distanceA = Math.abs(
      manhattanDistance(a.row, a.col, currentRow, currentCol) - sweetSpot,
    );
    const distanceB = Math.abs(
      manhattanDistance(b.row, b.col, currentRow, currentCol) - sweetSpot,
    );
    return distanceA - distanceB;
  });
  return pickRandomFromTop(sorted, TOP_TARGET_PICK_COUNT, rand);
}

function pickJitteredNearestTarget(
  targets: readonly TilePos[],
  currentRow: number,
  currentCol: number,
  rand: () => number,
): PixelPos {
  const sorted = sortByDistanceFrom(targets, currentRow, currentCol);
  const target = pickRandomFromTop(sorted, TOP_TARGET_PICK_COUNT, rand);
  return jitterWithinTile(target.row, target.col, rand);
}

/** Sort targets by Manhattan distance from a reference tile, returning a new array. */
function sortByDistanceFrom(
  targets: readonly TilePos[],
  refRow: number,
  refCol: number,
): TilePos[] {
  return [...targets].sort(
    (a, b) =>
      manhattanDistance(a.row, a.col, refRow, refCol) -
      manhattanDistance(b.row, b.col, refRow, refCol),
  );
}

function pickRandomFromTop<T>(
  items: readonly T[],
  topCount: number,
  rand: () => number,
): T {
  const count = Math.min(topCount, items.length);
  return items[Math.floor(rand() * count)]!;
}

function jitterWithinTile(
  row: number,
  col: number,
  rand: () => number,
): PixelPos {
  // Keep shots close to the tile center with at most ±TILE_SIZE/4 of
  // random offset. Wide jitter (full-tile minus margin) made AI fire
  // scatter into neighbouring walls and miss their intended target.
  const jitterRange = TILE_SIZE / 2; // full spread = ±TILE_SIZE/4
  const centerX = col * TILE_SIZE + TILE_SIZE / 2;
  const centerY = row * TILE_SIZE + TILE_SIZE / 2;
  return {
    x: centerX + (rand() - 0.5) * jitterRange,
    y: centerY + (rand() - 0.5) * jitterRange,
  };
}

/** Check if a 4-tile pocket forms a 2x2 square (can fit a cannon). */
function is2x2(keys: readonly number[]): boolean {
  const tiles = keys.map((key) => unpackTile(key as TileKey));
  const minRow = Math.min(...tiles.map((tile) => tile.r));
  const minCol = Math.min(...tiles.map((tile) => tile.c));
  const expected: Set<number> = new Set([
    packTile(minRow, minCol),
    packTile(minRow, minCol + 1),
    packTile(minRow + 1, minCol),
    packTile(minRow + 1, minCol + 1),
  ]);
  return keys.length === 4 && keys.every((key) => expected.has(key));
}

/** Analyse a player's walls and find single- or double-tile removals that
 *  breach 2+ large enclosures at once.  Only enclosures larger than
 *  DESTROY_POCKET_MAX_SIZE are considered (smaller ones are pockets). */
function findStructuralHits(
  walls: ReadonlySet<number>,
  mapTiles: GameMap["tiles"],
): StructuralHitCandidate[] {
  // 1. Compute outside and interior
  const outside = computeOutside(walls);
  const interior = new Set<number>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key) && isGrass(mapTiles, row, col)) {
        interior.add(key);
      }
    }
  }

  // 2. Connected components of interior (4-dir) — each is an enclosure
  const components = findEnclosureComponents(interior);

  // Only consider large enclosures (> DESTROY_POCKET_MAX_SIZE tiles)
  const large = components.filter(
    (comp) => comp.length > DESTROY_POCKET_MAX_SIZE,
  );
  if (large.length < 2) return [];

  // Label each interior tile with its large-enclosure index
  const labels = new Map<number, number>();
  for (let idx = 0; idx < large.length; idx++) {
    for (const key of large[idx]!) labels.set(key, idx);
  }

  // 3. Find outer-shell walls (8-dir adjacent to outside)
  const outerWalls: number[] = [];
  for (const wallKey of walls) {
    const { r, c } = unpackTile(wallKey as TileKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        outerWalls.push(wallKey);
        break;
      }
    }
  }

  // 4. Single-tile structural hits
  const hits: StructuralHitCandidate[] = [];
  for (const wallKey of outerWalls) {
    const bordered = borderedEnclosures(wallKey, labels);
    if (bordered.size < 2) continue;

    const modWalls = new Set(walls);
    modWalls.delete(wallKey);
    const broken = countBrokenEnclosures(modWalls, large);
    if (broken >= 2) {
      const { r, c } = unpackTile(wallKey as TileKey);
      hits.push({ tiles: [{ row: r, col: c }], enclosuresBroken: broken });
    }
  }

  // 5. Two-tile pairs (only when no single-tile hits exist)
  if (hits.length === 0) {
    for (const wallKey of outerWalls) {
      const { r, c } = unpackTile(wallKey as TileKey);
      for (const [dr, dc] of DIRS_4) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        // Deduplicate pairs and ensure neighbor is also a wall
        if (!walls.has(neighborKey) || neighborKey <= wallKey) continue;

        const bordered = borderedEnclosuresPair(wallKey, neighborKey, labels);
        if (bordered.size < 2) continue;

        const modWalls = new Set(walls);
        modWalls.delete(wallKey);
        modWalls.delete(neighborKey);
        const broken = countBrokenEnclosures(modWalls, large);
        if (broken >= 2) {
          const { r: nr2, c: nc2 } = unpackTile(neighborKey);
          hits.push({
            tiles: [
              { row: r, col: c },
              { row: nr2, col: nc2 },
            ],
            enclosuresBroken: broken,
          });
        }
      }
    }
  }

  return hits;
}

/** Which large-enclosure indices does a pair of wall tiles border? (8-dir) */
function borderedEnclosuresPair(
  keyA: number,
  keyB: number,
  labels: ReadonlyMap<number, number>,
): Set<number> {
  const result = borderedEnclosures(keyA, labels);
  for (const label of borderedEnclosures(keyB, labels)) result.add(label);
  return result;
}

/** Which large-enclosure indices does a wall tile border? (8-dir) */
function borderedEnclosures(
  wallKey: number,
  labels: ReadonlyMap<number, number>,
): Set<number> {
  const { r, c } = unpackTile(wallKey as TileKey);
  const result = new Set<number>();
  for (const [dr, dc] of DIRS_8) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const label = labels.get(packTile(nr, nc));
    if (label !== undefined) result.add(label);
  }
  return result;
}

/** Simulate wall removal and count how many enclosures now have tiles
 *  reachable from map edges (breached by the 8-dir flood). */
function countBrokenEnclosures(
  modifiedWalls: ReadonlySet<number>,
  enclosures: readonly (readonly number[])[],
): number {
  const newOutside = computeOutside(modifiedWalls);
  let broken = 0;
  for (const comp of enclosures) {
    for (const tileKey of comp) {
      if (newOutside.has(tileKey)) {
        broken++;
        break;
      }
    }
  }
  return broken;
}

/** Find connected components of a tile set using 4-dir connectivity. */
function findEnclosureComponents(tileSet: ReadonlySet<number>): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];
  for (const key of tileSet) {
    if (visited.has(key)) continue;
    const component: number[] = [];
    const queue = [key];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      component.push(current);
      const { r, c } = unpackTile(current as TileKey);
      for (const [dr, dc] of DIRS_4) {
        const neighborKey = packTile(r + dr, c + dc);
        if (!visited.has(neighborKey) && tileSet.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push(neighborKey);
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** Random walk to find up to maxLength connected wall tiles. */
function findConnectedWalls(
  walls: ReadonlySet<number>,
  startKey: number,
  maxLength: number,
  rng: Rng,
): number[] {
  const visited = new Set<number>();
  visited.add(startKey);
  const result: number[] = [startKey];
  let current = startKey;
  while (result.length < maxLength) {
    const { r, c } = unpackTile(current as TileKey);
    const neighbors: number[] = [];
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (!visited.has(neighborKey) && walls.has(neighborKey))
        neighbors.push(neighborKey);
    }
    if (neighbors.length === 0) break;
    current = rng.pick(neighbors);
    visited.add(current);
    result.push(current);
  }
  return result;
}
