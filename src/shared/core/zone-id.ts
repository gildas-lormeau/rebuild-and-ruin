/** A flood-fill region identifier. Player zones are integers >= 1; `0` is
 *  the water sentinel from `floodFillZones`. Branded so a raw grid lookup
 *  (`state.map.zones[r][c]`, type `ZoneCell`) cannot silently flow into
 *  APIs expecting a validated player zone. Read via `zoneAt(map, r, c)`
 *  for `ZoneId | undefined`; `as ZoneId` is only OK at trust boundaries
 *  (wire deserialization, fresh flood-fill allocation, test fixtures). */

export type ZoneId = number & { readonly __zoneId: true };

/** A raw cell in `GameMap.zones`: either a `ZoneId` or the water sentinel `0`. */
export type ZoneCell = ZoneId | 0;
