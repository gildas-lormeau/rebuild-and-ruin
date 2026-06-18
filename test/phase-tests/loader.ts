/**
 * Phase-test fixture loader. Translates a `FixtureFile` into a real `Scenario`.
 *
 * Two entry paths:
 *   - No `checkpoint`: boot the runtime and AI-drive it to `entryPhase`.
 *   - With `checkpoint`: boot the runtime, then apply the captured
 *     `FullStateMessage` via `applyMidGameCheckpoint` so the runtime can
 *     resume ticking from that moment. The fixture's `round` / `entryPhase`
 *     must agree with the checkpoint's `round` / `phase`.
 *
 * After the entry point is reached, optional entity overrides (houses,
 * bonus squares, walls) are applied on top of the settled state.
 */

import { addPlayerWall } from "../../src/shared/sim/player-walls.ts";
import { CannonMode } from "../../src/shared/core/battle-types.ts";
import {
  CANNON_MODE_IDS,
  cannonModeDef,
} from "../../src/shared/core/cannon-mode-defs.ts";
import {
  BURNING_PIT_DURATION,
  CANNON_MAX_HP,
  TOWER_SIZE,
} from "../../src/shared/core/game-constants.ts";
import type { GameMap } from "../../src/shared/core/geometry-types.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "../../src/shared/core/grid.ts";
import { isPlayerSeated } from "../../src/shared/core/player-types.ts";
import { initPlayerBag } from "../../src/shared/sim/player-bag.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import { packTile } from "../../src/shared/core/spatial.ts";
import type { GameState } from "../../src/shared/core/types.ts";
import type { ZoneId } from "../../src/shared/core/zone-id.ts";
import { recheckTerritory } from "../../src/game/build-system.ts";
import { topZonesBySize } from "../../src/game/map-generation.ts";
import { useSmallPieces } from "../../src/game/upgrade-system.ts";
import { applyMidGameCheckpoint } from "../../src/online/online-rehydrate.ts";
import { type AsciiRenderer, createAsciiRenderer } from "../ascii-renderer.ts";
import {
  createHeadlessRuntime,
  reinstallAssistedControllers,
} from "../runtime-headless.ts";
import {
  buildHeadlessOptions,
  createScenario,
  type Scenario,
  waitForPhase,
  wrapHeadless,
} from "../scenario.ts";
import type { GameMessage } from "../../src/protocol/protocol.ts";
import type {
  BonusSquareOverride,
  BurningPitOverride,
  CannonOverride,
  FixtureFile,
  GruntOverride,
  HouseOverride,
  WallOverride,
} from "./types.ts";

const SUPPORTED_VERSION = 1;

export async function createPhaseScenario(
  fixture: FixtureFile,
  opts?: { renderer?: "ascii"; assistedSlots?: readonly ValidPlayerId[] },
): Promise<Scenario> {
  validateFixture(fixture);
  const sc = fixture.checkpoint
    ? await createCheckpointScenario(
      fixture,
      opts?.renderer,
      opts?.assistedSlots,
    )
    : await createFreshScenario(fixture, opts?.renderer, opts?.assistedSlots);
  if (fixture.testHooks) {
    // Apply before any subsequent tick so rollModifier / drawOffers see
    // the filter on the next phase transition. Fresh-scenario creation
    // already drove the runtime to entryPhase, but no modifier roll fires
    // before round 3 (MODIFIER_FIRST_ROUND) so round-1 fixtures stay
    // unaffected by the late assignment.
    sc.state.testHooks = fixture.testHooks;
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
  if (fixture.grunts && fixture.grunts.length > 0) {
    applyGruntOverrides(sc.state, fixture.grunts);
  }
  if (fixture.cannons && fixture.cannons.length > 0) {
    applyCannonOverrides(sc.state, fixture.cannons);
  }
  if (fixture.pits && fixture.pits.length > 0) {
    applyPitOverrides(sc.state, fixture.pits);
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
 *  Does NOT recompute interior / enclosedTowers / territory — that's the
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
        `wall override (${row},${col}) has invalid ownerId ${ownerId} (expected 0..${
          state.players.length - 1
        })`,
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

/** Append authored grunts to `state.grunts`. Each grunt must sit on a grass
 *  tile, in bounds, off any tower's 2×2 footprint, off any wall (any owner),
 *  and off any existing grunt position. `victimPlayerId` defaults to the
 *  zone owner at the grunt's tile — override only when authoring a
 *  cross-zone grunt. `targetTowerIdx` is intentionally NOT authored; the
 *  next `moveGrunts` pass (build phase only) locks it via `lockGruntTarget`,
 *  matching how production grunts behave after spawn. */
export function applyGruntOverrides(
  state: GameState,
  overrides: readonly GruntOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const wallTiles = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) wallTiles.add(key);
  }
  const gruntTiles = new Set<number>();
  for (const grunt of state.grunts) {
    gruntTiles.add(packTile(grunt.row, grunt.col));
  }
  for (const override of overrides) {
    const { row, col } = override;
    validateGruntPos(state, towerTiles, wallTiles, gruntTiles, row, col);
    state.grunts.push({
      row,
      col,
      blockedRounds: 0,
      ...(override.kind && { kind: override.kind }),
    });
    gruntTiles.add(packTile(row, col));
  }
}

/** Append authored cannons to the owners' `player.cannons` arrays. The 2×2
 *  footprint at (row..row+1, col..col+1) must be in-bounds, fully on grass,
 *  off any tower, off any wall (any owner), and off any existing cannon
 *  (any owner). `ownerId` must reference an existing player slot. `mode`
 *  defaults to "normal", `hp` to `CANNON_MAX_HP`.
 *
 *  Does NOT enforce interior membership — the runtime's checkpoint path
 *  also doesn't validate this, and tests may want to author cannons in
 *  unusual locations. */
export function applyCannonOverrides(
  state: GameState,
  overrides: readonly CannonOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const occupied = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) occupied.add(key);
    for (const cannon of player.cannons) {
      const cannonSize = cannonModeDef(cannon.mode).size;
      for (
        const key of cannonFootprintKeys(
          cannon.row,
          cannon.col,
          cannonSize,
        )
      ) {
        occupied.add(key);
      }
    }
  }
  for (const override of overrides) {
    const { row, col, ownerId } = override;
    if (
      !Number.isInteger(ownerId) ||
      ownerId < 0 ||
      ownerId >= state.players.length
    ) {
      throw new Error(
        `cannon override (${row},${col}) has invalid ownerId ${ownerId} ` +
          `(expected 0..${state.players.length - 1})`,
      );
    }
    const mode = override.mode ?? CannonMode.NORMAL;
    if (!CANNON_MODE_IDS.has(mode as CannonMode)) {
      throw new Error(
        `cannon override (${row},${col}) has invalid mode "${mode}" ` +
          `(expected one of ${[...CANNON_MODE_IDS].join("|")})`,
      );
    }
    const hp = override.hp ?? CANNON_MAX_HP;
    if (!Number.isInteger(hp) || hp < 0) {
      throw new Error(
        `cannon override (${row},${col}) has invalid hp ${hp} (expected ≥ 0)`,
      );
    }
    const size = cannonModeDef(mode as CannonMode).size;
    for (let dr = 0; dr < size; dr++) {
      for (let dc = 0; dc < size; dc++) {
        const tileRow = row + dr;
        const tileCol = col + dc;
        if (tileRow < 0 || tileRow >= GRID_ROWS) {
          throw new Error(
            `cannon override (${row},${col}) ${size}x${size} footprint tile (${tileRow},${tileCol}) out of bounds`,
          );
        }
        if (tileCol < 0 || tileCol >= GRID_COLS) {
          throw new Error(
            `cannon override (${row},${col}) ${size}x${size} footprint tile (${tileRow},${tileCol}) out of bounds`,
          );
        }
        if (state.map.tiles[tileRow]![tileCol] !== Tile.Grass) {
          throw new Error(
            `cannon override (${row},${col}) ${size}x${size} footprint tile (${tileRow},${tileCol}) is not grass`,
          );
        }
        const key = packTile(tileRow, tileCol);
        if (towerTiles.has(key)) {
          throw new Error(
            `cannon override (${row},${col}) ${size}x${size} footprint tile (${tileRow},${tileCol}) overlaps a tower`,
          );
        }
        if (occupied.has(key)) {
          throw new Error(
            `cannon override (${row},${col}) ${size}x${size} footprint tile (${tileRow},${tileCol}) overlaps an existing wall or cannon`,
          );
        }
      }
    }
    const player = state.players[ownerId as ValidPlayerId]!;
    player.cannons.push({
      row,
      col,
      hp,
      mode: mode as CannonMode,
    });
    for (const key of cannonFootprintKeys(row, col, size)) occupied.add(key);
  }
}

/** Append authored burning pits to `state.burningPits`. Each pit must sit
 *  on a grass tile, in-bounds, off any tower / wall / cannon / existing
 *  pit. `roundsLeft` defaults to `BURNING_PIT_DURATION` and must be ≥ 1. */
export function applyPitOverrides(
  state: GameState,
  overrides: readonly BurningPitOverride[],
): void {
  const towerTiles = collectTowerTiles(state);
  const occupied = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) occupied.add(key);
    for (const cannon of player.cannons) {
      const cannonSize = cannonModeDef(cannon.mode).size;
      for (
        const key of cannonFootprintKeys(
          cannon.row,
          cannon.col,
          cannonSize,
        )
      ) {
        occupied.add(key);
      }
    }
  }
  const pitTiles = new Set<number>();
  for (const pit of state.burningPits) {
    pitTiles.add(packTile(pit.row, pit.col));
  }
  for (const override of overrides) {
    const { row, col } = override;
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
      throw new Error(`pit override (${row},${col}) out of bounds`);
    }
    if (state.map.tiles[row]![col] !== Tile.Grass) {
      throw new Error(`pit override (${row},${col}) is not grass`);
    }
    const key = packTile(row, col);
    if (towerTiles.has(key)) {
      throw new Error(`pit override (${row},${col}) overlaps a tower`);
    }
    if (occupied.has(key)) {
      throw new Error(`pit override (${row},${col}) overlaps a wall or cannon`);
    }
    if (pitTiles.has(key)) {
      throw new Error(`pit override (${row},${col}) already has a pit`);
    }
    const roundsLeft = override.roundsLeft ?? BURNING_PIT_DURATION;
    if (!Number.isInteger(roundsLeft) || roundsLeft < 1) {
      throw new Error(
        `pit override (${row},${col}) has invalid roundsLeft ${roundsLeft} (expected ≥ 1)`,
      );
    }
    state.burningPits.push({ row, col, roundsLeft });
    pitTiles.add(key);
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
  if (!Number.isInteger(fixture.round) || fixture.round < 1) {
    throw new Error(
      `Fixture round must be a positive integer, got ${fixture.round}`,
    );
  }
  if (fixture.round > 1 && !fixture.checkpoint) {
    throw new Error(
      `Fixture round ${fixture.round} > 1 requires a checkpoint ` +
        `(no AI-replay path past round 1 — it would be too slow to be useful)`,
    );
  }
  if (fixture.checkpoint) {
    if (fixture.checkpoint.round !== fixture.round) {
      throw new Error(
        `Fixture round ${fixture.round} disagrees with checkpoint round ${fixture.checkpoint.round}`,
      );
    }
    const checkpointPhase =
      Phase[fixture.checkpoint.phase as keyof typeof Phase];
    if (checkpointPhase !== fixture.entryPhase) {
      throw new Error(
        `Fixture entryPhase ${fixture.entryPhase} disagrees with checkpoint phase ${fixture.checkpoint.phase}`,
      );
    }
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

function cannonFootprintKeys(
  row: number,
  col: number,
  size: number,
): number[] {
  const keys: number[] = [];
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      keys.push(packTile(row + dr, col + dc));
    }
  }
  return keys;
}

/** Round-1 path: AI-drive from boot to `entryPhase`. */
async function createFreshScenario(
  fixture: FixtureFile,
  renderer?: "ascii",
  assistedSlots?: readonly ValidPlayerId[],
): Promise<Scenario> {
  const sc = await createScenario({
    seed: fixture.seed,
    mode: fixture.mode,
    rounds: fixture.rounds,
    renderer,
    assistedSlots,
  });
  // Before the AI drive: createScenario stops at the round-1 CASTLE_SELECT
  // entry with no game ticks run yet (no castle built, no home tower picked),
  // so swapping terrain here is clean — the drive then auto-builds on the
  // pinned map.
  if (fixture.map) installPinnedMap(sc.state, fixture.map);
  if (fixture.entryPhase !== Phase.CASTLE_SELECT) {
    waitForPhase(sc, fixture.entryPhase);
  }
  return sc;
}

/** Round ≥ 2 path: boot a fresh runtime, then apply the captured snapshot
 *  so it continues ticking from that moment. */
async function createCheckpointScenario(
  fixture: FixtureFile,
  renderer?: "ascii",
  assistedSlots?: readonly ValidPlayerId[],
): Promise<Scenario> {
  if (!fixture.checkpoint) throw new Error("checkpoint required");
  const sentMessages: GameMessage[] = [];
  // Mirror createScenario's ascii wiring: build the handle, feed it to the
  // headless options, then bind + attach it after the runtime exists.
  const ascii = renderer === "ascii" ? createAsciiRenderer() : undefined;
  const headless = await createHeadlessRuntime(
    buildHeadlessOptions(
      {
        seed: fixture.seed,
        mode: fixture.mode,
        rounds: fixture.rounds,
      },
      sentMessages,
      ascii,
    ),
  );
  // Pin terrain before the restore: the round-1 seed-generated map is about
  // to be superseded by the checkpoint's dynamic state, which indexes
  // `map.towers` (homeTower) and validates `towerAlive` length against it —
  // so the snapshot must land on the same map it was authored against.
  if (fixture.map) {
    installPinnedMap(headless.runtime.runtimeState.state, fixture.map);
  }
  const result = await applyMidGameCheckpoint(
    headless.runtime,
    fixture.checkpoint,
  );
  if (!result) {
    throw new Error(
      "applyMidGameCheckpoint rejected the fixture's checkpoint " +
        "(structural validation failed — see [checkpoint] error above)",
    );
  }
  if (assistedSlots && assistedSlots.length > 0) {
    await reinstallAssistedControllers(
      headless.runtime,
      assistedSlots,
      (msg) => sentMessages.push(msg),
    );
  }
  ensurePieceBagsForBuildPhase(headless.runtime.runtimeState.state);
  if (ascii) ascii.bind(() => headless.runtime.runtimeState.state);
  const sc = wrapHeadless(headless, sentMessages);
  if (ascii) (sc as { renderer: AsciiRenderer }).renderer = ascii;
  return sc;
}

/** Install a pinned `fixture.map` over the seed-generated terrain and
 *  re-derive zone assignments from it. Makes a fixture sampler-independent
 *  (see `FixtureFile.map`). `structuredClone` keeps the imported JSON object
 *  — shared across every `createPhaseScenario` call for that fixture — out of
 *  the live mutable state. On the checkpoint path the subsequent
 *  `applyMidGameCheckpoint` re-asserts `playerZones` from the snapshot (and
 *  validates `towerAlive` against this map's tower count); on the fresh path
 *  the recomputed zones drive the round-1 AI castle selection and override
 *  validation. */
function installPinnedMap(state: GameState, map: GameMap): void {
  state.map = structuredClone(map);
  state.playerZones = topZonesBySize(state.map, state.players.length).map(
    ({ zone }) => zone,
  );
}

/** Piece bags are *not* serialized in checkpoints — they're regenerated on
 *  each peer at build-phase entry via `prepareNextRound → initPlayerBag`,
 *  which only runs during the natural BATTLE → WALL_BUILD transition. A
 *  checkpoint that drops the runtime directly into WALL_BUILD skips that
 *  setup, leaving `player.currentPiece` undefined — and the AI's
 *  `tickBuild` early-returns on the missing piece, so the AI stands idle
 *  while everything else (grunts, timer) keeps ticking. Fill the gap here
 *  so the loader-restored state matches what a host would have at this
 *  point in the round. */
function ensurePieceBagsForBuildPhase(state: GameState): void {
  if (state.phase !== Phase.WALL_BUILD) return;
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    if (player.bag) continue;
    initPlayerBag(player, state.round, state.rng, useSmallPieces(player));
  }
}

/** Grunt-specific validation. Grunts share house/bonus-square's grass +
 *  tower-footprint checks but also reject wall and existing-grunt overlaps,
 *  because grunts walk the same tiles walls occupy and two grunts can't
 *  share a tile. Re-uses `validateGrassEntityPos` for the shared part. */
function validateGruntPos(
  state: GameState,
  towerTiles: ReadonlySet<number>,
  wallTiles: ReadonlySet<number>,
  gruntTiles: ReadonlySet<number>,
  row: number,
  col: number,
): void {
  validateGrassEntityPos(state, towerTiles, gruntTiles, "grunt", row, col);
  const key = packTile(row, col);
  if (wallTiles.has(key)) {
    throw new Error(
      `grunt override (${row},${col}) overlaps an existing wall (any owner)`,
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
