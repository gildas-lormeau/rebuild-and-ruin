/**
 * Type home for the board-occupancy contracts.
 *
 * `OccupancyCache` lives here, not beside the query functions in
 * `occupancy-queries.ts`: four AI modules take it as a parameter type and
 * need none of those functions, so homing it in the implementation pinned
 * them to that module's import depth for a five-field struct of Sets.
 */

import type { TileKey } from "../core/grid.ts";

/** Pre-built tile-key Sets for fast O(1) occupancy checks.
 *  Build once via `buildOccupancyCache` (board-occupancy.ts), then pass to
 *  `canPlacePiece` to avoid per-tile linear scans over towers/cannons/grunts. */
export interface OccupancyCache {
  readonly towerKeys: ReadonlySet<TileKey>;
  readonly cannonKeys: ReadonlySet<TileKey>;
  readonly gruntKeys: ReadonlySet<TileKey>;
  /** Union of every player's walls. Use for any-wall presence checks
   *  (e.g. wall-overlap validation in `canPlacePiece`); for own-wall checks,
   *  test `player.walls.has(key)` directly. */
  readonly wallKeys: ReadonlySet<TileKey>;
  readonly pitKeys: ReadonlySet<TileKey>;
}
