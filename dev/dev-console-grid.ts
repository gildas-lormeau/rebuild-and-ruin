/**
 * Debug / diagnostic utilities — game-domain interpretation for dev tools.
 *
 * Consumed only by dev-console.ts and e2e-bridge.ts. Lives in
 * runtime/ because it's dev tooling, not gameplay — moved out of game/
 * to keep the game public surface free of debug concerns.
 */

import type { CannonMode } from "../src/shared/core/battle-types.ts";
import { cannonModeDef } from "../src/shared/core/cannon-mode-defs.ts";
import { TOWER_SIZE } from "../src/shared/core/game-constants.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  type TileKey,
} from "../src/shared/core/grid.ts";
import type {
  PlayerId,
  ValidPlayerId,
} from "../src/shared/core/player-slot.ts";
import { isPlayerEliminated } from "../src/shared/core/player-types.ts";
import {
  hasPitAt,
  inBounds,
  isCannonTile,
  isTowerTile,
  isWater,
  packTile,
  unpackTile,
  zoneOwnerIdAt,
} from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { ZoneId } from "../src/shared/core/zone-id.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";

export type MapLayer = "all" | "terrain" | "walls";

export const enum CellKind {
  Grass,
  Water,
  FrozenWater,
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

export interface Cell {
  kind: CellKind;
  char: string;
  /** Owning player slot, or -1 for cells without an owner (terrain,
   *  bonus squares, burning pits, dead/alive houses, towers, grunts,
   *  cannonballs). Use `isActivePlayer()` before treating as an index. */
  playerId: PlayerId;
}

export interface Rect {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface TileInspection {
  row: number;
  col: number;
  terrain: "grass" | "water" | "frozenWater" | "exposedRiverbed";
  wall: { playerId: ValidPlayerId } | null;
  tower: { index: number; alive: boolean } | null;
  cannon: { playerId: ValidPlayerId; hp: number; mode: CannonMode } | null;
  grunt: { playerId: ValidPlayerId } | null;
  burningPit: boolean;
  interior: readonly ValidPlayerId[];
  zone: number | null;
}

/** Explicit layer priority for cell stacking. Higher number wins.
 *  Decoupled from enum order so reordering `CellKind` can't silently change
 *  which entity renders on top. `Record<CellKind, number>` forces every
 *  kind to have an assigned priority — adding a new kind without a priority
 *  is a compile error. */
const CELL_LAYER_PRIORITY: Record<CellKind, number> = {
  [CellKind.Grass]: 0,
  [CellKind.Water]: 1,
  [CellKind.FrozenWater]: 2,
  [CellKind.Interior]: 3,
  [CellKind.BonusSquare]: 4,
  [CellKind.Wall]: 5,
  [CellKind.BurningPit]: 6,
  [CellKind.House]: 7,
  [CellKind.Cannon]: 8,
  [CellKind.Grunt]: 9,
  [CellKind.TowerDead]: 10,
  [CellKind.TowerAlive]: 11,
  [CellKind.Cannonball]: 12,
};
/** Number of lines the legend produced by `buildLegend` occupies. Used by
 *  `extractGridLines` to strip legend without pattern-matching it. */
const LEGEND_LINE_COUNT = 4;
/** Maximum diff lines emitted by `diffAsciiSnapshots` before truncating. */
const DIFF_LINE_LIMIT = 100;
/** Sentinel for Cell.playerId when the cell has no owner (terrain,
 *  bonus square, pit, house, tower, grunt, cannonball). */
const NO_OWNER = -1 as PlayerId;
/** Default layer for map-rendering helpers — shows every layer stacked. */
export const DEFAULT_MAP_LAYER: MapLayer = "all";

export function buildGrid(
  state: GameState,
  layer: MapLayer,
  playerFilter: number | undefined,
): Cell[][] {
  const grid = paintBase(state);
  paintFrozenTiles(grid, state);
  if (layer === "terrain") return grid;
  paintTerritoryAndWalls(grid, state, playerFilter);
  if (layer === "walls") return grid;
  paintBonusSquares(grid, state);
  paintBurningPits(grid, state);
  paintHouses(grid, state);
  paintTowers(grid, state);
  paintCannons(grid, state, playerFilter);
  paintGrunts(grid, state);
  paintCannonballs(grid, state);
  return grid;
}

export function zoneBounds(state: GameState, zone: ZoneId): Rect | undefined {
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

/** Structured read of everything that lives at a single tile. Used by the
 *  test-facing `tileAt(row, col)` so agents can assert on occupancy
 *  without counting characters in an ASCII dump. */
export function inspectTile(
  state: GameState,
  row: number,
  col: number,
): TileInspection {
  const key = packTile(row, col);
  const tiles = state.map.tiles;
  const frozen = state.modern?.frozenTiles;
  const exposed = state.modern?.exposedRiverbedTiles;
  const terrainTile = tiles[row]?.[col];
  let terrain: TileInspection["terrain"];
  if (terrainTile !== undefined && isWater(tiles, row, col)) {
    if (exposed?.has(key)) terrain = "exposedRiverbed";
    else terrain = frozen?.has(key) ? "frozenWater" : "water";
  } else {
    terrain = "grass";
  }

  let wall: TileInspection["wall"] = null;
  const interior: ValidPlayerId[] = [];
  let cannon: TileInspection["cannon"] = null;
  let grunt: TileInspection["grunt"] = null;
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (player.walls.has(key)) wall = { playerId: player.id };
    if (player.interior.has(key)) interior.push(player.id);
    for (const cannonEntity of player.cannons) {
      if (isCannonTile(cannonEntity, row, col)) {
        cannon = {
          playerId: player.id,
          hp: cannonEntity.hp,
          mode: cannonEntity.mode,
        };
        break;
      }
    }
  }
  for (const gruntEntity of state.grunts) {
    if (gruntEntity.row === row && gruntEntity.col === col) {
      // Grunts are ownerless — display by current-zone owner ("the player
      // it's attacking right now"). Falls back to slot 0 on water/no-zone.
      grunt = { playerId: zoneOwnerIdAt(state, row, col) };
      break;
    }
  }

  let tower: TileInspection["tower"] = null;
  for (let index = 0; index < state.map.towers.length; index++) {
    if (isTowerTile(state.map.towers[index]!, row, col)) {
      tower = { index, alive: state.towerAlive[index] ?? false };
      break;
    }
  }

  return {
    row,
    col,
    terrain,
    wall,
    tower,
    cannon,
    grunt,
    burningPit: hasPitAt(state.burningPits, row, col),
    interior,
    zone: state.map.zones[row]?.[col] ?? null,
  };
}

/** Render a `Cell[][]` grid as an ASCII string, optionally with coordinate
 *  margins. Factored out of `AsciiRenderer.snapshot` / E2E `asciiSnapshot`
 *  so both call sites can opt into margins uniformly. */
export function formatGrid(
  cells: readonly (readonly Cell[])[],
  legend: string,
  opts?: { coords?: boolean },
): string {
  const lines = cells.map((row) => row.map((cell) => cell.char).join(""));
  if (!opts?.coords) return `${legend}\n${lines.join("\n")}`;

  const cols = cells[0]?.length ?? 0;
  const rowLabelW = String(cells.length - 1).length;
  const pad = " ".repeat(rowLabelW);
  const tensHeader = `${pad}  ${buildTensHeader(cols)}`;
  const onesHeader = `${pad}  ${buildOnesHeader(cols)}`;
  const border = `${pad} +${"-".repeat(cols)}+`;
  const body = lines.map(
    (row, index) => `${String(index).padStart(rowLabelW, " ")} |${row}|`,
  );
  return [legend, tensHeader, onesHeader, border, ...body].join("\n");
}

/** Diff two ASCII snapshots (with or without coord margins) and return a
 *  plain-text list of differing tiles. Margins, legend, and borders are
 *  stripped before comparison so snapshots rendered with different
 *  options can still be compared. Capped at 100 lines with a
 *  `... +N more` trailer. Doesn't try to infer causation — each line
 *  reports the raw before/after characters. */
export function diffAsciiSnapshots(before: string, after: string): string {
  const beforeRows = extractGridLines(before);
  const afterRows = extractGridLines(after);
  if (beforeRows.length === 0 || afterRows.length === 0) {
    return "(no grid found in snapshots)";
  }
  if (beforeRows.length !== afterRows.length) {
    return `(snapshot row count mismatch: ${beforeRows.length} vs ${afterRows.length})`;
  }
  const diffs: string[] = [];
  const rowLabelW = String(beforeRows.length - 1).length;
  const maxCol = Math.max(...beforeRows.map((row) => row.length));
  const colLabelW = String(Math.max(0, maxCol - 1)).length;
  for (let row = 0; row < beforeRows.length; row++) {
    const beforeRow = beforeRows[row]!;
    const afterRow = afterRows[row]!;
    const width = Math.min(beforeRow.length, afterRow.length);
    for (let col = 0; col < width; col++) {
      if (beforeRow[col] === afterRow[col]) continue;
      diffs.push(
        `row ${String(row).padStart(rowLabelW, " ")}, ` +
          `col ${String(col).padStart(colLabelW, " ")}: ` +
          `${beforeRow[col]} → ${afterRow[col]}`,
      );
    }
  }
  if (diffs.length === 0) return "(no tile differences)";
  if (diffs.length <= DIFF_LINE_LIMIT) return diffs.join("\n");
  const extra = diffs.length - DIFF_LINE_LIMIT;
  return `${diffs.slice(0, DIFF_LINE_LIMIT).join("\n")}\n... +${extra} more`;
}

export function buildLegend(state: GameState): string {
  const playerInfo = state.players
    .map(
      (player) =>
        `${PLAYER_NAMES[player.id] ?? `P${player.id}`}: ${isPlayerEliminated(player) ? "ELIMINATED" : `${player.lives}♥ ${player.score}pts ${player.walls.size}w ${player.cannons.length}c`}`,
    )
    .join("  |  ");

  return [
    `Round ${state.round}  |  ${playerInfo}`,
    ". grass  ~ water  f frozen  : territory  # wall  T tower  t dead tower",
    "C cannon  x debris  ! grunt  * burning pit  + bonus  o cannonball",
    "Walls: r=Red  b=Blue  g=Gold  |  Cannons: R=Red  B=Blue  G=Gold",
  ].join("\n");
}

function paintBase(state: GameState): Cell[][] {
  const grid: Cell[][] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    const rowCells: Cell[] = [];
    for (let col = 0; col < GRID_COLS; col++) {
      if (isWater(state.map.tiles, row, col)) {
        rowCells.push({ kind: CellKind.Water, char: "~", playerId: NO_OWNER });
      } else {
        rowCells.push({ kind: CellKind.Grass, char: ".", playerId: NO_OWNER });
      }
    }
    grid.push(rowCells);
  }
  return grid;
}

/** Frozen-water overlay — painted before territory so interior/walls can
 *  still win the priority test on shoreline tiles. */
function paintFrozenTiles(grid: Cell[][], state: GameState): void {
  const frozenTiles = state.modern?.frozenTiles;
  if (!frozenTiles) return;
  for (const key of frozenTiles) {
    const { row, col } = unpackTile(key);
    setCell(grid, row, col, CellKind.FrozenWater, "f", NO_OWNER);
  }
}

/** Interior + walls for every non-eliminated player (optionally filtered to
 *  one player). Reads `player.interior` directly — debug grid must work
 *  during battle when interior is stale by design. */
function paintTerritoryAndWalls(
  grid: Cell[][],
  state: GameState,
  playerFilter: number | undefined,
): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    for (const key of player.interior) {
      const { row, col } = unpackTile(key as TileKey);
      setCell(grid, row, col, CellKind.Interior, "░", player.id);
    }
    for (const key of player.walls) {
      const { row, col } = unpackTile(key);
      setCell(grid, row, col, CellKind.Wall, "#", player.id);
    }
  }
}

function paintBonusSquares(grid: Cell[][], state: GameState): void {
  for (const bonus of state.bonusSquares) {
    setCell(grid, bonus.row, bonus.col, CellKind.BonusSquare, "+", NO_OWNER);
  }
}

function paintBurningPits(grid: Cell[][], state: GameState): void {
  for (const pit of state.burningPits) {
    setCell(grid, pit.row, pit.col, CellKind.BurningPit, "*", NO_OWNER);
  }
}

function paintHouses(grid: Cell[][], state: GameState): void {
  for (const house of state.map.houses) {
    const char = house.alive ? "H" : "h";
    setCell(grid, house.row, house.col, CellKind.House, char, NO_OWNER);
  }
}

/** 2×2 tower footprints. */
function paintTowers(grid: Cell[][], state: GameState): void {
  for (let tIdx = 0; tIdx < state.map.towers.length; tIdx++) {
    const tower = state.map.towers[tIdx]!;
    const alive = state.towerAlive[tIdx]!;
    const kind = alive ? CellKind.TowerAlive : CellKind.TowerDead;
    const char = alive ? "T" : "t";
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        setCell(grid, tower.row + dr, tower.col + dc, kind, char, NO_OWNER);
      }
    }
  }
}

/** Cannon footprints (size×size, matching `inspectTile`'s `isCannonTile`
 *  view — earlier versions only painted the top-left tile). */
function paintCannons(
  grid: Cell[][],
  state: GameState,
  playerFilter: number | undefined,
): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    for (const cannon of player.cannons) {
      const char = cannon.hp <= 0 ? "x" : "C";
      const size = cannonModeDef(cannon.mode).size;
      for (let dr = 0; dr < size; dr++) {
        for (let dc = 0; dc < size; dc++) {
          setCell(
            grid,
            cannon.row + dr,
            cannon.col + dc,
            CellKind.Cannon,
            char,
            player.id,
          );
        }
      }
    }
  }
}

function paintGrunts(grid: Cell[][], state: GameState): void {
  for (const grunt of state.grunts) {
    setCell(grid, grunt.row, grunt.col, CellKind.Grunt, "!", NO_OWNER);
  }
}

/** Cannonballs snap to the nearest tile by pixel-center rounding. */
function paintCannonballs(grid: Cell[][], state: GameState): void {
  for (const ball of state.cannonballs) {
    const row = Math.round(ball.y / TILE_SIZE);
    const col = Math.round(ball.x / TILE_SIZE);
    if (inBounds(row, col)) {
      setCell(grid, row, col, CellKind.Cannonball, "o", NO_OWNER);
    }
  }
}

/** Extract only the grid body from an ASCII snapshot. Handles both plain
 *  and coord-margin formats so `diffAsciiSnapshots` can compare across
 *  format variants. */
function extractGridLines(snapshot: string): string[] {
  const lines = snapshot.split("\n");
  const marginPattern = /^\s*\d+\s\|(.*)\|$/;
  const marginRows = lines
    .map((line) => marginPattern.exec(line)?.[1])
    .filter((inner): inner is string => inner !== undefined);
  if (marginRows.length > 0) return marginRows;
  // Plain format: legend occupies the first LEGEND_LINE_COUNT lines,
  // grid body follows. Drop empty trailing lines (from trailing newline).
  return lines.slice(LEGEND_LINE_COUNT).filter((line) => line.length > 0);
}

function buildTensHeader(cols: number): string {
  let line = "";
  for (let col = 0; col < cols; col++) {
    line += col >= 10 && col % 10 === 0 ? String(Math.floor(col / 10)) : " ";
  }
  return line;
}

function buildOnesHeader(cols: number): string {
  let line = "";
  for (let col = 0; col < cols; col++) line += String(col % 10);
  return line;
}

function setCell(
  grid: readonly Cell[][],
  row: number,
  col: number,
  kind: CellKind,
  char: string,
  playerId: PlayerId,
): void {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return;
  const existing = grid[row]![col]!;
  if (CELL_LAYER_PRIORITY[kind] >= CELL_LAYER_PRIORITY[existing.kind]) {
    grid[row]![col] = { kind, char, playerId };
  }
}
