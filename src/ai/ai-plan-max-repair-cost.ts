/**
 * AI tactic — maximise the defender's re-enclosure COST ("rubble siege").
 * deny_enclosure breaks the min-cut (cheapest to break = cheapest to refill);
 * this instead breaks SCATTERED single tiles ≥4 apart at the most repair-
 * constrained ring walls of the defender's smallest enclosure, forcing a
 * separate hard placement per gap (~2.6× more shot-efficient at denial than
 * deny). Shares CHAIN.STRUCTURAL; distinct via the `max_repair_cost` tag.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  DIRS_8,
  inBounds,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { getBattleInterior } from "../shared/sim/board-occupancy.ts";
import { isRingWallable } from "./ai-castle-rect.ts";
import { pickTargetEnemy } from "./ai-plan-deny-enclosure.ts";
import {
  countBrokenEnclosures,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
  isEnclosureBroken,
} from "./ai-strategy-battle.ts";

/** Hard cap on the returned chain length, regardless of usable cannons. */
const MAX_CHAIN_TILES = 12;
/** How many of the most-exposed ring walls are eligible to seed the breach
 *  walk — >1 so two attackers on the same ring open it at different points. */
const BREACH_START_CANDIDATES = 3;
/** Minimum Chebyshev separation between two chosen breach tiles. A wall piece
 *  spans at most 4 tiles, so gaps ≥4 apart can't be bridged by one tetromino —
 *  forcing a SEPARATE placement per gap. 4 keeps each gap its own repair job. */
const MIN_GAP_SEPARATION = 4;

/**
 * Plan a re-enclosure-cost-maximising siege against `focusEnemyId` (or the
 * weakest active enemy). Returns the ordered wall tiles to breach, or null when
 * no eligible enemy / intact enclosure / breaching plan exists (caller falls
 * through to the next tactic).
 */
export function planMaxRepairCost(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const target = pickEnemyLifeline(state, playerId, focusEnemyId, rng);
  if (!target) return null;
  const { enemy, lifeline } = target;

  const ringKeys = ringWalls(enemy.walls, new Set(lifeline));
  if (ringKeys.length === 0) return null;

  const limit = Math.min(usableCannonCount * 2, MAX_CHAIN_TILES);
  const breach = selectExposedBreach(state, ringKeys, limit, rng);
  if (!breach) return null;

  // Validate on the live board: removing the breach must open the enclosure.
  if (planBreaches(enemy.walls, breach, lifeline)) return breach;

  // Fat ring: the inner ring is backed by an off-cut layer. Widen the breach to
  // the walls cardinally beside it (the backing layer) and re-validate.
  const widened = widenToBacking(state, enemy.walls, breach, limit, rng);
  if (widened && planBreaches(enemy.walls, widened, lifeline)) return widened;
  return null;
}

/** Pick the defender to deny and the specific enclosure to attack: a uniformly-
 *  chosen enemy (shared `pickTargetEnemy` — any defender, not just the weakest)
 *  and their SMALLEST intact enclosure — the cheapest one for them to re-close,
 *  hence the lifeline whose repair cost actually gates their survival. Raising
 *  ITS floor is what denies a life. Returns undefined when no eligible enemy /
 *  intact enclosure exists. */
function pickEnemyLifeline(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
  rng: Rng,
): { enemy: Player; lifeline: TileKey[] } | undefined {
  const enemy = pickTargetEnemy(state, playerId, focusEnemyId, rng);
  if (!enemy) return undefined;
  const lifeline = smallestIntactEnclosure(enemy);
  return lifeline ? { enemy, lifeline } : undefined;
}

/** The defender's smallest intact large enclosure (their cheapest re-closure
 *  target), or undefined when none is intact. Same derivation as deny's
 *  `intactLargeEnclosures`: live-interior components above the pocket threshold
 *  the outside flood has not already reached. */
function smallestIntactEnclosure(enemy: Player): TileKey[] | undefined {
  const liveOutside = computeOutside(enemy.walls);
  const intact = findEnclosureComponents(getBattleInterior(enemy))
    .filter((comp) => comp.length > DESTROY_POCKET_MAX_SIZE)
    .filter((comp) => !isEnclosureBroken(comp, liveOutside));
  if (intact.length === 0) return undefined;
  return intact.reduce((best, comp) =>
    comp.length < best.length ? comp : best,
  );
}

/** Live wall tiles forming the enclosure's ring — walls cardinally adjacent to
 *  one of its interior tiles (walls seal 4-directionally). */
function ringWalls(
  walls: ReadonlySet<TileKey>,
  interior: ReadonlySet<TileKey>,
): TileKey[] {
  const ring: TileKey[] = [];
  for (const wallKey of walls) {
    const { row, col } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc) && interior.has(packTile(nr, nc))) {
        ring.push(wallKey);
        break;
      }
    }
  }
  return ring;
}

/** Whether removing every tile of `plan` breaks the enclosure. */
function planBreaches(
  walls: ReadonlySet<TileKey>,
  plan: readonly TilePos[],
  enclosure: readonly TileKey[],
): boolean {
  const modWalls = new Set(walls);
  for (const tile of plan) modWalls.delete(packTile(tile.row, tile.col));
  return countBrokenEnclosures(modWalls, [enclosure]) > 0;
}

/** Widen a breach that an intact fat ring absorbed: add the live walls
 *  cardinally beside each breach tile (the backing layer), re-seeded through
 *  the same exposure walk under the chain budget. */
function widenToBacking(
  state: BattleViewState,
  walls: ReadonlySet<TileKey>,
  breach: readonly TilePos[],
  limit: number,
  rng: Rng,
): TilePos[] | null {
  const keys = new Set<TileKey>();
  for (const tile of breach) {
    keys.add(packTile(tile.row, tile.col));
    for (const [dr, dc] of DIRS_4) {
      const nr = tile.row + dr;
      const nc = tile.col + dc;
      if (!inBounds(nr, nc)) continue;
      const neighbor = packTile(nr, nc);
      if (walls.has(neighbor)) keys.add(neighbor);
    }
  }
  return selectExposedBreach(state, [...keys], limit, rng) ?? null;
}

/** Select SCATTERED single-tile breaches at the most repair-constrained ring
 *  walls, each ≥MIN_GAP_SEPARATION apart so no single tetromino can bridge two.
 *  Re-enclosure is a placement economy: a cannonball removes one tile per shot,
 *  but the defender refills with 4-tile pieces that must land on free in-zone
 *  grass (canPlacePiece). Concentrating shots into one contiguous crater
 *  (deny / the old wide breach) lets ONE piece plug it; scattering the same
 *  shots into N isolated, obstacle-flanked gaps forces N whole-piece
 *  placements — maximising the placement COUNT (and per-gap difficulty) the
 *  defender must complete before the build timer runs out. */
function selectExposedBreach(
  state: BattleViewState,
  ringKeys: readonly TileKey[],
  limit: number,
  rng: Rng,
): TilePos[] | null {
  if (ringKeys.length === 0) return null;
  const tiles = ringKeys.map((key) => unpackTile(key));
  const constrained = new Map<TileKey, number>();
  for (const key of ringKeys) constrained.set(key, repairExposure(state, key));

  // Most-constrained first; rotate the seed among the top few for variety so
  // two attackers on one ring don't pick the identical gap set.
  const sorted = [...tiles].sort(
    (a, b) =>
      constrained.get(packTile(b.row, b.col))! -
        constrained.get(packTile(a.row, a.col))! ||
      packTile(a.row, a.col) - packTile(b.row, b.col),
  );
  const startIdx = rng.int(
    0,
    Math.min(BREACH_START_CANDIDATES, sorted.length) - 1,
  );
  if (startIdx > 0) sorted.unshift(sorted.splice(startIdx, 1)[0]!);

  const chosen: TilePos[] = [];
  for (const tile of sorted) {
    if (chosen.length >= limit) break;
    const tooClose = chosen.some(
      (pick) =>
        Math.max(Math.abs(pick.row - tile.row), Math.abs(pick.col - tile.col)) <
        MIN_GAP_SEPARATION,
    );
    if (!tooClose) chosen.push(tile);
  }
  return chosen.length > 0 ? chosen : null;
}

/** Repair difficulty of a wall tile: how many of its 8-neighbours are barriers
 *  the defender cannot route a replacement ring around — off-map (border) or a
 *  non-wallable obstacle (water / pit / house / cannon / tower). High = a
 *  constrained gap that only specific piece shapes can re-thread (costly to
 *  re-close); low = open field, trivially refilled. NOTE: an earlier variant
 *  scored the INVERSE (open-field walls) on the theory that "no barrier to lean
 *  on = costly"; measured denial was ~3× worse — open field is the EASIEST to
 *  rebuild. The constrained bottleneck is the hard-to-repair spot. */
function repairExposure(state: BattleViewState, key: TileKey): number {
  const { row, col } = unpackTile(key);
  let constrained = 0;
  for (const [dr, dc] of DIRS_8) {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc) || !isRingWallable(state, nr, nc, false))
      constrained++;
  }
  return constrained;
}
