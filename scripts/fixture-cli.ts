/**
 * Phase-test fixture editor — CLI primitives.
 *
 * Usage:
 *   deno run -A scripts/fixture-cli.ts <command> [flags]
 *
 * Commands:
 *   show       --fixture <path>
 *       Boots the scenario, applies all overrides, renders ASCII to stdout.
 *
 *   add-house  --fixture <path> --row N --col N
 *   add-bonus  --fixture <path> --row N --col N
 *   add-wall   --fixture <path> --row N --col N --owner N
 *       Appends an override; validates by re-running the loader end-to-end;
 *       writes the fixture back on success (refuses on validation failure).
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
} from "../src/runtime/dev-console-grid.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import {
  createPhaseScenario,
  recomputeFixtureDerivedState,
} from "../test/phase-tests/loader.ts";
import type {
  BonusSquareOverride,
  FixtureFile,
  HouseOverride,
  WallOverride,
} from "../test/phase-tests/types.ts";

interface Flags {
  fixture?: string;
  row?: number;
  col?: number;
  owner?: number;
  color?: boolean;
  noColor?: boolean;
}

interface FixtureKeySets {
  fixtureHouses: ReadonlySet<number>;
  fixtureBonuses: ReadonlySet<number>;
  fixtureWalls: ReadonlySet<number>;
}

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

async function runShow(flags: Flags): Promise<void> {
  const path = requireFixturePath(flags);
  const fixture = await readFixture(path);
  const sc = await createPhaseScenario(fixture);
  if (fixture.walls && fixture.walls.length > 0) {
    recomputeFixtureDerivedState(sc.state);
  }
  const cells = buildGrid(sc.state, "all", undefined);
  const legend = buildLegend(sc.state);
  const useColor = shouldUseColor(flags);
  if (useColor) {
    console.log(legend);
    console.log(colorizeGrid(cells, fixture));
  } else {
    console.log(formatGrid(cells, legend, { coords: true }));
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

  const rowLabelW = String(GRID_ROWS - 1).length;
  const pad = " ".repeat(rowLabelW);
  const colCount = cells[0]?.length ?? 0;
  const tensHeader = `${pad}  ${buildTensHeader(colCount)}`;
  const onesHeader = `${pad}  ${buildOnesHeader(colCount)}`;
  const border = `${pad} +${"-".repeat(colCount)}+`;

  const lines = [tensHeader, onesHeader, border];
  for (let row = 0; row < cells.length; row++) {
    const cellRow = cells[row]!;
    let painted = "";
    for (let col = 0; col < cellRow.length; col++) {
      painted += paintCell(cellRow[col]!, row, col, {
        fixtureHouses,
        fixtureBonuses,
        fixtureWalls,
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
      return `${OWNER_COLORS[cell.playerId] ?? ""}${cell.char}${RESET}`;
    case CellKind.Water:
    case CellKind.FrozenWater:
      return `${FG_BLUE}${cell.char}${RESET}`;
    default:
      return cell.char;
  }
}

function buildTensHeader(cols: number): string {
  let out = "";
  for (let col = 0; col < cols; col++) {
    const tens = Math.floor(col / 10);
    out += tens === 0 ? " " : String(tens);
  }
  return out;
}

function buildOnesHeader(cols: number): string {
  let out = "";
  for (let col = 0; col < cols; col++) out += String(col % 10);
  return out;
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
  if (removed.length === 0) {
    throw new Error(`no override at (${row},${col}) to remove`);
  }
  await writeAndValidate(path, {
    ...fixture,
    houses: houses.length > 0 ? houses : undefined,
    bonusSquares: bonusSquares.length > 0 ? bonusSquares : undefined,
    walls: walls.length > 0 ? walls : undefined,
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
      case "--color":
        out.color = true;
        break;
      case "--no-color":
        out.noColor = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/fixture-cli.ts <command> [flags]",
      "",
      "Commands:",
      "  show       --fixture <path>",
      "  add-house  --fixture <path> --row N --col N",
      "  add-bonus  --fixture <path> --row N --col N",
      "  add-wall   --fixture <path> --row N --col N --owner N",
      "  remove     --fixture <path> --row N --col N",
      "  validate   --fixture <path>",
    ].join("\n"),
  );
}
