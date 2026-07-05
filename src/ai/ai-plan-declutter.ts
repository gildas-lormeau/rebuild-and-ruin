/**
 * AI tactic — declutter. Fires the player's OWN battery at their OWN redundant
 * inner ("fat") walls when too many have accumulated: fat boxes in the piece
 * bag and leaves no ground for new cannons, and the build-phase wall sweep can
 * never remove it (it only peels isolated walls). A fat wall's every
 * 8-neighbour is the player's own wall or interior, so removing one can never
 * connect interior to outside — enclosure-safe by construction, no re-check.
 */

import {
  aimReachesTile,
  cannonShotsRicochet,
  findShieldingRampart,
  hasReinforcedWalls,
} from "../game/index.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import { computeLiveInterior, isFatWallTile } from "./ai-strategy-battle.ts";

/** Fat-wall count that triggers a declutter chain. Measured accumulation in
 *  AI-only games (16 games × 10 rounds): p50 = 25 fat walls per battle, growing
 *  ~15/round once tetromino packing starts and never shed. 24 leaves the lean
 *  early rounds (0–20 fat) alone and engages once packing starts to bite. */
const DECLUTTER_FAT_THRESHOLD = 24;
/** Max walls cleared per chain — one contiguous pocket, not a full drain; the
 *  once-per-battle exclusion bounds the tempo spend to a single chain. */
const MAX_DECLUTTER_TARGETS = 8;

/** Plan a declutter chain: when the player's fat-wall count crosses the
 *  trigger threshold, carve ONE contiguous pocket out of the largest fat
 *  cluster (a 2x2+ opening fits a cannon or a reseal piece; scattered 1-tile
 *  holes fit nothing). Each cleared tile also becomes enclosed interior at the
 *  next territory pass — the cleanup is score-positive, not just room-making.
 *  Returns null while the castle is lean, when ricochet is active (the random
 *  bounces would hit load-bearing own walls), when Reinforced Walls is active
 *  (see below), or when no fat is shootable. */
export function planDeclutter(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  cursor: TilePos,
): TilePos[] | null {
  const player = state.players[playerId]!;
  // Ricochet adds 2 random bounces after the impact; targets sit deep inside
  // the player's own castle, so bounces frequently land on adjacent
  // LOAD-BEARING own walls and break the enclosures declutter must preserve.
  if (cannonShotsRicochet(player)) return null;
  // Reinforced Walls absorbs the shooter's own fire the same as an enemy's
  // (owner-based, not attacker-based), and the splash-cannon guard in
  // tickChainDwelling already bars super/mortar (the only fire that bypasses
  // it) from this chain. So every fresh fat-wall shot just gets absorbed
  // (marks damagedWalls, tile survives) and the chain advances past it
  // without ever landing the second hit — a whole chain burned for zero
  // walls cleared. Skip declutter entirely rather than plan a chain that
  // can't complete.
  if (hasReinforcedWalls(player)) return null;
  const cap = Math.min(usableCannonCount, MAX_DECLUTTER_TARGETS);
  if (cap < 1) return null;
  const interior = computeLiveInterior(player.walls);
  const fat = collectFatWalls(player.walls, interior);
  if (fat.size < DECLUTTER_FAT_THRESHOLD) return null;

  const shootable = new Set<TileKey>();
  for (const key of fat) {
    const { row, col } = unpackTile(key);
    // A tower-occluded tile can't be landed on (the aim seam would snap the
    // shot onto the tower — wasted); an own-rampart-shielded wall absorbs the
    // ball and survives (resolveWallShield is owner-based).
    if (!aimReachesTile(state, row, col)) continue;
    if (findShieldingRampart(player, row, col)) continue;
    shootable.add(key);
  }
  if (shootable.size === 0) return null;

  // Greedy nearest-neighbour walk seeded from the crosshair: same contiguous
  // cluster, but the chain enters at its cursor-nearest tile and never
  // ping-pongs between BFS frontier branches (measured: the #3 source of
  // >=15-tile intra-chain glides).
  const cluster = largestFatCluster(shootable).map((key) => unpackTile(key));
  return orderByNearest(cluster, cap, cursor);
}

/** The player's fat walls: own wall tiles whose every 8-neighbour is in bounds
 *  and the player's own wall or live interior (`isFatWallTile`) — exactly the
 *  set whose removal cannot leak outside into any interior. */
function collectFatWalls(
  walls: ReadonlySet<TileKey>,
  interior: ReadonlySet<TileKey>,
): Set<TileKey> {
  const fat = new Set<TileKey>();
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    if (isFatWallTile(walls, interior, row, col)) fat.add(key);
  }
  return fat;
}

/** BFS order of the largest 4-connected component of the shootable fat set —
 *  contiguous so successive shots grow one usable opening. Components are
 *  seeded in set-insertion order (derived from the synced wall set, identical
 *  on every peer), so the pick is deterministic without an rng draw. */
function largestFatCluster(fatSet: ReadonlySet<TileKey>): TileKey[] {
  const visited = new Set<TileKey>();
  let best: TileKey[] = [];
  for (const seed of fatSet) {
    if (visited.has(seed)) continue;
    const order: TileKey[] = [seed];
    visited.add(seed);
    for (let idx = 0; idx < order.length; idx++) {
      const { row, col } = unpackTile(order[idx]!);
      for (const [dr, dc] of DIRS_4) {
        const nkey = packTile(row + dr, col + dc);
        if (fatSet.has(nkey) && !visited.has(nkey)) {
          visited.add(nkey);
          order.push(nkey);
        }
      }
    }
    if (order.length > best.length) best = order;
  }
  return best;
}
