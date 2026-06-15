/**
 * AI tactic — pocket destruction. Clears the FIRING player's OWN small
 * enclosures (< 2x2 — too small to fit a cannon): fires ONE bordering own
 * wall per pocket to break the enclosure open, then lets the build-phase
 * wall sweep (sweepIsolatedWalls → removeIsolatedWalls) peel away the
 * now-isolated walls. One shot per pocket cascades into a full cleanup.
 * Impacts read as `own-wall` fires, NOT an attack on an enemy.
 */

import { cannonShotsRicochet, findShieldingRampart } from "../game/index.ts";
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
  computeLiveInterior,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
} from "./ai-strategy-battle.ts";

/** Pocket destruction triggers only with MORE than this many small pockets
 *  (`<=` comparison — 5 pockets is still below the trigger). */
const POCKET_COUNT_THRESHOLD = 5;
/** Maximum wall tiles targeted in a single pocket destruction chain. */
const MAX_POCKET_TARGETS = 5;

/** Plan pocket destruction: find small enclosures (< 2x2) and non-square 4-tile pockets, target one wall per pocket.
 *
 *  Pockets are recomputed from the LIVE wall set (`computeLiveInterior`), not
 *  the frozen battle interior — a pocket opened earlier this battle drops out
 *  on re-plans instead of being re-shot through a different surviving border
 *  wall (the plan has no rng gate or tactic exclusion, so `replanChain` could
 *  otherwise loop back into already-opened pockets all battle). Same live-view
 *  precedent as `pickEnclosureWallTarget`. */
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
  const interior = computeLiveInterior(player.walls);
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
        // A shot at a wall inside the player's OWN live rampart shield would be
        // absorbed (resolveWallShield is owner-based) — the wall survives, the
        // pocket stays closed, and the shot needlessly drains the shield. Skip
        // such borders; if every border of a pocket is shielded the pocket
        // yields no target and is left intact.
        if (findShieldingRampart(player, nr, nc)) continue;
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
