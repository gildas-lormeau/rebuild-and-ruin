/**
 * Dev console — exposes `window.__dev` for interactive debugging in browser
 * dev tools. Guarded by IS_DEV at call site. Separate from the E2E bridge
 * (which is for Playwright automation).
 *
 * Usage (browser console):
 *   __dev.help()                              // show all commands
 *   __dev.map()                               // styled ASCII map (colored)
 *   __dev.map("walls")                        // terrain + walls only
 *   __dev.mapText()                           // plain text → clipboard
 *   __dev.mapText({ zone: 0, legend: false }) // cropped, no legend
 *   __dev.speed(3)                            // 3× speed
 *   __dev.pause()                             // toggle pause
 *   __dev.step()                              // advance one frame
 */

import { TOWER_SIZE } from "../shared/game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/grid.ts";
import { PLAYER_NAMES } from "../shared/player-config.ts";
import { isWater, unpackTile } from "../shared/spatial.ts";
import type { GameState } from "../shared/types.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";

type MapLayer = "all" | "terrain" | "walls";

interface MapTextOptions {
  layer?: MapLayer;
  zone?: number;
  player?: number;
  coords?: boolean;
  legend?: boolean;
}

interface DevConsole {
  help: () => void;
  map: (layer?: MapLayer) => void;
  mapText: (opts?: MapTextOptions) => string;
  speed: (multiplier?: number) => number;
  pause: () => void;
  step: () => void;
}

const enum CellKind {
  Grass,
  Water,
  Interior,
  BonusSquare,
  Wall,
  BurningPit,
  House,
  Cannon,
  Grunt,
  TowerDead,
  TowerAlive,
  Cannonball,
}

interface Cell {
  kind: CellKind;
  char: string;
  playerId: number;
}

interface Rect {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

const PLAYER_CSS = [
  "color:#e04040;font-weight:bold", // Red
  "color:#4060e0;font-weight:bold", // Blue
  "color:#c09020;font-weight:bold", // Gold
];
const RESET_CSS = "color:inherit;font-weight:normal";
const WATER_CSS = "color:#3080d0";
const DIM_CSS = "color:#666";
const ENTITY_CSS = "color:#e0e0e0;font-weight:bold";
const HEADING_CSS = "font-weight:bold;color:#8be9fd";
/** Player label chars for plain-text mode (R=Red, B=Blue, G=Gold). */
const PLAYER_LABEL: Record<number, string> = { 0: "R", 1: "B", 2: "G" };

/** Attach `window.__dev` once (dev-only, guarded by IS_DEV at call site).
 *  The console object closes over runtimeState but reads it on-demand —
 *  no stale snapshots are retained between invocations. */
export function exposeDevConsole(runtimeState: RuntimeState): void {
  if (typeof window === "undefined") return;

  const win = globalThis as unknown as Record<string, unknown>;
  if (win.__dev) return;

  function requireState(): GameState | undefined {
    if (!isStateReady(runtimeState)) {
      console.log("Game not started yet.");
      return undefined;
    }
    return runtimeState.state;
  }

  const dev: DevConsole = {
    help() {
      printHelp();
    },

    map(layer: MapLayer = "all") {
      const state = requireState();
      if (!state) return;
      const grid = buildGrid(state, layer, undefined);
      renderStyledGrid(
        grid,
        { minRow: 0, maxRow: GRID_ROWS - 1, minCol: 0, maxCol: GRID_COLS - 1 },
        state,
      );
    },

    mapText(opts: MapTextOptions = {}): string {
      const state = requireState();
      if (!state) return "";
      const {
        layer = "all",
        zone,
        player,
        coords = true,
        legend = true,
      } = opts;
      const grid = buildGrid(state, layer, player);
      const crop = zone !== undefined ? zoneBounds(state, zone) : undefined;
      if (zone !== undefined && !crop) return "";
      const text = renderPlainGrid(
        grid,
        crop,
        coords,
        legend ? state : undefined,
      );
      void navigator.clipboard.writeText(text).then(
        () => console.log("Copied to clipboard."),
        () => console.log("Clipboard write failed — text returned as string."),
      );
      return text;
    },

    speed(multiplier?: number): number {
      if (multiplier !== undefined) {
        if (multiplier <= 0) {
          console.log("Speed must be > 0. Use __dev.pause() to freeze.");
          return runtimeState.speedMultiplier;
        }
        runtimeState.speedMultiplier = multiplier;
        console.log(`Speed: ${multiplier}×`);
      } else {
        console.log(`Speed: ${runtimeState.speedMultiplier}×`);
      }
      return runtimeState.speedMultiplier;
    },

    pause() {
      runtimeState.paused = !runtimeState.paused;
      console.log(runtimeState.paused ? "Paused" : "Resumed");
    },

    step() {
      if (!runtimeState.paused) {
        console.log("Not paused — use __dev.pause() first.");
        return;
      }
      runtimeState.paused = false;
      requestAnimationFrame(() => {
        runtimeState.paused = true;
      });
    },
  };

  win.__dev = dev;
}

function printHelp(): void {
  console.log(
    `%c__dev — Dev Console%c

%cMap%c
  __dev.map()              Styled ASCII map (colored, all layers)
  __dev.map("terrain")     Terrain only (grass + water)
  __dev.map("walls")       Terrain + walls + territory

%cMap → Clipboard%c
  __dev.mapText()          Plain text map → clipboard
  __dev.mapText(opts)      Options:
    layer    "all" | "terrain" | "walls"    (default: "all")
    zone     0 | 1 | 2                     Crop to zone
    player   0 | 1 | 2                     Filter walls/cannons/territory to one player
                                           (towers, grunts, houses always shown)
    coords   boolean                       Row/col headers (default: true)
    legend   boolean                       Stats + symbol key (default: true)

  Examples:
    __dev.mapText({ zone: 0 })
    __dev.mapText({ player: 1, layer: "walls" })
    __dev.mapText({ coords: false, legend: false })

%cSpeed%c
  __dev.speed()            Show current multiplier
  __dev.speed(3)           3× speed
  __dev.speed(0.5)         Slow-mo (half speed)

%cPause%c
  __dev.pause()            Toggle pause
  __dev.step()             Advance one frame (while paused)

%cSymbols%c
  · grass  ~ water  ░ territory  # wall  T tower  t dead tower
  C cannon  x debris  ! grunt  * burning pit  + bonus  o cannonball
  mapText walls: r/b/g  cannons: R/B/G  territory: :`,
    "font-weight:bold;font-size:14px",
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
  );
}

function buildGrid(
  state: GameState,
  layer: MapLayer,
  playerFilter: number | undefined,
): Cell[][] {
  const grid: Cell[][] = [];

  for (let row = 0; row < GRID_ROWS; row++) {
    const rowCells: Cell[] = [];
    for (let col = 0; col < GRID_COLS; col++) {
      if (isWater(state.map.tiles, row, col)) {
        rowCells.push({ kind: CellKind.Water, char: "~", playerId: -1 });
      } else {
        rowCells.push({ kind: CellKind.Grass, char: ".", playerId: -1 });
      }
    }
    grid.push(rowCells);
  }

  if (layer === "terrain") return grid;

  // Territory + walls
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    for (const key of player.interior) {
      const { r, c } = unpackTile(key);
      setCell(grid, r, c, CellKind.Interior, "░", player.id);
    }
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      setCell(grid, r, c, CellKind.Wall, "#", player.id);
    }
  }

  if (layer === "walls") return grid;

  // Bonus squares
  for (const bonus of state.bonusSquares) {
    setCell(grid, bonus.row, bonus.col, CellKind.BonusSquare, "+", -1);
  }

  // Burning pits
  for (const pit of state.burningPits) {
    setCell(grid, pit.row, pit.col, CellKind.BurningPit, "*", -1);
  }

  // Houses
  for (const house of state.map.houses) {
    if (house.alive) {
      setCell(grid, house.row, house.col, CellKind.House, "H", -1);
    }
  }

  // Towers (2×2)
  for (let tIdx = 0; tIdx < state.map.towers.length; tIdx++) {
    const tower = state.map.towers[tIdx]!;
    const alive = state.towerAlive[tIdx]!;
    const kind = alive ? CellKind.TowerAlive : CellKind.TowerDead;
    const char = alive ? "T" : "t";
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        setCell(grid, tower.row + dr, tower.col + dc, kind, char, -1);
      }
    }
  }

  // Cannons
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    for (const cannon of player.cannons) {
      const char = cannon.hp <= 0 ? "x" : "C";
      setCell(grid, cannon.row, cannon.col, CellKind.Cannon, char, player.id);
    }
  }

  // Grunts
  for (const grunt of state.grunts) {
    setCell(grid, grunt.row, grunt.col, CellKind.Grunt, "!", -1);
  }

  // Cannonballs (snap to nearest tile)
  for (const ball of state.cannonballs) {
    const row = Math.round(ball.y / TILE_SIZE);
    const col = Math.round(ball.x / TILE_SIZE);
    if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
      setCell(grid, row, col, CellKind.Cannonball, "o", -1);
    }
  }

  return grid;
}

function setCell(
  grid: readonly Cell[][],
  row: number,
  col: number,
  kind: CellKind,
  char: string,
  playerId: number,
): void {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return;
  const existing = grid[row]![col]!;
  if (kind >= existing.kind) {
    grid[row]![col] = { kind, char, playerId };
  }
}

function zoneBounds(state: GameState, zone: number): Rect | undefined {
  let minRow = GRID_ROWS;
  let maxRow = 0;
  let minCol = GRID_COLS;
  let maxCol = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (state.map.zones[row]![col] === zone) {
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      }
    }
  }
  if (minRow > maxRow) {
    console.log(`Zone ${zone} not found on this map.`);
    return undefined;
  }
  // Pad by 1 tile for context, clamped to grid
  return {
    minRow: Math.max(0, minRow - 1),
    maxRow: Math.min(GRID_ROWS - 1, maxRow + 1),
    minCol: Math.max(0, minCol - 1),
    maxCol: Math.min(GRID_COLS - 1, maxCol + 1),
  };
}

function renderStyledGrid(
  grid: readonly Cell[][],
  crop: Rect,
  state: GameState,
): void {
  const { minRow, maxRow, minCol, maxCol } = crop;

  // Column headers
  const pad = "   ";
  let tens = pad;
  let units = pad;
  for (let col = minCol; col <= maxCol; col++) {
    tens += col >= 10 ? String(Math.floor(col / 10)) : " ";
    units += String(col % 10);
  }
  console.log(tens);
  console.log(units);

  // Grid rows with %c styling
  for (let row = minRow; row <= maxRow; row++) {
    let line = String(row).padStart(2, " ") + " ";
    const lineStyles: string[] = [];
    for (let col = minCol; col <= maxCol; col++) {
      const cell = grid[row]![col]!;
      line += `%c${cell.char}`;
      lineStyles.push(cellCss(cell));
    }
    console.log(line, ...lineStyles);
  }

  console.log(buildLegend(state));
}

function cellCss(cell: Cell): string {
  if (cell.playerId >= 0 && cell.playerId < PLAYER_CSS.length) {
    return PLAYER_CSS[cell.playerId]!;
  }
  switch (cell.kind) {
    case CellKind.Water:
      return WATER_CSS;
    case CellKind.Grass:
      return DIM_CSS;
    case CellKind.Grunt:
    case CellKind.Cannonball:
    case CellKind.TowerAlive:
    case CellKind.TowerDead:
    case CellKind.BurningPit:
    case CellKind.House:
    case CellKind.BonusSquare:
      return ENTITY_CSS;
    default:
      return RESET_CSS;
  }
}

function renderPlainGrid(
  grid: readonly Cell[][],
  crop: Rect | undefined,
  coords: boolean,
  legendState: GameState | undefined,
): string {
  const minRow = crop?.minRow ?? 0;
  const maxRow = crop?.maxRow ?? GRID_ROWS - 1;
  const minCol = crop?.minCol ?? 0;
  const maxCol = crop?.maxCol ?? GRID_COLS - 1;

  const lines: string[] = [];

  if (coords) {
    const pad = "   ";
    let tens = pad;
    let units = pad;
    for (let col = minCol; col <= maxCol; col++) {
      tens += col >= 10 ? String(Math.floor(col / 10)) : " ";
      units += String(col % 10);
    }
    lines.push(tens, units);
  }

  for (let row = minRow; row <= maxRow; row++) {
    let line = coords ? String(row).padStart(2, " ") + " " : "";
    for (let col = minCol; col <= maxCol; col++) {
      const cell = grid[row]![col]!;
      line += plainChar(cell);
    }
    lines.push(line);
  }

  if (legendState) {
    lines.push("", buildLegend(legendState));
  }

  return lines.join("\n");
}

/** In plain text, use player initial for owned entities to distinguish colors. */
function plainChar(cell: Cell): string {
  if (cell.playerId >= 0) {
    const label = PLAYER_LABEL[cell.playerId];
    if (label) {
      if (cell.kind === CellKind.Wall) return label.toLowerCase();
      // Live cannon → uppercase initial; dead debris keeps "x"
      if (cell.kind === CellKind.Cannon && cell.char !== "x") return label;
    }
  }
  // Interior uses : to distinguish from walls (which use player initial)
  if (cell.kind === CellKind.Interior) {
    return ":";
  }
  return cell.char;
}

function buildLegend(state: GameState): string {
  const playerInfo = state.players
    .map(
      (player) =>
        `${PLAYER_NAMES[player.id] ?? `P${player.id}`}: ${player.eliminated ? "ELIMINATED" : `${player.lives}♥ ${player.score}pts ${player.walls.size}w ${player.cannons.length}c`}`,
    )
    .join("  |  ");

  return [
    `Round ${state.round}  |  ${playerInfo}`,
    ". grass  ~ water  : territory  # wall  T tower  t dead tower",
    "C cannon  x debris  ! grunt  * burning pit  + bonus  o cannonball",
    "Walls: r=Red  b=Blue  g=Gold  |  Cannons: R=Red  B=Blue  G=Gold",
  ].join("\n");
}
