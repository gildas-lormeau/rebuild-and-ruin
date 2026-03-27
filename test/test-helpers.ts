/**
 * Shared helpers for AI build-phase placement tests.
 *
 * Legend (input maps):
 *      = grass (space)
 *   #  = wall (player 0)
 *   T  = tower (2x2, marks top-left)
 *   B  = burning pit
 *   G  = grunt
 *   ~  = water
 *   X  = generic obstacle (water — blocks placement, neutral)
 *
 * Legend (expected maps only):
 *   *  = newly placed wall
 *
 * Usage:
 *   import { parseBoard, assertPlacement, test, runTests } from "./test-helpers.ts";
 */

import { GRID_ROWS, GRID_COLS, Tile } from "../src/grid.ts";
import type { Castle, GameMap, Tower } from "../src/geometry-types.ts";
import type { GameState, Player } from "../src/types.ts";
import { Phase } from "../src/types.ts";
import { pickPlacementStandalone as pickPlacement } from "../src/ai-strategy.ts";
import { placePiece, claimTerritory } from "../src/build-system.ts";
import type { PieceShape } from "../src/pieces.ts";
import { Rng } from "../src/rng.ts";
import process from "node:process";

// ---------------------------------------------------------------------------
// ASCII helpers
// ---------------------------------------------------------------------------

const CONTENT_RE = /[#T~BGX*]/;

/**
 * Parse template literal into lines, preserving spaces.
 * Maps are never indented — content starts at column 0.
 * Trailing grass-only rows (spaces) are included if they have content width.
 */
function parseAsciiLines(ascii: string): string[] {
  const allLines = ascii.split("\n");
  let firstIdx = allLines.findIndex(l => CONTENT_RE.test(l));
  if (firstIdx === -1) return [];

  // Extend backwards to include leading grass-only rows
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (allLines[i]!.length > 0) {
      firstIdx = i;
    } else {
      break;
    }
  }

  // Find last content line, then extend to include trailing grass-only rows
  let lastIdx = allLines.length - 1 - [...allLines].reverse().findIndex(l => CONTENT_RE.test(l));
  for (let i = lastIdx + 1; i < allLines.length; i++) {
    if (allLines[i]!.length > 0) {
      lastIdx = i;
    } else {
      break;
    }
  }

  return allLines.slice(firstIdx, lastIdx + 1);
}

// ---------------------------------------------------------------------------
// ASCII parser -> GameState
// ---------------------------------------------------------------------------

export interface ParseResult {
  state: GameState;
  castle: Castle;
  /** Grid offset where the ASCII block is placed. */
  offsetR: number;
  offsetC: number;
  /** Dimensions of the ASCII block. */
  rows: number;
  cols: number;
  /** Original ASCII characters per grid key — used to distinguish ~ from X in output. */
  originalChars: Map<number, string>;
}

export function parseBoard(ascii: string, playerId = 0): ParseResult {
  const lines = parseAsciiLines(ascii);

  // Place the ascii block at (2,2) to leave room for flood-fill from edges.
  const OFFSET_R = 2;
  const OFFSET_C = 2;

  const tiles: Tile[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    tiles[r] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      tiles[r]![c] = Tile.Grass;
    }
  }

  const zones: number[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    zones[r] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      zones[r]![c] = 1;
    }
  }

  const walls = new Set<number>();
  const towers: Tower[] = [];
  const grunts: { row: number; col: number; ownerId: number; targetPlayerId: number }[] = [];
  const burningPits: { row: number; col: number; roundsLeft: number }[] = [];
  const originalChars = new Map<number, string>();

  const maxCols = Math.max(...lines.map(l => l.length));

  for (let lr = 0; lr < lines.length; lr++) {
    const line = lines[lr]!;
    for (let lc = 0; lc < line.length; lc++) {
      const ch = line[lc];
      const r = OFFSET_R + lr;
      const c = OFFSET_C + lc;
      if (r >= GRID_ROWS || c >= GRID_COLS) continue;
      const key = r * GRID_COLS + c;
      if (ch && ch !== " ") originalChars.set(key, ch);

      switch (ch) {
        case "#":
          walls.add(key);
          break;
        case "T":
          // Only register the tower once (top-left of the 2x2 block).
          // The map must use T for all 4 tiles of a tower.
          if (!towers.some(t => r >= t.row && r < t.row + 2 && c >= t.col && c < t.col + 2)) {
            towers.push({ row: r, col: c, zone: 1, index: towers.length });
          }
          break;
        case "B":
          burningPits.push({ row: r, col: c, roundsLeft: 3 });
          break;
        case "G":
          grunts.push({ row: r, col: c, ownerId: 1, targetPlayerId: playerId });
          break;
        case "~":
        case "X":
          tiles[r]![c] = Tile.Water;
          zones[r]![c] = 0;
          break;
      }
    }
  }

  const tower = towers[0] ?? { row: OFFSET_R + 1, col: OFFSET_C + 1, zone: 1, index: 0 };
  let top = tower.row, bottom = tower.row + 1;
  let left = tower.col, right = tower.col + 1;
  for (const key of walls) {
    const wr = Math.floor(key / GRID_COLS);
    const wc = key % GRID_COLS;
    if (wr < top) top = wr;
    if (wr > bottom) bottom = wr;
    if (wc < left) left = wc;
    if (wc > right) right = wc;
  }
  const castle: Castle = { top: top + 1, bottom: bottom - 1, left: left + 1, right: right - 1, tower };

  const player: Player = {
    id: playerId,
    homeTower: tower,
    castle,
    ownedTowers: [tower],
    walls,
    interior: new Set(),
    cannons: [],
    lives: 3,
    eliminated: false,
    score: 0,
    defaultFacing: 0,
  };

  const map: GameMap = {
    tiles,
    towers,
    houses: [],
    zones,
    junction: { x: 0, y: 0 },
    exits: [],
  };

  const state: GameState = {
    rng: new Rng(1),
    map,
    phase: Phase.WALL_BUILD,
    round: 2,
    battleLength: 5,
    cannonMaxHp: 3,
    players: [player],
    activePlayer: 0,
    timer: 30,
    cannonballs: [],
    shotsFired: 0,
    grunts,
    towerAlive: towers.map(() => true),
    towerPendingRevive: new Set(),
    burningPits,
    capturedCannons: [],
    balloonHits: new Map(),
    bonusSquares: [],
    battleCountdown: 0,
    reselectedPlayers: new Set(),
    playerZones: [0],
    cannonLimits: [0],
    buildTimer: 25,
    cannonPlaceTimer: 15,
    firstRoundCannons: 3,
  };

  claimTerritory(state);

  return { state, castle, offsetR: OFFSET_R, offsetC: OFFSET_C, rows: lines.length, cols: maxCols, originalChars };
}

// ---------------------------------------------------------------------------
// Board serializer (state -> ASCII)
// ---------------------------------------------------------------------------

/**
 * Serialize the board region back to ASCII.
 * `newWalls` marks tiles that were placed by the AI (shown as `*`).
 * Water tiles are output as their original character (`~` or `X`).
 */
function serializeTile(
  state: GameState,
  r: number,
  c: number,
  key: number,
  player: Player,
  newWalls: Set<number> | undefined,
  originalChars: Map<number, string>,
): string {
  if (state.map.tiles[r]?.[c] === Tile.Water) {
    return originalChars.get(key) ?? "~";
  } else if (state.map.towers.some(t =>
    r >= t.row && r < t.row + 2 && c >= t.col && c < t.col + 2)) {
    return "T";
  } else if (state.burningPits.some(p => p.row === r && p.col === c)) {
    return "B";
  } else if (state.grunts.some(g => g.row === r && g.col === c)) {
    return "G";
  } else if (newWalls && newWalls.has(key)) {
    return "*";
  } else if (player.walls.has(key)) {
    return "#";
  }
  return " ";
}

export function serializeBoard(state: GameState, parsed: ParseResult, newWalls?: Set<number>): string {
  const { offsetR, offsetC, rows, cols, originalChars } = parsed;
  const player = state.players[0]!;
  const lines: string[] = [];

  for (let lr = 0; lr < rows; lr++) {
    let line = "";
    for (let lc = 0; lc < cols; lc++) {
      const r = offsetR + lr;
      const c = offsetC + lc;
      const key = r * GRID_COLS + c;
      line += serializeTile(state, r, c, key, player, newWalls, originalChars);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

/**
 * Parse an expected ASCII map.
 * Returns a normalized string where only the shape matters.
 */
function normalizeExpected(ascii: string): string {
  const lines = parseAsciiLines(ascii);
  return lines.map(l => l.replace(/\s+$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Run pickPlacement, apply the result, serialize, and compare to expected map.
 * In expected maps, `*` marks where the AI should place new walls.
 */
export function assertPlacement(
  state: GameState,
  parsed: ParseResult,
  piece: PieceShape,
  expectedAscii: string,
  playerId = 0,
): void {
  const result = pickPlacement(state, playerId, piece);
  const expected = normalizeExpected(expectedAscii);

  if (!result) {
    // No placement — serialize current board and compare (expected should have no `*`)
    const actual = serializeBoard(state, parsed);
    assert(actual === expected,
      `AI returned null.\nExpected:\n${expected}\nActual:\n${actual}`);
    return;
  }

  // Track which tiles are newly placed
  const wallsBefore = new Set(state.players[playerId]!.walls);
  placePiece(state, playerId, result.piece, result.row, result.col);
  const newWalls = new Set<number>();
  for (const key of state.players[playerId]!.walls) {
    if (!wallsBefore.has(key)) newWalls.add(key);
  }

  const actual = serializeBoard(state, parsed, newWalls);
  assert(actual === expected,
    `Board mismatch.\nExpected:\n${expected}\nActual:\n${actual}`);
}

/**
 * Run pickPlacement, apply the result, serialize, and accept any one of the
 * provided expected maps. Useful when multiple placements are equally valid.
 */
export function assertPlacementOneOf(
  state: GameState,
  parsed: ParseResult,
  piece: PieceShape,
  expectedAsciiOptions: string[],
  playerId = 0,
): void {
  const expectedOptions = expectedAsciiOptions.map(normalizeExpected);
  const result = pickPlacement(state, playerId, piece);

  if (!result) {
    const actual = serializeBoard(state, parsed);
    assert(
      expectedOptions.includes(actual),
      `AI returned null.\nExpected one of:\n${expectedOptions.join("\n---\n")}\nActual:\n${actual}`,
    );
    return;
  }

  const wallsBefore = new Set(state.players[playerId]!.walls);
  placePiece(state, playerId, result.piece, result.row, result.col);
  const newWalls = new Set<number>();
  for (const key of state.players[playerId]!.walls) {
    if (!wallsBefore.has(key)) newWalls.add(key);
  }

  const actual = serializeBoard(state, parsed, newWalls);
  assert(
    expectedOptions.includes(actual),
    `Board mismatch.\nExpected one of:\n${expectedOptions.join("\n---\n")}\nActual:\n${actual}`,
  );
}

/**
 * Run pickPlacement and assert the piece is NOT placed at the `*`-marked tiles.
 * Use this to specify positions the AI should avoid.
 */
export function assertNotPlacedAt(
  state: GameState,
  parsed: ParseResult,
  piece: PieceShape,
  forbiddenAscii: string,
  playerId = 0,
): void {
  const lines = parseAsciiLines(forbiddenAscii);
  const { offsetR, offsetC } = parsed;
  const forbidden = new Set<number>();
  for (let lr = 0; lr < lines.length; lr++) {
    const line = lines[lr]!;
    for (let lc = 0; lc < line.length; lc++) {
      if (line[lc] === "*") {
        forbidden.add((offsetR + lr) * GRID_COLS + (offsetC + lc));
      }
    }
  }

  const result = pickPlacement(state, playerId, piece);
  if (!result) return; // no placement at all — trivially not at forbidden tiles

  // Compute new walls from piece offsets without mutating state
  const newWalls = new Set<number>();
  for (const [dr, dc] of result.piece.offsets) {
    newWalls.add((result.row + dr) * GRID_COLS + (result.col + dc));
  }

  // Check if the AI chose the exact forbidden placement (all forbidden tiles present)
  const allForbiddenPlaced = [...forbidden].every(key => newWalls.has(key));
  assert(!allForbiddenPlaced,
    `AI placed a wall at forbidden position.\nForbidden map:\n${lines.join("\n")}\nActual:\n${serializeBoard(state, parsed, newWalls)}`);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestCase {
  name: string;
  fn: () => void;
  expected: "pass" | "known-failure";
}

const tests: TestCase[] = [];

export function test(name: string, fn: () => void) {
  tests.push({ name, fn, expected: "pass" });
}

export function knownFailureTest(name: string, fn: () => void) {
  tests.push({ name, fn, expected: "known-failure" });
}

export function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function runTests(label?: string) {
  if (label) console.log(`${label}\n`);
  const suite = tests.splice(0, tests.length);
  let passed = 0;
  let failed = 0;
  let knownFailures = 0;
  let unexpectedPasses = 0;
  for (const t of suite) {
    try {
      t.fn();
      if (t.expected === "known-failure") {
        console.log(`  ! ${t.name} (unexpected pass)`);
        unexpectedPasses++;
      } else {
        console.log(`  ✓ ${t.name}`);
        passed++;
      }
    // deno-lint-ignore no-explicit-any
    } catch (e: any) {
      if (t.expected === "known-failure") {
        console.log(`  ~ ${t.name} (known limitation)`);
        console.log(`    ${e.message}`);
        knownFailures++;
      } else {
        console.log(`  ✗ ${t.name}`);
        console.log(`    ${e.message}`);
        failed++;
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${knownFailures} known limitations, ${unexpectedPasses} unexpected passes`);
  if (failed > 0 || unexpectedPasses > 0) process.exit(1);
}
