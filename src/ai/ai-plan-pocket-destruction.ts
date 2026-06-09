/**
 * AI tactic — pocket destruction. Clears the FIRING player's OWN small
 * enclosures (< 2x2 — too small to fit a cannon): fires ONE bordering own
 * wall per pocket to break the enclosure open, then lets the build-phase
 * wall sweep (sweepIsolatedWalls → removeIsolatedWalls) peel away the
 * now-isolated walls. One shot per pocket cascades into a full cleanup.
 * Impacts read as `own-wall` fires, NOT an attack on an enemy.
 */

import { cannonShotsRicochet } from "../game/index.ts";
import { getBattleInterior } from "../shared/core/board-occupancy.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  DIRS_8,
  inBounds,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import {
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
} from "./ai-strategy-battle.ts";

/** Minimum number of small pockets before pocket destruction triggers. */
const POCKET_COUNT_THRESHOLD = 5;
/** Maximum wall tiles targeted in a single pocket destruction chain. */
const MAX_POCKET_TARGETS = 5;

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
  // Ricochet adds 2 random bounces within Chebyshev radii [5, 3] after the
  // initial impact. Pocket targets sit inside the player's own territory by
  // definition, so the bounces frequently land on adjacent own walls and
  // break the very enclosures the player is trying to clean up. Forfeit
  // pocket destruction while ricochet is active — the cleanup is worth
  // less than the unintended self-demolition.
  if (cannonShotsRicochet(player)) return null;
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
  const pocketTiles = new Set<TileKey>();
  for (const pocket of pockets) {
    for (const k of pocket) pocketTiles.add(k);
  }

  const targets: TilePos[] = [];
  const picked = new Set<TileKey>();
  for (const pocket of pockets) {
    // Opening a pocket turns its tiles into outside, and the enclosure flood
    // (computeOutside) is 8-directional — a pocket tile touching a large
    // enclosure's interior even diagonally would de-enclose it. Skip such
    // pockets entirely.
    if (
      pocket.some((key) => {
        const { row, col } = unpackTile(key);
        return touchesLargeInterior(row, col, interior, pocketTiles);
      })
    ) {
      continue;
    }
    let found = false;
    for (const key of pocket) {
      if (found) break;
      const { row, col } = unpackTile(key);
      for (const [dr, dc] of DIRS_4) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        if (!player.walls.has(neighborKey) || picked.has(neighborKey)) continue;
        // The destroyed wall tile joins the outside flood too — reject walls
        // whose 8-dir neighborhood touches a large enclosure's interior.
        if (touchesLargeInterior(nr, nc, interior, pocketTiles)) continue;
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

/** True if any 8-dir neighbor of (row, col) is interior of a LARGE enclosure
 *  (interior tile not belonging to a small pocket). The enclosure flood
 *  (computeOutside) is 8-directional, so diagonal contact is enough for the
 *  outside to leak into the large enclosure once (row, col) opens. */
function touchesLargeInterior(
  row: number,
  col: number,
  interior: ReadonlySet<TileKey>,
  pocketTiles: ReadonlySet<TileKey>,
): boolean {
  for (const [dr, dc] of DIRS_8) {
    const ar = row + dr;
    const ac = col + dc;
    if (!inBounds(ar, ac)) continue;
    const adjacentKey = packTile(ar, ac);
    if (interior.has(adjacentKey) && !pocketTiles.has(adjacentKey)) return true;
  }
  return false;
}

/** Check if a 4-tile pocket forms a 2x2 square (can fit a cannon). */
function is2x2(keys: readonly TileKey[]): boolean {
  let minRow = Infinity;
  let minCol = Infinity;
  for (const key of keys) {
    const { row, col } = unpackTile(key);
    if (row < minRow) minRow = row;
    if (col < minCol) minCol = col;
  }
  const expected: Set<TileKey> = new Set([
    packTile(minRow, minCol),
    packTile(minRow, minCol + 1),
    packTile(minRow + 1, minCol),
    packTile(minRow + 1, minCol + 1),
  ]);
  return keys.length === 4 && keys.every((key) => expected.has(key));
}
