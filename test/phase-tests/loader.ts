/**
 * Phase-test fixture loader. Translates a `FixtureFile` into a real `Scenario`
 * by booting the runtime and advancing it (AI-driven) to the declared
 * `entryPhase`, then applying entity overrides on top of the settled state.
 *
 * V1 supports round-1 entry only. Overrides currently cover houses and
 * bonus squares — both grass-only, zone-derived, never repartition the map.
 * Future slices add walls (player-owned, triggers territory recompute).
 */

import { addPlayerWall } from "../../src/shared/core/board-occupancy.ts";
import { TOWER_SIZE } from "../../src/shared/core/game-constants.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "../../src/shared/core/grid.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import { packTile } from "../../src/shared/core/spatial.ts";
import type { GameState } from "../../src/shared/core/types.ts";
import type { ZoneId } from "../../src/shared/core/zone-id.ts";
import { recheckTerritory } from "../../src/game/build-system.ts";
import { createScenario, type Scenario, waitForPhase } from "../scenario.ts";
import type {
  BonusSquareOverride,
  FixtureFile,
  HouseOverride,
  WallOverride,
} from "./types.ts";

const SUPPORTED_VERSION = 1;

export async function createPhaseScenario(
  fixture: FixtureFile,
): Promise<Scenario> {
  validateFixture(fixture);
  const sc = await createScenario({
    seed: fixture.seed,
    mode: fixture.mode,
    rounds: fixture.rounds,
  });
  if (fixture.entryPhase !== Phase.CASTLE_SELECT) {
    waitForPhase(sc, fixture.entryPhase);
  }
  if (fixture.houses && fixture.houses.length > 0) {
    applyHouseOverrides(sc.state, fixture.houses);
  }
  if (fixture.bonusSquares && fixture.bonusSquares.length > 0) {
    applyBonusSquareOverrides(sc.state, fixture.bonusSquares);
  }
  if (fixture.walls && fixture.walls.length > 0) {
    applyWallOverrides(sc.state, fixture.walls);
  }
  return sc;
}

/** Append authored houses to `state.map.houses`. Validates per
 *  `validateGrassEntityPos`; alive defaults to true. Bumps `mapVersion`. */
export function applyHouseOverrides(
  state: GameState,
  overrides: readonly HouseOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const occupied = new Set<number>();
  for (const house of state.map.houses) {
    occupied.add(house.row * GRID_COLS + house.col);
  }
  for (const override of overrides) {
    const zone = validateGrassEntityPos(
      state,
      towerTiles,
      occupied,
      "house",
      override.row,
      override.col,
    );
    state.map.houses.push({
      row: override.row,
      col: override.col,
      zone,
      alive: true,
    });
    occupied.add(override.row * GRID_COLS + override.col);
  }
  state.map.mapVersion++;
}

/** Append authored bonus squares to `state.bonusSquares`. Validates per
 *  `validateGrassEntityPos`. Does not bump `mapVersion` — bonus squares
 *  render as overlay sprites, not via the terrain cache. */
export function applyBonusSquareOverrides(
  state: GameState,
  overrides: readonly BonusSquareOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const occupied = new Set<number>();
  for (const bonus of state.bonusSquares) {
    occupied.add(bonus.row * GRID_COLS + bonus.col);
  }
  for (const override of overrides) {
    const zone = validateGrassEntityPos(
      state,
      towerTiles,
      occupied,
      "bonus square",
      override.row,
      override.col,
    );
    state.bonusSquares.push({
      row: override.row,
      col: override.col,
      zone,
    });
    occupied.add(override.row * GRID_COLS + override.col);
  }
}

/** Append authored walls to the per-player `player.walls` sets. Each wall
 *  must sit on a grass tile, in bounds, off any tower's 2×2 footprint, and
 *  not collide with an existing wall (any owner — walls are exclusive on a
 *  tile). The `ownerId` must reference an existing player slot. Isolated
 *  walls are allowed (the game produces them often during normal play).
 *
 *  Does NOT recompute interior / ownedTowers / territory — that's the
 *  editor's responsibility. Call `recomputeFixtureDerivedState(state)`
 *  after this if the caller intends to advance the runtime. */
export function applyWallOverrides(
  state: GameState,
  overrides: readonly WallOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const occupied = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) occupied.add(key);
  }
  for (const override of overrides) {
    const { row, col, ownerId } = override;
    if (
      !Number.isInteger(ownerId) ||
      ownerId < 0 ||
      ownerId >= state.players.length
    ) {
      throw new Error(
        `wall override (${row},${col}) has invalid ownerId ${ownerId} (expected 0..${state.players.length - 1})`,
      );
    }
    validateGrassEntityPos(
      state,
      towerTiles,
      occupied,
      "wall",
      override.row,
      override.col,
    );
    const player = state.players[ownerId as ValidPlayerId]!;
    const key = packTile(row, col);
    addPlayerWall(player, key);
    occupied.add(key);
  }
}

/** Recompute every player's interior, owned-tower set, and territory-derived
 *  cleanup (enclosed grunts / houses / bonus squares). Wraps the game's
 *  `recheckTerritory` so callers don't have to import from `src/game/`.
 *
 *  Call this after `applyWallOverrides` (or any other wall mutation) before
 *  the runtime ticks forward — otherwise `assertInteriorFresh` will throw
 *  the next time any game code reads `player.interior`. */
export function recomputeFixtureDerivedState(state: GameState): void {
  recheckTerritory(state);
}

export function validateFixture(fixture: FixtureFile): void {
  if (fixture.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Fixture version ${fixture.version} not supported (expected ${SUPPORTED_VERSION})`,
    );
  }
  if (fixture.round !== 1) {
    throw new Error(
      `Fixture round ${fixture.round} not supported in v1 (only round 1)`,
    );
  }
  if (!Object.values(Phase).includes(fixture.entryPhase)) {
    throw new Error(
      `Fixture entryPhase "${fixture.entryPhase}" is not a valid Phase`,
    );
  }
  if (fixture.mode !== "classic" && fixture.mode !== "modern") {
    throw new Error(
      `Fixture mode "${fixture.mode}" must be "classic" or "modern"`,
    );
  }
  if (!Number.isInteger(fixture.seed)) {
    throw new Error(`Fixture seed must be an integer, got ${fixture.seed}`);
  }
  if (!Number.isInteger(fixture.rounds) || fixture.rounds < 1) {
    throw new Error(
      `Fixture rounds must be a positive integer, got ${fixture.rounds}`,
    );
  }
}

/** Shared validation for grass-only entity placements (houses, bonus squares).
 *  Returns the derived `ZoneId` on success; throws with a labelled message
 *  on any rule violation. `occupied` is the entity-class-specific dedupe set
 *  (existing houses for `applyHouseOverrides`, etc.) — the caller maintains
 *  it across overrides so a fixture can't put two of the same entity on the
 *  same tile. */
function validateGrassEntityPos(
  state: GameState,
  towerTiles: ReadonlySet<number>,
  occupied: ReadonlySet<number>,
  label: string,
  row: number,
  col: number,
): ZoneId {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
    throw new Error(
      `${label} override (${row},${col}) is out of bounds (${GRID_ROWS}×${GRID_COLS})`,
    );
  }
  if (state.map.tiles[row]![col] !== Tile.Grass) {
    throw new Error(
      `${label} override (${row},${col}) must sit on a grass tile`,
    );
  }
  const key = row * GRID_COLS + col;
  if (towerTiles.has(key)) {
    throw new Error(
      `${label} override (${row},${col}) overlaps a tower footprint`,
    );
  }
  if (occupied.has(key)) {
    throw new Error(
      `${label} override (${row},${col}) duplicates an existing ${label} position`,
    );
  }
  const zone = state.map.zones[row]![col];
  if (zone === 0) {
    throw new Error(
      `${label} override (${row},${col}) lands on a water cell (no zone)`,
    );
  }
  return zone as ZoneId;
}

function collectTowerTiles(state: GameState): Set<number> {
  const set = new Set<number>();
  for (const tower of state.map.towers) {
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        set.add((tower.row + dr) * GRID_COLS + (tower.col + dc));
      }
    }
  }
  return set;
}
