/**
 * AI tactic — enclosure denial. Defensive players lose lives by failing to
 * re-enclose ANY tower at end of build (not grunt tower-kills), so this finds
 * the enemy tower the defender can most cheaply re-enclose and concentrates
 * fire on the walls at that ring's structural min-cut — the bottleneck any
 * ring must pass, boxed in by water / pits / border so re-routing is
 * impossible. Reuses the build planner's `findEnclosureCut` (same min-cut).
 */

import { filterActiveEnemies } from "../shared/core/board-occupancy.ts";
import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  DIRS_8,
  inBounds,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { isRingWallable } from "./ai-castle-rect.ts";
import { type EnclosureSeed, findEnclosureCut } from "./ai-min-cut.ts";

/** Empty wall set: passed to `findEnclosureCut` so the cut is the GEOGRAPHIC
 *  ring bottleneck (independent of current battle damage). */
const NO_WALLS: ReadonlySet<TileKey> = new Set();
/** Cap on towers analysed per enemy (each costs one min-cut max-flow). */
const MAX_TOWERS_CONSIDERED = 3;
/** Hard cap on the returned chain length, regardless of usable cannons. */
const MAX_CHAIN_TILES = 12;
/** How many of the most boxed-in tiles are eligible to start the breach walk.
 *  >1 so two attackers on the same ring open the breach at different points. */
const BREACH_START_CANDIDATES = 3;

/**
 * Plan an enclosure-denial chain against `focusEnemyId` (or, when unset, the
 * weakest active enemy). Returns the ordered wall tiles to siege, or null when
 * no eligible enemy / bottleneck wall exists (caller falls through to the next
 * tactic).
 */
export function planDenyEnclosure(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemy = pickTargetEnemy(state, playerId, focusEnemyId, rng);
  if (!enemy) return null;

  const bottleneck = cheapestRingBottleneck(state, enemy, rng);
  if (!bottleneck) return null;

  // Walls the defender's cheapest ring runs through: the live walls sitting ON
  // the min-cut bottleneck. Earlier this also swept in walls cardinally BESIDE
  // the cut, which pulled in a redundant parallel layer — a doubled corner cap
  // one tile off the chokepoint, sitting behind the wall that actually seals
  // the ring. Destroying that inner/outer shell breaches nothing (the on-cut
  // wall still encloses, so the defender need not even repair it) and worse
  // hands them free interior tiles to re-place cannons on. Only walls on the
  // bottleneck itself force a rebuild at the unroutable chokepoint.
  const targetKeys: TileKey[] = [];
  for (const wallKey of enemy.walls) {
    if (bottleneck.has(wallKey)) {
      targetKeys.push(wallKey);
    }
  }
  if (targetKeys.length === 0) return null;

  // Most boxed-in (hardest to re-route) first, then a nearest-neighbour walk so
  // consecutive shots concentrate into one breach.
  const tiles = targetKeys
    .map((key) => unpackTile(key))
    .sort(
      (a, b) =>
        chokepointSeverity(state, b) - chokepointSeverity(state, a) ||
        packTile(a.row, a.col) - packTile(b.row, b.col),
    );
  // Vary which high-severity tile opens the breach so two attackers sieging the
  // same ring don't walk an identical tile list — pick among the most boxed-in
  // candidates and rotate it to the front of the nearest-neighbour walk.
  const startIdx = rng.int(
    0,
    Math.min(BREACH_START_CANDIDATES, tiles.length) - 1,
  );
  if (startIdx > 0) tiles.unshift(tiles.splice(startIdx, 1)[0]!);
  const limit = Math.min(usableCannonCount * 2, MAX_CHAIN_TILES);
  const ordered = orderByNearest(tiles, limit);
  return ordered.length > 0 ? ordered : null;
}

/** The enemy to deny: the focus-fire target when it's still active, else an
 *  RNG-weighted pick over the weakest-first ranking (the same "weakest" order
 *  `planBattle` uses) — favouring the weakest defender but not always picking
 *  it, so independent attackers spread across defenders instead of ganging up. */
function pickTargetEnemy(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
  rng: Rng,
): Player | undefined {
  const enemies = filterActiveEnemies(state, playerId);
  if (enemies.length === 0) return undefined;
  if (focusEnemyId !== undefined) {
    const focus = enemies.find((enemy) => enemy.id === focusEnemyId);
    if (focus) return focus;
  }
  return pickWeightedTargetEnemy(enemies, rng);
}

/**
 * Pick a target enemy with RNG weighting toward weaker defenders (fewest
 * enclosed alive towers, then lowest score). The weakest is favoured but not
 * guaranteed, so multiple independent attackers don't all converge on the
 * single weakest player. Exported for `planBattle`'s focus-fire selection so
 * both paths share one ranking + weighting rule.
 */
export function pickWeightedTargetEnemy(
  enemies: readonly Player[],
  rng: Rng,
): Player | undefined {
  const ranked = [...enemies].sort(
    (a, b) =>
      a.enclosedTowers.length - b.enclosedTowers.length || a.score - b.score,
  );
  return weightedPickByRank(ranked, rng);
}

/** Min-cut tiles of the enemy tower the defender can most cheaply re-enclose.
 *  Computed with NO walls so the cut is the GEOGRAPHIC bottleneck (where any
 *  ring must pass), independent of current battle damage — the structural
 *  weak point that stays the defender's cheapest option all build. */
function cheapestRingBottleneck(
  state: BattleViewState,
  enemy: Player,
  rng: Rng,
): Set<TileKey> | undefined {
  const cuts: Set<TileKey>[] = [];
  let considered = 0;
  for (const tower of enemy.enclosedTowers) {
    if (considered >= MAX_TOWERS_CONSIDERED) break;
    considered++;
    const seed: EnclosureSeed = {
      tower,
      interior: {
        top: tower.row,
        bottom: tower.row + TOWER_SIZE - 1,
        left: tower.col,
        right: tower.col + TOWER_SIZE - 1,
      },
    };
    const cut = findEnclosureCut([seed], state, NO_WALLS, false);
    // null = unenclosable (defender can't use it); empty = degenerate. Skip both.
    if (!cut || cut.size === 0) continue;
    cuts.push(cut);
  }
  // Favour the cheapest (smallest) ring but allow a costlier one sometimes, so
  // two attackers on the same defender don't always siege the identical ring.
  cuts.sort((a, b) => a.size - b.size);
  return weightedPickByRank(cuts, rng);
}

/** Pick from a best-first-sorted list with linear rank weighting: index 0 (the
 *  best) is most likely, the last least. Returns undefined only when empty. */
function weightedPickByRank<T>(
  sortedBestFirst: readonly T[],
  rng: Rng,
): T | undefined {
  const count = sortedBestFirst.length;
  if (count <= 1) return sortedBestFirst[0];
  const total = (count * (count + 1)) / 2;
  let roll = rng.next() * total;
  for (let rank = 0; rank < count; rank++) {
    const weight = count - rank;
    if (roll < weight) return sortedBestFirst[rank]!;
    roll -= weight;
  }
  return sortedBestFirst[count - 1];
}

/** How boxed-in a candidate wall is: count of its 8-neighbours that block a
 *  re-route — off-map (border) or a non-wallable obstacle (water / pit / tower /
 *  house). The defender cannot route its ring around these, so a higher count
 *  means destroying this wall costs the defender the most. */
function chokepointSeverity(state: BattleViewState, tile: TilePos): number {
  let severity = 0;
  for (const [dr, dc] of DIRS_8) {
    const nr = tile.row + dr;
    const nc = tile.col + dc;
    if (!inBounds(nr, nc)) {
      severity++;
      continue;
    }
    if (!isRingWallable(state, nr, nc, false)) severity++;
  }
  return severity;
}
