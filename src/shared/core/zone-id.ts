/** A flood-fill region identifier. Player zones are integers >= 1; the value
 *  0 is the water sentinel produced by `floodFillZones` (initial-fill cells
 *  that never received a region id). Branded so a raw grid lookup
 *  (`state.map.zones[r][c]`, type `ZoneCell`) cannot silently flow into
 *  APIs that expect a validated player zone.
 *
 *  Use `zoneAt(map, r, c)` to read a grid cell as `ZoneId | undefined`
 *  (the boundary that drops the water sentinel). `as ZoneId` casts are
 *  acceptable at trust boundaries:
 *  1. Wire deserialization: `msg.playerZones as ZoneId[]`
 *  2. Allocation in flood fill: a freshly-incremented `regionId as ZoneId`
 *  3. Test fixtures and constants */

export type ZoneId = number & { readonly __zoneId: true };

/** A raw cell in `GameMap.zones`: either a `ZoneId` or the water sentinel `0`. */
export type ZoneCell = ZoneId | 0;
