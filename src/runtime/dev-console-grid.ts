/**
 * Debug / diagnostic utilities — game-domain interpretation for dev tools.
 *
 * Consumed only by dev-console.ts and runtime-e2e-bridge.ts. Lives in
 * runtime/ because it's dev tooling, not gameplay — moved out of game/
 * to keep the game public surface free of debug concerns.
 */

import type { CannonMode } from "../shared/core/battle-types.ts";
import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  hasPitAt,
  isCannonTile,
  isTowerTile,
  isWater,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { PLAYER_NAMES } from "../shared/ui/player-config.ts";

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
  playerId: number;
  /** Serialized entity state for parity testing. Encodes all renderer-visible
   *  fields so checkpoint roundtrip bugs show up in grid comparison. */
  extra?: string;
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
  terrain: "grass" | "water" | "frozenWater" | "lowWater";
  wall: { playerId: ValidPlayerSlot } | null;
  tower: { index: number; alive: boolean } | null;
  cannon: { playerId: ValidPlayerSlot; hp: number; mode: CannonMode } | null;
  grunt: { playerId: ValidPlayerSlot } | null;
  burningPit: boolean;
  interior: readonly ValidPlayerSlot[];
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
/** Default layer for map-rendering helpers — shows every layer stacked. */
export const DEFAULT_MAP_LAYER: MapLayer = "all";

export function buildGrid(
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

  // Frozen tiles (overlay on water — must come before territory)
  const frozenTiles = state.modern?.frozenTiles;
  if (frozenTiles) {
    for (const key of frozenTiles) {
      const { r, c } = unpackTile(key);
      setCell(grid, r, c, CellKind.FrozenWater, "f", -1, "frozen");
    }
  }

  if (layer === "terrain") return grid;

  // Territory + walls
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    // Intentionally reads player.interior directly (no getInterior) —
    // debug grid must work during battle when interior is stale by design.
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
    setCell(
      grid,
      bonus.row,
      bonus.col,
      CellKind.BonusSquare,
      "+",
      -1,
      `z${bonus.zone}`,
    );
  }

  // Burning pits
  for (const pit of state.burningPits) {
    setCell(
      grid,
      pit.row,
      pit.col,
      CellKind.BurningPit,
      "*",
      -1,
      `r${pit.roundsLeft}`,
    );
  }

  // Houses (alive and dead)
  for (const house of state.map.houses) {
    const char = house.alive ? "H" : "h";
    setCell(
      grid,
      house.row,
      house.col,
      CellKind.House,
      char,
      -1,
      `z${house.zone}${house.alive ? "a" : "d"}`,
    );
  }

  // Towers (2×2)
  for (let tIdx = 0; tIdx < state.map.towers.length; tIdx++) {
    const tower = state.map.towers[tIdx]!;
    const alive = state.towerAlive[tIdx]!;
    const kind = alive ? CellKind.TowerAlive : CellKind.TowerDead;
    const char = alive ? "T" : "t";
    const pending = state.towerPendingRevive.has(tIdx);
    const extra = `i${tIdx}z${tower.zone}${alive ? "a" : "d"}${pending ? "p" : ""}`;
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        setCell(grid, tower.row + dr, tower.col + dc, kind, char, -1, extra);
      }
    }
  }

  // Cannons
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (playerFilter !== undefined && player.id !== playerFilter) continue;
    for (const cannon of player.cannons) {
      const char = cannon.hp <= 0 ? "x" : "C";
      const facing = Math.round((cannon.facing ?? 0) * 100);
      let extra = `${cannon.mode}h${cannon.hp}f${facing}`;
      if (cannon.mortar) extra += "m";
      if (cannon.shielded) extra += "s";
      if (cannon.balloonHits) extra += `b${cannon.balloonHits}`;
      setCell(
        grid,
        cannon.row,
        cannon.col,
        CellKind.Cannon,
        char,
        player.id,
        extra,
      );
    }
  }

  // Grunts
  for (const grunt of state.grunts) {
    const facing =
      grunt.facing !== undefined ? Math.round(grunt.facing * 100) : "";
    let extra = `v${grunt.victimPlayerId}t${grunt.targetTowerIdx ?? "?"}b${grunt.blockedRounds}`;
    if (grunt.attackingWall) extra += "w";
    if (grunt.attackCountdown !== undefined)
      extra += `c${grunt.attackCountdown.toFixed(1)}`;
    if (facing !== "") extra += `f${facing}`;
    setCell(grid, grunt.row, grunt.col, CellKind.Grunt, "!", -1, extra);
  }

  // Cannonballs (snap to nearest tile)
  for (const ball of state.cannonballs) {
    const row = Math.round(ball.y / TILE_SIZE);
    const col = Math.round(ball.x / TILE_SIZE);
    if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
      const extra = `p${ball.playerId}${ball.incendiary ? "i" : ""}`;
      setCell(grid, row, col, CellKind.Cannonball, "o", -1, extra);
    }
  }

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
  const lowWater = state.modern?.lowWaterTiles;
  const terrainTile = tiles[row]?.[col];
  let terrain: TileInspection["terrain"];
  if (terrainTile !== undefined && isWater(tiles, row, col)) {
    terrain = frozen?.has(key) ? "frozenWater" : "water";
  } else if (lowWater?.has(key)) {
    terrain = "lowWater";
  } else {
    terrain = "grass";
  }

  let wall: TileInspection["wall"] = null;
  const interior: ValidPlayerSlot[] = [];
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
      grunt = { playerId: gruntEntity.victimPlayerId };
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
  playerId: number,
  extra?: string,
): void {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return;
  const existing = grid[row]![col]!;
  if (CELL_LAYER_PRIORITY[kind] >= CELL_LAYER_PRIORITY[existing.kind]) {
    grid[row]![col] = extra
      ? { kind, char, playerId, extra }
      : { kind, char, playerId };
  }
}
