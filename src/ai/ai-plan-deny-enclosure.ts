/**
 * AI tactic — enclosure denial. Defenders lose a life by failing to re-enclose
 * a tower. Against an intact ring this leads with the minimum breach cut on the
 * LIVE walls (`findMinBreach`) — fewest shots to open it, a diagonal staircase
 * through any fat layering. Against an already-open defender it craters the
 * GEOGRAPHIC bottleneck of its cheapest ring (`findEnclosureCut` on NO_WALLS).
 */

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
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { rotateBreachForAttacker } from "./ai-attacker-variation.ts";
import { isRingWallable } from "./ai-castle-rect.ts";
import { type EnclosureSeed, findEnclosureCut } from "./ai-min-cut.ts";
import { findMinBreach } from "./ai-strategy-battle.ts";

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
 * Plan an enclosure-denial chain against `focusEnemyId` (or, when unset, a
 * uniformly-chosen active enemy). Returns the ordered wall tiles to siege, or
 * null when no eligible enemy / bottleneck wall exists (caller falls through to
 * the next tactic).
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

  const limit = Math.min(usableCannonCount * 2, MAX_CHAIN_TILES);

  // Intact ring → minimum breach cut against the defender's LIVE walls: the
  // fewest shots that open one of its large enclosures, a diagonal staircase
  // through any fat layering (the flood is 8-connected). This is both the most
  // efficient breach and free of the wasted hits the geographic-bottleneck
  // siege below lands on redundant backing layers — the old approach left a
  // 2-thick ring standing because it only sieged the shorter on-cut layer.
  const breach = findMinBreach(state, enemy, limit);
  if (breach) return rotateBreachForAttacker(breach, playerId);

  // No full breach fits the cannon budget (already-open defender, or an intact
  // ring too thick to open this round). Either way, crater the structural
  // bottleneck of their cheapest ring (computed on NO_WALLS, so it's the
  // geographic chokepoint any rebuilt ring must pass) — those on-cut walls are
  // load-bearing, so destroying them taxes the defender's NEXT build whether or
  // not the ring opens now. This keeps the tactic firing (a repair tax) rather
  // than wasting the chain against thick walls.
  const bottleneck = cheapestRingBottleneck(state, enemy, rng);
  if (!bottleneck) return null;
  const targetKeys: TileKey[] = [];
  for (const wallKey of enemy.walls) {
    if (bottleneck.has(wallKey)) targetKeys.push(wallKey);
  }
  if (targetKeys.length === 0) return null;
  return orderSiegeTiles(state, targetKeys, limit, rng);
}

/** The enemy to attack: the focus-fire target when it's still active, else a
 *  UNIFORM random pick among all active enemies — NEVER weakest-biased.
 *  Every target selection (per-chain enclosure-denial AND the whole-battle
 *  focus-fire commitment) routes through here, so attacks are applied to ANY
 *  defender, including a runaway leader, instead of being perpetually deflected
 *  onto the weakest player while the leader's fortress grows unchecked. */
export function pickTargetEnemy(
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
  if (enemies.length === 1) return enemies[0];
  return enemies[rng.int(0, enemies.length - 1)];
}

/** Order siege targets for chain execution: most boxed-in (hardest to
 *  re-route) first, then a nearest-neighbour walk so consecutive shots
 *  concentrate into one breach. The start tile is rotated among the most
 *  boxed-in candidates so two attackers sieging the same ring don't walk an
 *  identical tile list. Returns null when `keys` is empty. */
function orderSiegeTiles(
  state: BattleViewState,
  keys: readonly TileKey[],
  limit: number,
  rng: Rng,
): TilePos[] | null {
  if (keys.length === 0) return null;
  const tiles = keys
    .map((key) => unpackTile(key))
    .sort(
      (a, b) =>
        chokepointSeverity(state, b) - chokepointSeverity(state, a) ||
        packTile(a.row, a.col) - packTile(b.row, b.col),
    );
  const startIdx = rng.int(
    0,
    Math.min(BREACH_START_CANDIDATES, tiles.length) - 1,
  );
  if (startIdx > 0) tiles.unshift(tiles.splice(startIdx, 1)[0]!);
  const ordered = orderByNearest(tiles, limit);
  return ordered.length > 0 ? ordered : null;
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
