# Spatial Algorithms & Occupancy Reference

Agent-facing reference for working with territory, walls, grunts, and tile
occupancy. Read this before implementing features that involve flood-fill,
wall gaps, grunt movement, or territory detection.

## Tile encoding

All `Set<number>` tile collections (walls, interior, frozenTiles, etc.) use
flat-index encoding:

```
key = row * GRID_COLS + col          // packTile(r, c)
{ r, c } = { row: ⌊key/GRID_COLS⌋,  // unpackTile(key)
             col: key % GRID_COLS }
```

Grid size: 28 rows x 44 cols. Always use `packTile`/`unpackTile` — never
encode manually.

## Flood-fill: computeOutside

`computeOutside(walls, extraBarriers?)` in `spatial.ts` performs BFS from
all map-edge tiles, expanding through tiles not blocked by `walls` or
`extraBarriers`. Returns the set of "outside" tiles (reachable from edges).
Interior = everything NOT in outside and NOT a wall.

**Critical: it uses 8-directional expansion (DIRS_8).** A single diagonal
gap in walls lets the flood through. This means:

- A 1-tile-wide gap in a wall line breaks enclosure for territory purposes.
- You cannot use `computeOutside` to detect "almost-enclosed" areas with
  small gaps — the flood leaks through any gap, cardinal or diagonal.

If you need to reason about chokepoints or narrow passages that block
cardinal-only movement (e.g. grunts), do NOT use `computeOutside`.
Instead, test wall/barrier adjacency directly on the tiles of interest.

## Direction sets: DIRS_4 vs DIRS_8

| Set    | Directions             | Used by                                |
|--------|------------------------|----------------------------------------|
| DIRS_4 | up, down, left, right  | Grunt movement, wall neighbor counting, `towerReachesOutsideCardinal` |
| DIRS_8 | DIRS_4 + diagonals     | `computeOutside` (territory flood-fill) |

Grunts move in 4 directions only. Territory uses 8 directions.
This mismatch matters: a wall configuration that leaks diagonally (no
territory) can still physically block all grunt movement (cardinal only).
When reasoning about what grunts can pass through, think in DIRS_4.

## Interior: computation, caching, staleness

Interior is the set of grass tiles enclosed by a player's walls (not
reachable by the 8-dir flood from edges, not walls themselves).

### Freshness epoch system

Two `WeakMap<Player, number>` track whether interior is up-to-date:
- `wallsEpoch` — incremented by `markWallsDirty(player)` after wall mutations
- `interiorEpoch` — set by `markInteriorFresh(player, fresh)` after recompute

`getInterior(player)` asserts freshness (throws if stale).
`getBattleInterior(player)` skips the assertion — battle-only.

### When interior is fresh vs stale

| Phase        | Interior state | Why                                           |
|--------------|---------------|-----------------------------------------------|
| BUILD        | Fresh         | `recheckTerritory()` runs after each piece |
| CANNON_PLACE | Fresh         | Carried from end-of-build finalization         |
| BATTLE       | Intentionally stale | Walls destroyed by cannonballs are NOT reflected until next build. `deletePlayerWallBattle()` skips `markWallsDirty()` by design. |

During battle, use `getBattleInterior()`. Everywhere else, use
`getInterior()`.

### recheckTerritory vs finalizeTerritoryWithScoring

- `recheckTerritory` — mid-build incremental: recomputes interior,
  updates owned towers, sweeps enclosed grunts/houses, captures bonuses.
  No scoring, no tower revival.
- `finalizeTerritoryWithScoring` — end-of-build: does everything above
  PLUS awards territory points, revives pending towers, clears stale
  pending revives. Called exactly once at build phase end.

## What blocks grunt movement

`isGruntPassableTile(state, row, col)` returns false if:
- Tile is out of bounds
- Tile is water (unless frozen)
- Tile has a cannon, alive house, tower, or burning pit
- Tile has a wall (any player's wall)

Additionally, `canGruntMoveToCandidate()` rejects:
- Tiles occupied by another grunt
- Interior tiles (enclosed territory)
- Living tower footprint tiles

Walls are per-tile physical barriers — they block regardless of whether
they form a complete enclosure. A long wall with no gaps blocks all
grunts even if it encloses nothing.

## Zones and rivers

The map is split into 3 zones by a Y-shaped river. Each zone gets
4 towers and one player.

- `GameMap.zones[row][col]` — zone ID for each tile (0 for water)
- `player.homeTower.zone` — which zone a player owns
- `state.playerZones[playerId]` — same, indexed by player ID

Zones are fully isolated: no cross-zone interaction for grunts, walls,
or piece placement. Only cannonballs cross zone boundaries. Exception:
the frozen river modifier temporarily makes water tiles walkable,
enabling cross-zone grunt movement.

## Common pitfalls

1. **Don't use `computeOutside` to find wall gaps.** It uses 8-dir;
   any gap breaks enclosure. For gap/chokepoint detection, scan wall
   perimeters directly and test cardinal barrier adjacency.

2. **Don't read interior during battle.** It's intentionally stale.
   Use `getBattleInterior()` if you must, but prefer deferring
   interior-dependent logic to the next build phase.

3. **Don't forget `markWallsDirty` after wall mutations.** Except
   during battle — `deletePlayerWallBattle()` intentionally skips it.

4. **Grunts are 4-dir, territory is 8-dir.** A diagonal-only wall gap
   breaks territory but doesn't let grunts through. Reason about each
   system with the correct direction set.

5. **Walls block tile-by-tile.** Even an incomplete wall (no enclosure)
   physically blocks grunt movement on every wall tile. Don't confuse
   "no territory" with "no obstacle."
