/**
 * Debug / diagnostic utilities — game-domain interpretation for dev tools.
 *
 * Consumed only by dev-console.ts and runtime-e2e-bridge.ts. Lives in
 * runtime/ because it's dev tooling, not gameplay — moved out of game/
 * to keep the game public surface free of debug concerns.
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { isWater, unpackTile } from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
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

export function zoneBounds(state: GameState, zone: number): Rect | undefined {
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
  if (kind >= existing.kind) {
    grid[row]![col] = extra
      ? { kind, char, playerId, extra }
      : { kind, char, playerId };
  }
}
