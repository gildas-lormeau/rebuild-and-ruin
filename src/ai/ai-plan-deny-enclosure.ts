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
  DIRS_4,
  DIRS_8,
  inBounds,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import { isRingWallable } from "./ai-castle-rect.ts";
import { type EnclosureSeed, findEnclosureCut } from "./ai-min-cut.ts";

/** Empty wall set: passed to `findEnclosureCut` so the cut is the GEOGRAPHIC
 *  ring bottleneck (independent of current battle damage). */
const NO_WALLS: ReadonlySet<TileKey> = new Set();
/** Cap on towers analysed per enemy (each costs one min-cut max-flow). */
const MAX_TOWERS_CONSIDERED = 3;
/** Hard cap on the returned chain length, regardless of usable cannons. */
const MAX_CHAIN_TILES = 12;

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
): TilePos[] | null {
  const enemy = pickTargetEnemy(state, playerId, focusEnemyId);
  if (!enemy) return null;

  const bottleneck = cheapestRingBottleneck(state, enemy);
  if (!bottleneck) return null;

  // Walls the defender's cheapest ring runs through: the live walls sitting on
  // or cardinally beside the min-cut bottleneck. These are the load-bearing
  // tiles — destroying them forces a rebuild at the unroutable chokepoint.
  const targetKeys: TileKey[] = [];
  for (const wallKey of enemy.walls) {
    if (bottleneck.has(wallKey) || hasCardinalIn(wallKey, bottleneck)) {
      targetKeys.push(wallKey);
    }
  }
  if (targetKeys.length === 0) return null;

  // Deterministic order: most boxed-in (hardest to re-route) first, then a
  // nearest-neighbour walk so consecutive shots concentrate into one breach.
  const tiles = targetKeys
    .map((key) => unpackTile(key))
    .sort(
      (a, b) =>
        chokepointSeverity(state, b) - chokepointSeverity(state, a) ||
        packTile(a.row, a.col) - packTile(b.row, b.col),
    );
  const limit = Math.min(usableCannonCount * 2, MAX_CHAIN_TILES);
  const ordered = orderByNearest(tiles, limit);
  return ordered.length > 0 ? ordered : null;
}

/** The enemy to deny: the focus-fire target when it's still active, else the
 *  weakest active enemy (fewest enclosed alive towers, then lowest score) —
 *  the same "weakest" ranking `planBattle` uses to pick a focus target. */
function pickTargetEnemy(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
): Player | undefined {
  const enemies = filterActiveEnemies(state, playerId);
  if (enemies.length === 0) return undefined;
  if (focusEnemyId !== undefined) {
    const focus = enemies.find((enemy) => enemy.id === focusEnemyId);
    if (focus) return focus;
  }
  return enemies.reduce((weakest, enemy) =>
    enemy.enclosedTowers.length < weakest.enclosedTowers.length ||
    (enemy.enclosedTowers.length === weakest.enclosedTowers.length &&
      enemy.score < weakest.score)
      ? enemy
      : weakest,
  );
}

/** Min-cut tiles of the enemy tower the defender can most cheaply re-enclose.
 *  Computed with NO walls so the cut is the GEOGRAPHIC bottleneck (where any
 *  ring must pass), independent of current battle damage — the structural
 *  weak point that stays the defender's cheapest option all build. */
function cheapestRingBottleneck(
  state: BattleViewState,
  enemy: Player,
): Set<TileKey> | undefined {
  let best: Set<TileKey> | undefined;
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
    if (!best || cut.size < best.size) best = cut;
  }
  return best;
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

/** Whether any cardinal neighbour of `key` is in `set`. */
function hasCardinalIn(key: TileKey, set: ReadonlySet<TileKey>): boolean {
  const { row, col } = unpackTile(key);
  for (const [dr, dc] of DIRS_4) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc) && set.has(packTile(nr, nc))) return true;
  }
  return false;
}
