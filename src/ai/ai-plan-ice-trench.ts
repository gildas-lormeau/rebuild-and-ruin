/**
 * AI tactic — ice trench. Builds a U-shaped trench (base along the shore,
 * arms curving diagonally inward) to block enemy grunts crossing the
 * frozen river. Only fires when frozenTiles exists and bank grunts are
 * threatening to cross.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  inBounds,
  isGrass,
  manhattanDistance,
  orderByNearest,
  packTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type { Rng } from "../shared/platform/rng.ts";

/** Ice-trench anchor: pick uniformly from the N shoreline tiles closest to
 *  a bank grunt. Wider than the dispatcher's TOP_TARGET_PICK_COUNT because
 *  trench anchors don't compete with cannon-targeting accuracy — anchor
 *  variety matters. */
const ICE_TRENCH_ANCHOR_TOP = 5;
/** Tiles per side of the base (lateral from anchor). */
const ICE_TRENCH_BASE_HALF = 3;
/** Tiles per arm extending from each end of the base toward the enemy. */
const ICE_TRENCH_ARM_LENGTH = 1;

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
  if (player.enclosedTowers.length === 0) return null;
  const playerZone = state.playerZones[playerId];

  const bankGrunts = collectBankGrunts(state, frozenTiles, playerZone);
  if (bankGrunts.length === 0) return null;

  const shoreline = findIceShoreline(state, frozenTiles, playerZone);
  if (shoreline.length === 0) return null;

  const bestAnchorKey = pickAnchor(shoreline, bankGrunts, rng);
  const anchor = unpackTile(bestAnchorKey);

  const inward = inwardFromShore(state, anchor, playerZone);
  if (!inward) return null;

  const trenchKeys = buildUTrench(frozenTiles, anchor, bestAnchorKey, inward);

  const result: TilePos[] = [];
  for (const key of trenchKeys) {
    result.push(unpackTile(key));
  }
  return result.length > 0 ? orderByNearest(result) : null;
}

/** Precondition: collect grunts on the opposite bank (enemy zone, 4-dir
 *  adjacent to frozen water). Grunts are ownerless — partition by current
 *  zone, not by any stored "victim" field. */
function collectBankGrunts(
  state: BattleViewState,
  frozenTiles: ReadonlySet<TileKey>,
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
  frozenTiles: ReadonlySet<TileKey>,
  playerZone: ZoneId | undefined,
): TileKey[] {
  const out: TileKey[] = [];
  for (const key of frozenTiles) {
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
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
 *  pick randomly among the top `ICE_TRENCH_ANCHOR_TOP` for variety. */
function pickAnchor(
  shoreline: readonly TileKey[],
  bankGrunts: readonly TilePos[],
  rng: Rng,
): TileKey {
  const scored = shoreline.map((shoreKey) => {
    const { row, col } = unpackTile(shoreKey);
    let minDist = Infinity;
    for (const grunt of bankGrunts) {
      const dist = manhattanDistance(grunt.row, grunt.col, row, col);
      if (dist < minDist) minDist = dist;
    }
    return { key: shoreKey, dist: minDist };
  });
  scored.sort((a, b) => a.dist - b.dist);
  const topCount = Math.min(scored.length, ICE_TRENCH_ANCHOR_TOP);
  return scored[rng.int(0, topCount - 1)]!.key;
}

/** Direction from the anchor pointing across the river (opposite of the
 *  cardinal that lands on AI-zone grass). null if the anchor is unexpectedly
 *  not adjacent to AI-zone grass. */
function inwardFromShore(
  state: BattleViewState,
  anchor: TilePos,
  playerZone: ZoneId | undefined,
): readonly [number, number] | null {
  for (const [dr, dc] of DIRS_4) {
    const nr = anchor.row + dr;
    const nc = anchor.col + dc;
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
  frozenTiles: ReadonlySet<TileKey>,
  anchor: TilePos,
  anchorKey: TileKey,
  inward: readonly [number, number],
): Set<TileKey> {
  const lateral1: [number, number] = inward[0] === 0 ? [1, 0] : [0, 1];
  const lateral2: [number, number] = inward[0] === 0 ? [-1, 0] : [0, -1];

  const trenchKeys = new Set<TileKey>();
  trenchKeys.add(anchorKey);

  const armStarts: [number, number][] = [];
  for (const lateral of [lateral1, lateral2]) {
    const end = walkAlongIce(
      frozenTiles,
      trenchKeys,
      anchor.row,
      anchor.col,
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
  frozenTiles: ReadonlySet<TileKey>,
  trenchKeys: Set<TileKey>,
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
