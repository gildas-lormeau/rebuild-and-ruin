/**
 * Phase-test fixture editor — CLI primitives.
 *
 * Usage:
 *   deno run -A scripts/fixture-cli.ts <command> [flags]
 *
 * Commands:
 *   create            Emits a minimal round-1 fixture skeleton (no checkpoint).
 *                     See `printUsage()` for required flags.
 *
 *   create-checkpoint Emits a round-≥2 fixture with a synthesized
 *                     `FullStateMessage` checkpoint: one hand-built castle per
 *                     zone (square ring of `--castle-size` outer tiles around
 *                     the picked home tower), empty cannons, lives=3.
 *                     Scans seeds when `--auto-seed` is set, otherwise uses
 *                     `--seed N` and fails if the ring doesn't fit.
 *
 *   show       --fixture <path> [--player RED|BLUE|GOLD]
 *       Boots the scenario, applies all overrides, renders ASCII to stdout.
 *       `--player` crops the board to that player's zone (absolute coord
 *       labels preserved), for compact single-zone debugging.
 *
 *   add-house  --fixture <path> --row N --col N
 *   add-bonus  --fixture <path> --row N --col N
 *   add-wall   --fixture <path> --row N --col N --owner N
 *   add-grunt  --fixture <path> --row N --col N
 *   add-cannon --fixture <path> --row N --col N --owner N
 *              [--cannon-mode M] [--hp N] [--facing rad]
 *   add-pit    --fixture <path> --row N --col N [--rounds-left N]
 *       Appends an override; validates by re-running the loader end-to-end;
 *       writes the fixture back on success (refuses on validation failure).
 *       `add-cannon`'s --row/--col give the top-left of the 2×2 footprint.
 *       `add-pit`'s --rounds-left defaults to BURNING_PIT_DURATION.
 *
 *   remove     --fixture <path> --row N --col N
 *       Removes any override (house / bonus / wall) at the given tile.
 *       Errors if nothing is at that tile.
 *
 *   validate   --fixture <path>
 *       Sanity-check the fixture (delegates to scripts/fixture-check.ts).
 *
 * Exits non-zero on any error. Designed so agents can compose calls without
 * needing interactive state.
 */

import {
  buildGrid,
  buildLegend,
  type Cell,
  CellKind,
  formatGrid,
  type Rect,
  zoneBounds,
} from "../dev/dev-console-grid.ts";
import { generateMap, topZonesBySize } from "../src/game/map-generation.ts";
import type { FullStateMessage } from "../src/protocol/protocol.ts";
import {
  CANNON_PLACE_TIMER,
  type ModifierId,
} from "../src/shared/core/game-constants.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { GameMap, Tower } from "../src/shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import { IMPLEMENTED_MODIFIERS } from "../src/shared/core/modifier-defs.ts";
import { isGrass } from "../src/shared/core/spatial.ts";
import type { GameState, TestHooks } from "../src/shared/core/types.ts";
import { Rng } from "../src/shared/platform/rng.ts";
import {
  createPhaseScenario,
  recomputeFixtureDerivedState,
} from "../test/phase-tests/loader.ts";
import type {
  BonusSquareOverride,
  BurningPitOverride,
  CannonOverride,
  FixtureFile,
  FixtureMode,
  GruntOverride,
  HouseOverride,
  WallOverride,
} from "../test/phase-tests/types.ts";

interface Flags {
  fixture?: string;
  row?: number;
  col?: number;
  owner?: number;
  /** `show` only: crop the rendered board to this player slot's zone. */
  player?: 0 | 1 | 2;
  color?: boolean;
  noColor?: boolean;
  out?: string;
  seed?: number;
  autoSeed?: boolean;
  mode?: FixtureMode;
  rounds?: number;
  round?: number;
  entryPhase?: Phase;
  castleSize?: number;
  players?: number;
  maxSeeds?: number;
  force?: boolean;
  notes?: string;
  cannonMode?: string;
  hp?: number;
  facing?: number;
  roundsLeft?: number;
  modifier?: string;
}

interface FixtureKeySets {
  fixtureHouses: ReadonlySet<number>;
  fixtureBonuses: ReadonlySet<number>;
  fixtureWalls: ReadonlySet<number>;
  fixtureGrunts: ReadonlySet<number>;
}

interface PickedSeed {
  seed: number;
  zones: number[];
  homeTowers: Tower[];
  /** Wall tile coords per active player, parallel to `homeTowers`. Either
   *  an N×N ring (castleSize ≥ 4) or the zone boundary (castleSize = -1).
   *  Precomputed in `trySeed` so `buildCheckpoint` doesn't need the map. */
  playerWalls: { row: number; col: number }[][];
  towerCount: number;
  castleSize: number;
}

const DEFAULT_CREATE_CHECKPOINT_ROUNDS = 5;
const DEFAULT_CREATE_CHECKPOINT_ROUND = 2;
const DEFAULT_CREATE_CHECKPOINT_CASTLE_SIZE = 10;
const DEFAULT_CREATE_CHECKPOINT_MAX_SEEDS = 500;
const DEFAULT_CREATE_CHECKPOINT_LIVES = 3;
const DEFAULT_CREATE_CHECKPOINT_CANNONS_PER_PLAYER = 2;
/** Bootstrap always creates one player per top-3 zone — see
 *  `createGameFromSeed(seed, maxPlayers)` and `topZonesBySize(map, 3)`. The
 *  checkpoint must match this slot count or `validateFullState` rejects it.
 *  `--players N` (N < 3) is honoured by padding the unused slots as
 *  `eliminated: true` stubs with no castle, walls, or cannons. */
const FIXED_PLAYER_COUNT = 3;
const DEFAULT_CREATE_CHECKPOINT_PLAYERS = 3;
/** Sentinel for `--castle-size -1`: build a wall ring along the entire
 *  zone boundary (every grass tile with any 8-dir neighbor outside the
 *  zone), making the player's territory the whole zone and enclosing
 *  every in-zone tower. */
const CASTLE_SIZE_WHOLE_ZONE = -1;
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG_RED = "\x1b[31m";
const FG_BLUE = "\x1b[34m";
const FG_YELLOW = "\x1b[33m";
const FG_MAGENTA = "\x1b[35m";
const FG_CYAN = "\x1b[36m";
const OWNER_COLORS = [FG_RED, FG_BLUE, FG_YELLOW];

await main();

async function main(): Promise<void> {
  const [command, ...rest] = Deno.args;
  if (!command) {
    printUsage();
    Deno.exit(2);
  }
  const flags = parseFlags(rest);
  try {
    switch (command) {
      case "create":
        await runCreate(flags);
        break;
      case "create-checkpoint":
        await runCreateCheckpoint(flags);
        break;
      case "show":
        await runShow(flags);
        break;
      case "add-house":
        await runAddHouse(flags);
        break;
      case "add-bonus":
        await runAddBonus(flags);
        break;
      case "add-wall":
        await runAddWall(flags);
        break;
      case "add-grunt":
        await runAddGrunt(flags);
        break;
      case "add-cannon":
        await runAddCannon(flags);
        break;
      case "add-pit":
        await runAddPit(flags);
        break;
      case "remove":
        await runRemove(flags);
        break;
      case "validate":
        await runValidate(flags);
        break;
      case "help":
      case "--help":
      case "-h":
        printUsage();
        break;
      default:
        console.error(`unknown command: ${command}`);
        printUsage();
        Deno.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}

async function runCreate(flags: Flags): Promise<void> {
  const out = requireOut(flags);
  const seed = requireInt(flags, "seed");
  const mode = flags.mode ?? "classic";
  const rounds = flags.rounds ?? 3;
  const round = flags.round ?? 1;
  const entryPhase = flags.entryPhase ?? Phase.CANNON_PLACE;
  if (round !== 1) {
    throw new Error(
      `create only emits round-1 fixtures (got --round ${round}); ` +
        `use create-checkpoint for round-≥2 scenarios`,
    );
  }
  await refuseExistingUnlessForce(out, flags);
  const fixture: FixtureFile = {
    version: 1,
    seed,
    mode,
    rounds,
    entryPhase,
    round,
    ...(flags.notes ? { notes: flags.notes } : {}),
  };
  await writeAndValidate(out, fixture);
  console.log(
    `created ${out} (seed=${seed} mode=${mode} round=${round} entry=${entryPhase})`,
  );
}

async function runCreateCheckpoint(flags: Flags): Promise<void> {
  const out = requireOut(flags);
  const testHooks = resolveModifierTestHooks(flags);
  // --modifier implies modern mode (only modern has modifier rolls) and a
  // round ≥ MODIFIER_FIRST_ROUND (=3) so the next BATTLE actually rolls.
  const modifierForced = testHooks?.forceModifier;
  const mode =
    flags.mode ?? (modifierForced !== undefined ? "modern" : "classic");
  const rounds = flags.rounds ?? DEFAULT_CREATE_CHECKPOINT_ROUNDS;
  const round =
    flags.round ??
    (modifierForced !== undefined ? 3 : DEFAULT_CREATE_CHECKPOINT_ROUND);
  const entryPhase = flags.entryPhase ?? Phase.CANNON_PLACE;
  const castleSize = flags.castleSize ?? DEFAULT_CREATE_CHECKPOINT_CASTLE_SIZE;
  const players = flags.players ?? DEFAULT_CREATE_CHECKPOINT_PLAYERS;
  const maxSeeds = flags.maxSeeds ?? DEFAULT_CREATE_CHECKPOINT_MAX_SEEDS;

  if (round < 2) {
    throw new Error(
      `create-checkpoint requires --round ≥ 2 (got ${round}); ` +
        `use create for round-1 fixtures`,
    );
  }
  if (entryPhase !== Phase.CANNON_PLACE && entryPhase !== Phase.WALL_BUILD) {
    throw new Error(
      `create-checkpoint only supports --entry-phase CANNON_PLACE or WALL_BUILD ` +
        `(got ${entryPhase})`,
    );
  }
  if (
    castleSize !== CASTLE_SIZE_WHOLE_ZONE &&
    (castleSize < 4 || castleSize % 2 !== 0)
  ) {
    throw new Error(
      `--castle-size must be an even integer ≥ 4 or -1 (got ${castleSize}); ` +
        `4 = 2×2 tower + 1-tile ring with no gap, 10 = 8×8 interior + ring, ` +
        `-1 = wall along the whole zone boundary (covers every in-zone tower)`,
    );
  }
  if (players < 1 || players > FIXED_PLAYER_COUNT) {
    throw new Error(
      `--players must be 1, 2, or 3 (got ${players}); ` +
        `inactive slots are padded as eliminated stubs`,
    );
  }
  if (modifierForced !== undefined) {
    if (mode !== "modern") {
      throw new Error(
        `--modifier <id> requires --mode modern (got "${mode}"); ` +
          `modifiers only roll in modern mode`,
      );
    }
    if (round < 3) {
      throw new Error(
        `--modifier <id> requires --round ≥ 3 (got ${round}); ` +
          `modifiers don't fire before MODIFIER_FIRST_ROUND`,
      );
    }
  }
  await refuseExistingUnlessForce(out, flags);

  const picked = flags.autoSeed
    ? scanSeeds(maxSeeds, castleSize, players)
    : pickSingleSeed(requireInt(flags, "seed"), castleSize, players);

  const checkpoint = buildCheckpoint(picked, {
    mode,
    rounds,
    round,
    entryPhase,
  });
  const fixture: FixtureFile = {
    version: 1,
    seed: picked.seed,
    mode,
    rounds,
    entryPhase,
    round,
    checkpoint,
    ...(testHooks ? { testHooks } : {}),
    notes:
      flags.notes ??
      `${players} hand-placed ${castleSize}×${castleSize} home castle(s) at seed ` +
        `${picked.seed} (${FIXED_PLAYER_COUNT - players} eliminated stub(s))` +
        (modifierForced !== undefined
          ? `, modifier "${modifierForced}" forced via testHooks.`
          : ".") +
        ` Generated by \`fixture create-checkpoint\`.`,
  };
  await writeAndValidate(out, fixture);
  const modifierNote =
    modifierForced !== undefined ? ` modifier=${modifierForced}` : "";
  console.log(
    `created ${out} (seed=${picked.seed} players=${players}/${FIXED_PLAYER_COUNT} size=${castleSize}${modifierNote})`,
  );
  for (let i = 0; i < picked.homeTowers.length; i++) {
    const tower = picked.homeTowers[i]!;
    console.log(
      `  P${i} zone=${tower.zone} towerIdx=${tower.index} at (${tower.row},${tower.col})`,
    );
  }
  for (let i = picked.homeTowers.length; i < FIXED_PLAYER_COUNT; i++) {
    console.log(`  P${i} zone=${picked.zones[i]} (eliminated stub)`);
  }
}

function scanSeeds(
  maxAttempts: number,
  castleSize: number,
  players: number,
): PickedSeed {
  for (let seed = 0; seed < maxAttempts; seed++) {
    const result = trySeed(seed, castleSize, players);
    if (result) return result;
  }
  throw new Error(
    `no viable seed found in 0..${maxAttempts} for castleSize=${castleSize} players=${players}`,
  );
}

function pickSingleSeed(
  seed: number,
  castleSize: number,
  players: number,
): PickedSeed {
  const result = trySeed(seed, castleSize, players);
  if (!result) {
    throw new Error(
      `seed ${seed} does not fit ${players}× ${castleSize}×${castleSize} castle(s) ` +
        `(use --auto-seed to scan)`,
    );
  }
  return result;
}

/** Look for a seed where the runtime's 3-zone bootstrap succeeds AND every
 *  active player's zone admits the chosen castle layout. Inactive slots
 *  (3 − `players`) need only a zone to exist; their entries are emitted
 *  as eliminated stubs. */
function trySeed(
  seed: number,
  castleSize: number,
  players: number,
): PickedSeed | null {
  const rng = new Rng(seed);
  const map = generateMap(rng);
  const top = topZonesBySize(map, FIXED_PLAYER_COUNT);
  if (top.length < FIXED_PLAYER_COUNT) return null;
  const zones = top.map((entry) => entry.zone);
  const homeTowers: Tower[] = [];
  const playerWalls: { row: number; col: number }[][] = [];
  for (let i = 0; i < players; i++) {
    const zone = zones[i]!;
    if (castleSize === CASTLE_SIZE_WHOLE_ZONE) {
      const inZoneTowers = map.towers.filter((tower) => tower.zone === zone);
      if (inZoneTowers.length === 0) return null;
      homeTowers.push(inZoneTowers[0]!);
      playerWalls.push(wholeZoneWallTiles(map, zone));
    } else {
      const fits = map.towers.filter(
        (tower) => tower.zone === zone && ringFits(map, tower, castleSize),
      );
      if (fits.length === 0) return null;
      const tower = fits[0]!;
      homeTowers.push(tower);
      playerWalls.push(ringTiles(tower, castleSize));
    }
  }
  return {
    seed,
    zones,
    homeTowers,
    playerWalls,
    towerCount: map.towers.length,
    castleSize,
  };
}

function ringFits(map: GameMap, tower: Tower, castleSize: number): boolean {
  for (const { row, col } of ringTiles(tower, castleSize)) {
    if (row < 0 || row >= GRID_ROWS) return false;
    if (col < 0 || col >= GRID_COLS) return false;
    if (!isGrass(map.tiles, row, col)) return false;
  }
  const gap = castleSize / 2 - 2;
  const top = tower.row - gap;
  const bottom = tower.row + 1 + gap;
  const left = tower.col - gap;
  const right = tower.col + 1 + gap;
  for (const other of map.towers) {
    if (other === tower) continue;
    const r0 = other.row;
    const r1 = other.row + 1;
    const c0 = other.col;
    const c1 = other.col + 1;
    if (
      r1 >= top - 1 &&
      r0 <= bottom + 1 &&
      c1 >= left - 1 &&
      c0 <= right + 1
    ) {
      return false;
    }
  }
  return true;
}

/** Every grass tile of `zone` with at least one 8-dir neighbor that is NOT
 *  zone-grass (water, off-map, or another zone). The set is 8-dir closed —
 *  `computeOutside` flood-fill from edges cannot reach the zone's interior
 *  through any diagonal. Tower tiles on the boundary are included as walls;
 *  the runtime accepts this and grunts/cannons read tower state separately. */
function wholeZoneWallTiles(
  map: GameMap,
  zone: number,
): { row: number; col: number }[] {
  const result: { row: number; col: number }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isGrass(map.tiles, r, c)) continue;
      if (map.zones[r]![c] !== zone) continue;
      if (isZoneBoundaryTile(map, r, c, zone)) {
        result.push({ row: r, col: c });
      }
    }
  }
  return result;
}

function isZoneBoundaryTile(
  map: GameMap,
  r: number,
  c: number,
  zone: number,
): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) return true;
      if (!isGrass(map.tiles, nr, nc)) return true;
      if (map.zones[nr]![nc] !== zone) return true;
    }
  }
  return false;
}

function buildCheckpoint(
  picked: PickedSeed,
  opts: {
    mode: FixtureMode;
    rounds: number;
    round: number;
    entryPhase: Phase;
  },
): FullStateMessage {
  const { zones, homeTowers, playerWalls, towerCount } = picked;
  const activeCount = homeTowers.length;
  const players = [];
  for (let idx = 0; idx < activeCount; idx++) {
    const tower = homeTowers[idx]!;
    const wallKeys = playerWalls[idx]!.map((t) => t.row * GRID_COLS + t.col);
    players.push({
      id: idx,
      walls: wallKeys,
      cannons: [],
      homeTowerIdx: tower.index,
      castleWallTiles: wallKeys,
      lives: DEFAULT_CREATE_CHECKPOINT_LIVES,
      eliminated: false,
      score: 0,
    });
  }
  for (let idx = activeCount; idx < FIXED_PLAYER_COUNT; idx++) {
    players.push({
      id: idx,
      walls: [],
      cannons: [],
      homeTowerIdx: null,
      castleWallTiles: [],
      lives: 0,
      eliminated: true,
      score: 0,
    });
  }
  const towerAlive = new Array(towerCount).fill(true);
  // CANNON_PLACE entry: only active slots are awaited; eliminated slots are
  // skipped by `allCannonPlaceDone` via `isPlayerEliminated`.
  // WALL_BUILD entry: active slots must already be "done"; eliminated slots
  // are again skipped.
  const cannonPlaceDone =
    opts.entryPhase === Phase.WALL_BUILD ? homeTowers.map((_, idx) => idx) : [];
  const cannonLimits: number[] = [];
  for (let idx = 0; idx < FIXED_PLAYER_COUNT; idx++) {
    cannonLimits.push(
      idx < activeCount ? DEFAULT_CREATE_CHECKPOINT_CANNONS_PER_PLAYER : 0,
    );
  }
  return {
    type: "fullState",
    migrationSeq: 0,
    phase: opts.entryPhase,
    round: opts.round,
    timer: CANNON_PLACE_TIMER,
    battleCountdown: 0,
    maxRounds: opts.rounds,
    shotsFired: 0,
    rngState: picked.seed,
    simTick: 0,
    players,
    grunts: [],
    gruntSpawnSeq: 0,
    houses: [],
    bonusSquares: [],
    towerAlive,
    burningPits: [],
    cannonLimits,
    cannonPlaceDone,
    playerZones: zones,
    gameMode: opts.mode,
    activeModifier: null,
    activeModifierChangedTiles: [],
    lastModifierId: null,
    frozenTiles: null,
    sinkholeTiles: null,
    exposedRiverbedTiles: null,
    towerPendingRevive: [],
    capturedCannons: [],
    cannonballs: [],
  };
}

/** All perimeter tiles of an N×N wall ring around a 2×2 tower, where N =
 *  `castleSize`. With N=10 the gap between tower edge and wall is 3 tiles. */
function ringTiles(
  tower: Tower,
  castleSize: number,
): { row: number; col: number }[] {
  const gap = castleSize / 2 - 2;
  const offset = gap + 1;
  const top = tower.row - offset;
  const bottom = tower.row + 1 + offset;
  const left = tower.col - offset;
  const right = tower.col + 1 + offset;
  const tiles: { row: number; col: number }[] = [];
  for (let c = left; c <= right; c++) {
    tiles.push({ row: top, col: c });
    tiles.push({ row: bottom, col: c });
  }
  for (let r = top + 1; r < bottom; r++) {
    tiles.push({ row: r, col: left });
    tiles.push({ row: r, col: right });
  }
  return tiles;
}

/** Translate `--modifier <id>` into a `TestHooks` payload — `forceModifier`
 *  pins the roll, and `disabledModifiers` lists every other implemented id
 *  as belt-and-suspenders so the natural pool would also converge on the
 *  same id if `testHooks` ever got stripped. Returns `undefined` when no
 *  `--modifier` flag was passed. */
function resolveModifierTestHooks(flags: Flags): TestHooks | undefined {
  if (!flags.modifier) return undefined;
  const implementedIds = IMPLEMENTED_MODIFIERS.map((def) => def.id);
  if (!implementedIds.includes(flags.modifier as ModifierId)) {
    throw new Error(
      `--modifier "${flags.modifier}" is not an implemented modifier id; ` +
        `expected one of: ${implementedIds.join(", ")}`,
    );
  }
  const target = flags.modifier as ModifierId;
  return {
    forceModifier: target,
    disabledModifiers: implementedIds.filter((id) => id !== target),
  };
}

async function refuseExistingUnlessForce(
  path: string,
  flags: Flags,
): Promise<void> {
  try {
    await Deno.stat(path);
  } catch {
    return;
  }
  if (!flags.force) {
    throw new Error(`refusing to overwrite ${path} (pass --force to replace)`);
  }
}

function requireOut(flags: Flags): string {
  if (!flags.out) throw new Error("missing --out <path>");
  return flags.out;
}

async function runShow(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const fixture = await readFixture(path);
  const sc = await createPhaseScenario(fixture);
  if (fixture.walls && fixture.walls.length > 0) {
    recomputeFixtureDerivedState(sc.state);
  }
  const cells = buildGrid(sc.state, "all", undefined);
  const legend = buildLegend(sc.state);
  let crop: Rect | undefined;
  if (flags.player !== undefined) {
    crop = cropRectForPlayer(sc.state, flags.player);
    if (crop === undefined) {
      throw new Error(
        `--player ${flags.player} has no zone in this fixture ` +
          `(eliminated or unseated)`,
      );
    }
  }
  const useColor = shouldUseColor(flags);
  if (useColor) {
    console.log(legend);
    console.log(colorizeGrid(cells, fixture, crop));
  } else {
    console.log(formatGrid(cells, legend, { coords: true, crop }));
  }
  console.log(summarizeOverrides(fixture));
}

function shouldUseColor(flags: Flags): boolean {
  if (flags.noColor) return false;
  if (flags.color) return true;
  // Honour NO_COLOR (https://no-color.org) and FORCE_COLOR.
  if (Deno.env.get("NO_COLOR")) return false;
  if (Deno.env.get("FORCE_COLOR")) return true;
  return Deno.stdout.isTerminal();
}

/** Render the cell grid with ANSI colors, framed with row/col coord margins
 *  to match `formatGrid({ coords: true })`. Coloring rules:
 *
 *    - Walls colored by owner (red / blue / yellow for slot 0 / 1 / 2).
 *    - Fixture-authored entities (matched by tile coords against the fixture
 *      JSON) render bold; fixture houses/bonuses get magenta, fixture walls
 *      stack bold on top of the owner color.
 *    - Interior / dirt cells dimmed so wall + entity layers pop.
 *    - Water/grass keep the default terminal style. */
function colorizeGrid(
  cells: readonly (readonly Cell[])[],
  fixture: FixtureFile,
  crop?: Rect,
): string {
  const fixtureHouses = new Set<number>();
  for (const house of fixture.houses ?? []) {
    fixtureHouses.add(house.row * GRID_COLS + house.col);
  }
  const fixtureBonuses = new Set<number>();
  for (const bonus of fixture.bonusSquares ?? []) {
    fixtureBonuses.add(bonus.row * GRID_COLS + bonus.col);
  }
  const fixtureWalls = new Set<number>();
  for (const wall of fixture.walls ?? []) {
    fixtureWalls.add(wall.row * GRID_COLS + wall.col);
  }
  const fixtureGrunts = new Set<number>();
  for (const grunt of fixture.grunts ?? []) {
    fixtureGrunts.add(grunt.row * GRID_COLS + grunt.col);
  }

  const rect: Rect = crop ?? {
    minRow: 0,
    maxRow: cells.length - 1,
    minCol: 0,
    maxCol: (cells[0]?.length ?? 1) - 1,
  };
  const rowLabelW = String(GRID_ROWS - 1).length;
  const pad = " ".repeat(rowLabelW);
  const colCount = rect.maxCol - rect.minCol + 1;
  // Absolute col labels (offset by rect.minCol) so a cropped view's headers
  // still cite real tile coordinates, matching formatGrid's cropped output.
  const tensHeader = `${pad}  ${buildTensHeader(colCount, rect.minCol)}`;
  const onesHeader = `${pad}  ${buildOnesHeader(colCount, rect.minCol)}`;
  const border = `${pad} +${"-".repeat(colCount)}+`;

  const lines = [tensHeader, onesHeader, border];
  for (let row = rect.minRow; row <= rect.maxRow; row++) {
    const cellRow = cells[row];
    if (!cellRow) continue;
    let painted = "";
    for (let col = rect.minCol; col <= rect.maxCol; col++) {
      painted += paintCell(cellRow[col]!, row, col, {
        fixtureHouses,
        fixtureBonuses,
        fixtureWalls,
        fixtureGrunts,
      });
    }
    lines.push(`${String(row).padStart(rowLabelW, " ")} |${painted}|`);
  }
  lines.push(border);
  return lines.join("\n");
}

function paintCell(
  cell: Cell,
  row: number,
  col: number,
  keys: FixtureKeySets,
): string {
  const key = row * GRID_COLS + col;
  const isFixtureWall = keys.fixtureWalls.has(key);
  const isFixtureHouse = keys.fixtureHouses.has(key);
  const isFixtureBonus = keys.fixtureBonuses.has(key);

  switch (cell.kind) {
    case CellKind.Wall: {
      const ownerColor = OWNER_COLORS[cell.playerId] ?? "";
      return isFixtureWall
        ? `${BOLD}${ownerColor}${cell.char}${RESET}`
        : `${ownerColor}${cell.char}${RESET}`;
    }
    case CellKind.Interior: {
      const ownerColor = OWNER_COLORS[cell.playerId] ?? "";
      return `${DIM}${ownerColor}${cell.char}${RESET}`;
    }
    case CellKind.House:
      return isFixtureHouse
        ? `${BOLD}${FG_MAGENTA}${cell.char}${RESET}`
        : `${FG_YELLOW}${cell.char}${RESET}`;
    case CellKind.BonusSquare:
      return isFixtureBonus
        ? `${BOLD}${FG_MAGENTA}${cell.char}${RESET}`
        : `${FG_CYAN}${cell.char}${RESET}`;
    case CellKind.TowerAlive:
      return `${FG_CYAN}${cell.char}${RESET}`;
    case CellKind.TowerDead:
      return `${DIM}${cell.char}${RESET}`;
    case CellKind.Cannon:
      return `${OWNER_COLORS[cell.playerId] ?? ""}${cell.char}${RESET}`;
    case CellKind.Grunt:
      return keys.fixtureGrunts.has(key)
        ? `${BOLD}${FG_MAGENTA}${cell.char}${RESET}`
        : `${OWNER_COLORS[cell.playerId] ?? ""}${cell.char}${RESET}`;
    case CellKind.Water:
    case CellKind.FrozenWater:
      return `${FG_BLUE}${cell.char}${RESET}`;
    default:
      return cell.char;
  }
}

function buildTensHeader(cols: number, startCol = 0): string {
  let out = "";
  for (let i = 0; i < cols; i++) {
    const tens = Math.floor((startCol + i) / 10);
    out += tens === 0 ? " " : String(tens);
  }
  return out;
}

function buildOnesHeader(cols: number, startCol = 0): string {
  let out = "";
  for (let i = 0; i < cols; i++) out += String((startCol + i) % 10);
  return out;
}

/** Resolve a player slot to its zone's 1-tile-padded crop rect (the same
 *  bounds `asciiSnapshot`'s `cropTo: ValidPlayerId` uses). Returns undefined
 *  when the slot has no zone (eliminated/unseated) so the caller can error. */
function cropRectForPlayer(
  state: GameState,
  slot: 0 | 1 | 2,
): Rect | undefined {
  const zone = state.playerZones[slot];
  if (zone === undefined) return undefined;
  return zoneBounds(state, zone);
}

async function runAddHouse(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const fixture = await readFixture(path);
  const houses: HouseOverride[] = [...(fixture.houses ?? [])];
  houses.push({ row, col });
  await writeAndValidate(path, { ...fixture, houses });
  console.log(`added house at (${row},${col})`);
}

async function runAddBonus(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const fixture = await readFixture(path);
  const bonusSquares: BonusSquareOverride[] = [...(fixture.bonusSquares ?? [])];
  bonusSquares.push({ row, col });
  await writeAndValidate(path, { ...fixture, bonusSquares });
  console.log(`added bonus square at (${row},${col})`);
}

async function runAddWall(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const owner = requireInt(flags, "owner");
  const fixture = await readFixture(path);
  const walls: WallOverride[] = [...(fixture.walls ?? [])];
  walls.push({ row, col, ownerId: owner });
  await writeAndValidate(path, { ...fixture, walls });
  console.log(`added wall at (${row},${col}) owner=${owner}`);
}

async function runAddGrunt(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const fixture = await readFixture(path);
  const grunts: GruntOverride[] = [...(fixture.grunts ?? [])];
  grunts.push({ row, col });
  await writeAndValidate(path, { ...fixture, grunts });
  console.log(
    `added grunt at (${row},${col}) (victim derived from zone owner)`,
  );
}

async function runAddCannon(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const owner = requireInt(flags, "owner");
  const fixture = await readFixture(path);
  const cannons: CannonOverride[] = [...(fixture.cannons ?? [])];
  const entry: CannonOverride = { row, col, ownerId: owner };
  if (flags.cannonMode !== undefined) entry.mode = flags.cannonMode;
  if (flags.hp !== undefined) entry.hp = flags.hp;
  if (flags.facing !== undefined) entry.facing = flags.facing;
  cannons.push(entry);
  await writeAndValidate(path, { ...fixture, cannons });
  const details: string[] = [];
  if (entry.mode) details.push(`mode=${entry.mode}`);
  if (entry.hp !== undefined) details.push(`hp=${entry.hp}`);
  if (entry.facing !== undefined) details.push(`facing=${entry.facing}`);
  const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
  console.log(`added cannon at (${row},${col}) owner=${owner}${suffix}`);
}

async function runAddPit(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const fixture = await readFixture(path);
  const pits: BurningPitOverride[] = [...(fixture.pits ?? [])];
  const entry: BurningPitOverride = { row, col };
  if (flags.roundsLeft !== undefined) entry.roundsLeft = flags.roundsLeft;
  pits.push(entry);
  await writeAndValidate(path, { ...fixture, pits });
  const suffix =
    entry.roundsLeft !== undefined ? ` roundsLeft=${entry.roundsLeft}` : "";
  console.log(`added burning pit at (${row},${col})${suffix}`);
}

async function runRemove(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const row = requireInt(flags, "row");
  const col = requireInt(flags, "col");
  const fixture = await readFixture(path);
  const removed: string[] = [];
  const houses = (fixture.houses ?? []).filter((house) => {
    if (house.row === row && house.col === col) {
      removed.push("house");
      return false;
    }
    return true;
  });
  const bonusSquares = (fixture.bonusSquares ?? []).filter((bonus) => {
    if (bonus.row === row && bonus.col === col) {
      removed.push("bonus square");
      return false;
    }
    return true;
  });
  const walls = (fixture.walls ?? []).filter((wall) => {
    if (wall.row === row && wall.col === col) {
      removed.push(`wall (owner=${wall.ownerId})`);
      return false;
    }
    return true;
  });
  const grunts = (fixture.grunts ?? []).filter((grunt) => {
    if (grunt.row === row && grunt.col === col) {
      removed.push("grunt");
      return false;
    }
    return true;
  });
  // Cannons match if the tile is anywhere in the 2×2 footprint, since the
  // top-left coord may not be the natural click target.
  const cannons = (fixture.cannons ?? []).filter((cannon) => {
    const dr = row - cannon.row;
    const dc = col - cannon.col;
    if (dr >= 0 && dr <= 1 && dc >= 0 && dc <= 1) {
      removed.push(
        `cannon (owner=${cannon.ownerId}, top-left=${cannon.row},${cannon.col})`,
      );
      return false;
    }
    return true;
  });
  const pits = (fixture.pits ?? []).filter((pit) => {
    if (pit.row === row && pit.col === col) {
      removed.push("burning pit");
      return false;
    }
    return true;
  });
  if (removed.length === 0) {
    throw new Error(`no override at (${row},${col}) to remove`);
  }
  await writeAndValidate(path, {
    ...fixture,
    houses: houses.length > 0 ? houses : undefined,
    bonusSquares: bonusSquares.length > 0 ? bonusSquares : undefined,
    walls: walls.length > 0 ? walls : undefined,
    grunts: grunts.length > 0 ? grunts : undefined,
    cannons: cannons.length > 0 ? cannons : undefined,
    pits: pits.length > 0 ? pits : undefined,
  });
  console.log(`removed at (${row},${col}): ${removed.join(", ")}`);
}

async function runValidate(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const fixture = await readFixture(path);
  const sc = await createPhaseScenario(fixture);
  if (fixture.walls && fixture.walls.length > 0) {
    recomputeFixtureDerivedState(sc.state);
  }
  sc.tick(1);
  console.log(`OK ${path}`);
}

async function writeAndValidate(
  path: string,
  next: FixtureFile,
): Promise<void> {
  // Validate before persisting: boot the scenario with the candidate
  // fixture and tick one frame so the loader's apply-step plus
  // post-recompute invariants run. Any thrown error blocks the write.
  const sc = await createPhaseScenario(next);
  if (next.walls && next.walls.length > 0) {
    recomputeFixtureDerivedState(sc.state);
  }
  sc.tick(1);
  await Deno.writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

async function readFixture(path: string): Promise<FixtureFile> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as FixtureFile;
}

function summarizeOverrides(fixture: FixtureFile): string {
  const parts: string[] = [];
  if (fixture.houses?.length) parts.push(`${fixture.houses.length} house(s)`);
  if (fixture.bonusSquares?.length) {
    parts.push(`${fixture.bonusSquares.length} bonus(es)`);
  }
  if (fixture.walls?.length) parts.push(`${fixture.walls.length} wall(s)`);
  if (fixture.grunts?.length) parts.push(`${fixture.grunts.length} grunt(s)`);
  if (parts.length === 0) return "overrides: (none)";
  return `overrides: ${parts.join(", ")}`;
}

function requireFixturePath(flags: Flags): string {
  if (!flags.fixture) throw new Error("missing --fixture <path>");
  return flags.fixture;
}

function requireInt(flags: Flags, name: keyof Flags): number {
  const value = flags[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`missing or non-integer --${String(name)} N`);
  }
  return value;
}

function parseFlags(argv: readonly string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--fixture":
        out.fixture = argv[++i];
        break;
      case "--row":
        out.row = Number(argv[++i]);
        break;
      case "--col":
        out.col = Number(argv[++i]);
        break;
      case "--owner":
        out.owner = Number(argv[++i]);
        break;
      case "--player":
        out.player = parsePlayerSlot(argv[++i]);
        break;
      case "--color":
        out.color = true;
        break;
      case "--no-color":
        out.noColor = true;
        break;
      case "--out":
        out.out = argv[++i];
        break;
      case "--seed":
        out.seed = Number(argv[++i]);
        break;
      case "--auto-seed":
        out.autoSeed = true;
        break;
      case "--mode": {
        const value = argv[++i];
        if (value !== "classic" && value !== "modern") {
          throw new Error(`--mode must be classic|modern (got "${value}")`);
        }
        out.mode = value;
        break;
      }
      case "--rounds":
        out.rounds = Number(argv[++i]);
        break;
      case "--round":
        out.round = Number(argv[++i]);
        break;
      case "--entry-phase": {
        const value = argv[++i];
        const match = (Object.values(Phase) as Phase[]).find(
          (phase) => phase === value,
        );
        if (!match) {
          throw new Error(
            `--entry-phase must be one of ${Object.values(Phase).join("|")} ` +
              `(got "${value}")`,
          );
        }
        out.entryPhase = match;
        break;
      }
      case "--castle-size":
        out.castleSize = Number(argv[++i]);
        break;
      case "--players":
        out.players = Number(argv[++i]);
        break;
      case "--max-seeds":
        out.maxSeeds = Number(argv[++i]);
        break;
      case "--force":
        out.force = true;
        break;
      case "--notes":
        out.notes = argv[++i];
        break;
      case "--cannon-mode":
        out.cannonMode = argv[++i];
        break;
      case "--hp":
        out.hp = Number(argv[++i]);
        break;
      case "--facing":
        out.facing = Number(argv[++i]);
        break;
      case "--rounds-left":
        out.roundsLeft = Number(argv[++i]);
        break;
      case "--modifier":
        out.modifier = argv[++i];
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

/** Parse `--player RED|BLUE|GOLD` (or the raw slot 0|1|2) into a player slot.
 *  Slots follow the canonical Red=0 / Blue=1 / Gold=2 order. */
function parsePlayerSlot(value: string | undefined): 0 | 1 | 2 {
  if (value === undefined) {
    throw new Error("--player requires RED|BLUE|GOLD (or 0|1|2)");
  }
  const byName: Record<string, 0 | 1 | 2> = { RED: 0, BLUE: 1, GOLD: 2 };
  const named = byName[value.toUpperCase()];
  if (named !== undefined) return named;
  const slot = Number(value);
  if (slot === 0 || slot === 1 || slot === 2) return slot;
  throw new Error(`--player must be RED|BLUE|GOLD or 0|1|2 (got "${value}")`);
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/fixture-cli.ts <command> [flags]",
      "",
      "Commands:",
      "  create            --out <path> --seed N [--mode classic|modern]",
      '                    [--rounds R] [--entry-phase P] [--notes "..."] [--force]',
      "                      Emit a minimal round-1 fixture skeleton.",
      "",
      "  create-checkpoint --out <path> (--seed N | --auto-seed)",
      "                    [--mode classic|modern] [--rounds R] [--round R]",
      "                    [--entry-phase CANNON_PLACE|WALL_BUILD]",
      "                    [--castle-size N] [--players N] [--max-seeds N]",
      "                    [--modifier <id>]",
      '                    [--notes "..."] [--force]',
      "                      Synthesize a round-≥2 fixture with one hand-built",
      "                      castle per active player. --castle-size N (even,",
      "                      ≥4) → N×N square ring; --castle-size -1 → walls",
      "                      along the whole zone boundary, enclosing every",
      "                      in-zone tower. --players 1..3 builds N castles;",
      "                      remaining slots are emitted as eliminated stubs",
      "                      (lives=0, no walls/cannons, AI skipped).",
      "                      --modifier <id> pins the round's modifier via",
      "                      testHooks (forces id, disables others); implies",
      "                      --mode modern + --round 3 unless overridden.",
      "                      Defaults: round=2, players=3, castle-size=10,",
      "                      entry=CANNON_PLACE.",
      "",
      "  show       --fixture <path> [--player RED|BLUE|GOLD]",
      "  add-house  --fixture <path> --row N --col N",
      "  add-bonus  --fixture <path> --row N --col N",
      "  add-wall   --fixture <path> --row N --col N --owner N",
      "  add-grunt  --fixture <path> --row N --col N",
      "  add-cannon --fixture <path> --row N --col N --owner N",
      "             [--cannon-mode M] [--hp N] [--facing rad]",
      "  add-pit    --fixture <path> --row N --col N [--rounds-left N]",
      "  remove     --fixture <path> --row N --col N",
      "  validate   --fixture <path>",
    ].join("\n"),
  );
}
