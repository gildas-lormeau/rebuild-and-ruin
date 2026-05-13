/**
 * Phase-test fixture editor — interactive TUI.
 *
 * Usage:
 *   deno run -A scripts/fixture-tui.ts --fixture <path>
 *
 * Keys:
 *   arrows  — move cursor
 *   h/b/w   — place house / bonus / wall at cursor
 *   x       — remove any override at cursor
 *   0..N    — switch active wall owner
 *   u       — undo last edit
 *   s       — save (validates by re-running the loader end-to-end)
 *   q       — quit (prompts if dirty)
 *
 * Boot strategy: bootstraps the runtime ONCE with the seed/mode/round from
 * the fixture, but with overrides stripped — that produces the seed-baked
 * baseline state. Per-frame rendering then layers the in-memory fixture
 * overrides as character overlays on top of the cached baseline cells,
 * so keystrokes redraw in microseconds instead of re-booting.
 */

import {
  buildGrid,
  type Cell,
  CellKind,
  inspectTile,
} from "../src/runtime/dev-console-grid.ts";
import { TOWER_SIZE } from "../src/shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
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
import type { Scenario } from "../test/scenario.ts";

type Tool = "house" | "bonus" | "wall";

type Mode = "author" | "replay";

interface EditorState {
  mode: Mode;
  fixturePath: string;
  fixture: FixtureFile;
  baseline: Cell[][];
  baselineState: GameState;
  towerTiles: ReadonlySet<number>;
  playerCount: number;
  cursorRow: number;
  cursorCol: number;
  tool: Tool;
  owner: number;
  dirty: boolean;
  message: string;
  messageKind: "info" | "ok" | "error";
  undoStack: FixtureFile[];
  /** Live replay scenario — non-null only when `mode === "replay"`. The
   *  scenario is booted from the current in-memory fixture (saved or not)
   *  on `enterReplay` and disposed on `exitReplay`. */
  replayScenario?: Scenario;
  /** Current frame's cells from `replayScenario.state`. Rebuilt on every
   *  step so the canvas mirrors the live state. */
  replayCells?: Cell[][];
  /** Total frames advanced since replay started. Surfaced in the status
   *  bar so you can correlate observed state to a tick count. */
  replayTicks?: number;
  /** `replayScenario.now()` captured at replay start — sim-time deltas in
   *  the status bar are `now() - replayStartTimeMs`. */
  replayStartTimeMs?: number;
}

type Action =
  | "quit"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tool:house"
  | "tool:bonus"
  | "tool:wall"
  | "primary"
  | "remove"
  | "undo"
  | "save"
  | "enter-replay"
  | "exit-replay"
  | { kind: "owner"; value: number }
  | "ignore";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const INVERSE = "\x1b[7m";
const DIM = "\x1b[2m";
const FG_RED = "\x1b[31m";
const FG_GREEN = "\x1b[32m";
const FG_YELLOW = "\x1b[33m";
const FG_BLUE = "\x1b[34m";
const FG_MAGENTA = "\x1b[35m";
const FG_CYAN = "\x1b[36m";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const OWNER_COLORS = [FG_RED, FG_BLUE, FG_YELLOW];

await main();

async function main(): Promise<void> {
  const path = parseFixtureArg(Deno.args);
  const fixture = await readFixture(path);
  const baselineFixture: FixtureFile = {
    ...fixture,
    houses: undefined,
    bonusSquares: undefined,
    walls: undefined,
  };
  const sc = await createPhaseScenario(baselineFixture);
  const baseline = buildGrid(sc.state, "all", undefined);
  const towerTiles = collectTowerTileSet(sc.state.map.towers);
  const playerCount = sc.state.players.length;

  const state: EditorState = {
    mode: "author",
    fixturePath: path,
    fixture,
    baseline,
    baselineState: sc.state,
    towerTiles,
    playerCount,
    cursorRow: Math.floor(GRID_ROWS / 2),
    cursorCol: Math.floor(GRID_COLS / 2),
    tool: "wall",
    owner: 0,
    dirty: false,
    message: `loaded ${path}`,
    messageKind: "info",
    undoStack: [],
  };

  await runEditorLoop(state);
}

async function runEditorLoop(state: EditorState): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    console.error(
      "fixture-tui requires an interactive terminal — stdin is not a TTY.\n" +
        "If you want non-interactive edits, use scripts/fixture-cli.ts instead.",
    );
    Deno.exit(2);
  }
  Deno.stdin.setRaw(true);
  writeStdout(HIDE_CURSOR + CLEAR_SCREEN);
  try {
    draw(state);
    const buf = new Uint8Array(8);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const action = decodeKey(buf.subarray(0, n));
      if (action === "quit") {
        if (state.dirty) {
          state.message =
            "unsaved changes — press q again to discard, or s to save";
          state.messageKind = "error";
          draw(state);
          const confirmN = await Deno.stdin.read(buf);
          if (confirmN === null) break;
          if (decodeKey(buf.subarray(0, confirmN)) !== "quit") {
            state.message = "quit cancelled";
            state.messageKind = "info";
            draw(state);
            continue;
          }
        }
        break;
      }
      await handleAction(state, action);
      draw(state);
    }
  } finally {
    writeStdout(SHOW_CURSOR + RESET + "\n");
    Deno.stdin.setRaw(false);
  }
}

function decodeKey(bytes: Uint8Array): Action {
  if (bytes.length === 1) {
    const ch = String.fromCharCode(bytes[0]!);
    switch (ch) {
      case "q":
      case "\x03": // Ctrl-C
        return "quit";
      case "h":
        return "tool:house";
      case "b":
        return "tool:bonus";
      case "w":
        return "tool:wall";
      case " ":
      case "\r":
      case "\n":
        return "primary";
      case "x":
        return "remove";
      case "u":
        return "undo";
      case "s":
        return "save";
      case "r":
        return "enter-replay";
      case "e":
        return "exit-replay";
    }
    if (ch >= "0" && ch <= "9") {
      return { kind: "owner", value: Number(ch) };
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0x1b && bytes[1] === 0x5b) {
    switch (bytes[2]) {
      case 0x41:
        return "up";
      case 0x42:
        return "down";
      case 0x43:
        return "right";
      case 0x44:
        return "left";
    }
  }
  // Bare ESC also quits — convenient escape hatch.
  if (bytes.length === 1 && bytes[0] === 0x1b) return "quit";
  return "ignore";
}

async function handleAction(state: EditorState, action: Action): Promise<void> {
  if (typeof action === "object") {
    if (action.kind === "owner") {
      if (action.value < state.playerCount) {
        state.owner = action.value;
        state.message = `owner = ${action.value} (${PLAYER_NAMES[action.value] ?? action.value})`;
        state.messageKind = "info";
      } else {
        state.message = `no player ${action.value} (only ${state.playerCount} active)`;
        state.messageKind = "error";
      }
    }
    return;
  }
  switch (action) {
    case "up":
      state.cursorRow = Math.max(0, state.cursorRow - 1);
      return;
    case "down":
      state.cursorRow = Math.min(GRID_ROWS - 1, state.cursorRow + 1);
      return;
    case "left":
      state.cursorCol = Math.max(0, state.cursorCol - 1);
      return;
    case "right":
      state.cursorCol = Math.min(GRID_COLS - 1, state.cursorCol + 1);
      return;
    case "tool:house":
      if (state.mode === "replay") return rejectInReplay(state);
      state.tool = "house";
      state.message = "tool = house";
      state.messageKind = "info";
      return;
    case "tool:bonus":
      if (state.mode === "replay") return rejectInReplay(state);
      state.tool = "bonus";
      state.message = "tool = bonus";
      state.messageKind = "info";
      return;
    case "tool:wall":
      if (state.mode === "replay") return rejectInReplay(state);
      state.tool = "wall";
      state.message = "tool = wall";
      state.messageKind = "info";
      return;
    case "primary":
      if (state.mode === "replay") stepReplay(state, 1);
      else placeAtCursor(state);
      return;
    case "remove":
      if (state.mode === "replay") return rejectInReplay(state);
      removeAtCursor(state);
      return;
    case "undo":
      if (state.mode === "replay") return rejectInReplay(state);
      undo(state);
      return;
    case "save":
      if (state.mode === "replay") return rejectInReplay(state);
      await save(state);
      return;
    case "enter-replay":
      if (state.mode === "author") await enterReplay(state);
      return;
    case "exit-replay":
      if (state.mode === "replay") exitReplay(state);
      return;
    case "ignore":
      return;
  }
}

function rejectInReplay(state: EditorState): void {
  state.message = "not available in replay mode — press e to exit replay";
  state.messageKind = "error";
}

async function enterReplay(state: EditorState): Promise<void> {
  try {
    const sc = await createPhaseScenario(state.fixture);
    if (state.fixture.walls && state.fixture.walls.length > 0) {
      recomputeFixtureDerivedState(sc.state);
    }
    state.replayScenario = sc;
    state.replayCells = buildGrid(sc.state, "all", undefined);
    state.replayTicks = 0;
    state.replayStartTimeMs = sc.now();
    state.mode = "replay";
    state.message = "entered replay — space steps a frame, e exits";
    state.messageKind = "ok";
  } catch (err) {
    state.message = `cannot enter replay: ${err instanceof Error ? err.message : String(err)}`;
    state.messageKind = "error";
  }
}

function exitReplay(state: EditorState): void {
  state.replayScenario = undefined;
  state.replayCells = undefined;
  state.replayTicks = undefined;
  state.replayStartTimeMs = undefined;
  state.mode = "author";
  state.message = "exited replay";
  state.messageKind = "info";
}

function stepReplay(state: EditorState, frames: number): void {
  const sc = state.replayScenario;
  if (!sc) {
    state.message = "no live replay scenario";
    state.messageKind = "error";
    return;
  }
  try {
    sc.tick(frames);
    state.replayTicks = (state.replayTicks ?? 0) + frames;
    state.replayCells = buildGrid(sc.state, "all", undefined);
  } catch (err) {
    state.message = `tick failed: ${err instanceof Error ? err.message : String(err)}`;
    state.messageKind = "error";
  }
}

function placeAtCursor(state: EditorState): void {
  const row = state.cursorRow;
  const col = state.cursorCol;
  const err = validatePlacement(state, row, col);
  if (err !== null) {
    state.message = err;
    state.messageKind = "error";
    return;
  }
  snapshotForUndo(state);
  switch (state.tool) {
    case "house": {
      const houses: HouseOverride[] = [...(state.fixture.houses ?? [])];
      houses.push({ row, col });
      state.fixture = { ...state.fixture, houses };
      state.message = `placed house at (${row},${col})`;
      break;
    }
    case "bonus": {
      const bonusSquares: BonusSquareOverride[] = [
        ...(state.fixture.bonusSquares ?? []),
      ];
      bonusSquares.push({ row, col });
      state.fixture = { ...state.fixture, bonusSquares };
      state.message = `placed bonus at (${row},${col})`;
      break;
    }
    case "wall": {
      const walls: WallOverride[] = [...(state.fixture.walls ?? [])];
      walls.push({ row, col, ownerId: state.owner });
      state.fixture = { ...state.fixture, walls };
      state.message = `placed wall at (${row},${col}) owner=${state.owner}`;
      break;
    }
  }
  state.dirty = true;
  state.messageKind = "ok";
}

function removeAtCursor(state: EditorState): void {
  const row = state.cursorRow;
  const col = state.cursorCol;
  const removed: string[] = [];
  const houses = (state.fixture.houses ?? []).filter((house) => {
    if (house.row === row && house.col === col) {
      removed.push("house");
      return false;
    }
    return true;
  });
  const bonusSquares = (state.fixture.bonusSquares ?? []).filter((bonus) => {
    if (bonus.row === row && bonus.col === col) {
      removed.push("bonus");
      return false;
    }
    return true;
  });
  const walls = (state.fixture.walls ?? []).filter((wall) => {
    if (wall.row === row && wall.col === col) {
      removed.push(`wall(owner=${wall.ownerId})`);
      return false;
    }
    return true;
  });
  if (removed.length === 0) {
    state.message = `nothing to remove at (${row},${col})`;
    state.messageKind = "error";
    return;
  }
  snapshotForUndo(state);
  state.fixture = {
    ...state.fixture,
    houses: houses.length > 0 ? houses : undefined,
    bonusSquares: bonusSquares.length > 0 ? bonusSquares : undefined,
    walls: walls.length > 0 ? walls : undefined,
  };
  state.dirty = true;
  state.message = `removed ${removed.join(", ")} at (${row},${col})`;
  state.messageKind = "ok";
}

function undo(state: EditorState): void {
  const previous = state.undoStack.pop();
  if (!previous) {
    state.message = "nothing to undo";
    state.messageKind = "info";
    return;
  }
  state.fixture = previous;
  state.dirty =
    state.undoStack.length > 0 ||
    hasOverrides(previous) !== hasOverrides(state.fixture);
  state.message = "undid last edit";
  state.messageKind = "info";
}

async function save(state: EditorState): Promise<void> {
  try {
    const sc = await createPhaseScenario(state.fixture);
    if (state.fixture.walls && state.fixture.walls.length > 0) {
      recomputeFixtureDerivedState(sc.state);
    }
    sc.tick(1);
  } catch (err) {
    state.message = `save blocked: ${err instanceof Error ? err.message : String(err)}`;
    state.messageKind = "error";
    return;
  }
  await Deno.writeTextFile(
    state.fixturePath,
    `${JSON.stringify(state.fixture, null, 2)}\n`,
  );
  state.dirty = false;
  state.undoStack = [];
  state.message = `saved ${state.fixturePath}`;
  state.messageKind = "ok";
}

function validatePlacement(
  state: EditorState,
  row: number,
  col: number,
): string | null {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
    return `(${row},${col}) out of bounds`;
  }
  const baseCell = state.baseline[row]?.[col];
  if (!baseCell) return `(${row},${col}) has no baseline cell`;
  if (
    baseCell.kind === CellKind.Water ||
    baseCell.kind === CellKind.FrozenWater
  ) {
    return `(${row},${col}) is water`;
  }
  const key = row * GRID_COLS + col;
  if (state.towerTiles.has(key)) return `(${row},${col}) is a tower`;
  if (state.tool === "wall") {
    if (state.owner < 0 || state.owner >= state.playerCount) {
      return `owner ${state.owner} out of range (0..${state.playerCount - 1})`;
    }
    const exists = (state.fixture.walls ?? []).some(
      (wall) => wall.row === row && wall.col === col,
    );
    if (exists) return `wall already at (${row},${col})`;
  }
  if (state.tool === "house") {
    const exists = (state.fixture.houses ?? []).some(
      (house) => house.row === row && house.col === col,
    );
    if (exists) return `house already at (${row},${col})`;
  }
  if (state.tool === "bonus") {
    const exists = (state.fixture.bonusSquares ?? []).some(
      (bonus) => bonus.row === row && bonus.col === col,
    );
    if (exists) return `bonus already at (${row},${col})`;
  }
  return null;
}

function snapshotForUndo(state: EditorState): void {
  state.undoStack.push(cloneFixture(state.fixture));
  if (state.undoStack.length > 100) state.undoStack.shift();
}

function cloneFixture(fixture: FixtureFile): FixtureFile {
  return JSON.parse(JSON.stringify(fixture)) as FixtureFile;
}

function hasOverrides(fixture: FixtureFile): boolean {
  return (
    (fixture.houses?.length ?? 0) +
      (fixture.bonusSquares?.length ?? 0) +
      (fixture.walls?.length ?? 0) >
    0
  );
}

function draw(state: EditorState): void {
  const frame = renderFrame(state);
  writeStdout(CURSOR_HOME + "\x1b[J" + frame);
}

function renderFrame(state: EditorState): string {
  const rowLabelW = String(GRID_ROWS - 1).length;
  const pad = " ".repeat(rowLabelW);
  const cols = GRID_COLS;
  const tensHeader = `${pad}  ${buildTensHeader(cols)}`;
  const onesHeader = `${pad}  ${buildOnesHeader(cols)}`;
  const border = `${pad} +${"-".repeat(cols)}+`;

  const lines: string[] = [];
  lines.push(headerLine(state));
  lines.push("");
  lines.push(tensHeader);
  lines.push(onesHeader);
  lines.push(border);
  for (let row = 0; row < GRID_ROWS; row++) {
    lines.push(
      `${String(row).padStart(rowLabelW, " ")} |${renderRow(state, row)}|`,
    );
  }
  lines.push(border);
  lines.push("");
  lines.push(statusLine(state));
  lines.push(tileInfoLine(state));
  lines.push(messageLine(state));
  lines.push(helpLine(state));
  return lines.join("\n");
}

function headerLine(state: EditorState): string {
  const dirty = state.dirty ? `${FG_YELLOW}*dirty*${RESET} ` : "";
  const modeTag =
    state.mode === "replay" ? `${BOLD}${FG_CYAN}[REPLAY]${RESET} ` : "";
  return `${BOLD}fixture editor${RESET}  ${modeTag}${dirty}${state.fixturePath}`;
}

function statusLine(state: EditorState): string {
  if (state.mode === "replay") return replayStatusLine(state);
  const ownerName = PLAYER_NAMES[state.owner] ?? `?${state.owner}`;
  const cursor = `cursor (${state.cursorRow},${state.cursorCol})`;
  const tool = `tool ${state.tool.toUpperCase()}`;
  const owner =
    state.tool === "wall"
      ? ` owner ${state.owner} (${OWNER_COLORS[state.owner] ?? ""}${ownerName}${RESET})`
      : "";
  const counts = summarizeOverrides(state.fixture);
  return `${cursor}   ${tool}${owner}   ${counts}`;
}

function replayStatusLine(state: EditorState): string {
  const sc = state.replayScenario;
  const cursor = `cursor (${state.cursorRow},${state.cursorCol})`;
  if (!sc) return `${cursor}   replay: (no scenario)`;
  const phase = sc.state.phase;
  const round = sc.state.round;
  const ticks = state.replayTicks ?? 0;
  const elapsedMs = Math.round(sc.now() - (state.replayStartTimeMs ?? 0));
  const simTime = (elapsedMs / 1000).toFixed(2);
  return `${cursor}   round ${round} phase ${phase}   tick ${ticks}   sim-time ${simTime}s`;
}

function tileInfoLine(state: EditorState): string {
  const row = state.cursorRow;
  const col = state.cursorCol;
  // In replay mode, inspect the LIVE replay state — overrides have already
  // been folded into the runtime, so the "fixture vs seed" distinction
  // doesn't apply (everything's just live state).
  const liveState =
    state.mode === "replay" && state.replayScenario
      ? state.replayScenario.state
      : state.baselineState;
  const inspection = inspectTile(liveState, row, col);
  const parts: string[] = [];
  parts.push(inspection.terrain);
  if (inspection.zone !== null && inspection.zone !== 0) {
    parts.push(`zone ${inspection.zone}`);
  }
  if (inspection.tower) {
    parts.push(inspection.tower.alive ? "tower" : "tower(dead)");
  }
  const liveHouse = liveState.map.houses.find(
    (house) => house.row === row && house.col === col,
  );
  if (liveHouse) {
    const label = state.mode === "replay" ? "house" : "seed-house";
    parts.push(liveHouse.alive ? label : `${label}(dead)`);
  }
  const liveBonus = liveState.bonusSquares.find(
    (bonus) => bonus.row === row && bonus.col === col,
  );
  if (liveBonus) parts.push(state.mode === "replay" ? "bonus" : "seed-bonus");
  if (inspection.wall) {
    const label = state.mode === "replay" ? "wall" : "seed-wall";
    parts.push(`${label}(${playerLabel(inspection.wall.playerId)})`);
  }
  if (inspection.cannon) {
    parts.push(
      `cannon(${playerLabel(inspection.cannon.playerId)},hp=${inspection.cannon.hp})`,
    );
  }
  if (inspection.grunt) {
    parts.push(`grunt(${playerLabel(inspection.grunt.playerId)})`);
  }
  if (inspection.burningPit) parts.push("burning-pit");
  if (inspection.interior.length > 0) {
    parts.push(`interior(${inspection.interior.map(playerLabel).join("/")})`);
  }

  // Fixture-override descriptors only meaningful in author mode — once the
  // replay runtime has consumed them, what's authored vs. seed-baked
  // collapses into "what's currently in the live state".
  if (state.mode === "author") {
    const fixtureHouse = (state.fixture.houses ?? []).find(
      (house) => house.row === row && house.col === col,
    );
    if (fixtureHouse) {
      parts.push(`${BOLD}${FG_MAGENTA}fixture-house${RESET}`);
    }
    const fixtureBonus = (state.fixture.bonusSquares ?? []).find(
      (bonus) => bonus.row === row && bonus.col === col,
    );
    if (fixtureBonus) parts.push(`${BOLD}${FG_MAGENTA}fixture-bonus${RESET}`);
    const fixtureWalls = (state.fixture.walls ?? []).filter(
      (wall) => wall.row === row && wall.col === col,
    );
    for (const wall of fixtureWalls) {
      const color = OWNER_COLORS[wall.ownerId] ?? "";
      parts.push(
        `${BOLD}${color}fixture-wall(${playerLabel(wall.ownerId)})${RESET}`,
      );
    }
  }

  return `tile (${row},${col}): ${parts.join(", ")}`;
}

function playerLabel(id: number): string {
  return PLAYER_NAMES[id] ?? `p${id}`;
}

function messageLine(state: EditorState): string {
  if (!state.message) return "";
  const color =
    state.messageKind === "error"
      ? FG_RED
      : state.messageKind === "ok"
        ? FG_GREEN
        : FG_CYAN;
  return `${color}${state.message}${RESET}`;
}

function helpLine(state: EditorState): string {
  if (state.mode === "replay") {
    return [
      "arrows: move cursor",
      "space: step 1 frame",
      "e: exit replay",
      "q: quit",
    ].join("  |  ");
  }
  return [
    "arrows: move",
    "h/b/w: tool",
    "space/enter: place",
    "x: remove",
    "0-2: owner",
    "u: undo",
    "s: save",
    "r: replay",
    "q: quit",
  ].join("  |  ");
}

function renderRow(state: EditorState, row: number): string {
  let out = "";
  for (let col = 0; col < GRID_COLS; col++) {
    out += renderCell(state, row, col);
  }
  return out;
}

function renderCell(state: EditorState, row: number, col: number): string {
  // Replay mode renders the live grid directly — overrides have already
  // been folded into the runtime, so there's no fixture-overlay to apply.
  if (state.mode === "replay" && state.replayCells) {
    const liveCell = state.replayCells[row]![col]!;
    const liveStyle = baseCellStyle(liveCell);
    if (row === state.cursorRow && col === state.cursorCol) {
      return `${INVERSE}${liveStyle}${liveCell.char}${RESET}`;
    }
    if (liveStyle) return `${liveStyle}${liveCell.char}${RESET}`;
    return liveCell.char;
  }

  const baseCell = state.baseline[row]![col]!;
  let char = baseCell.char;
  let style = baseCellStyle(baseCell);

  // Fixture overrides (bold + magenta for houses/bonuses, bold + owner color
  // for walls — visually distinct from seed-baked entities of the same kind).
  const fixtureHouse = (state.fixture.houses ?? []).find(
    (house) => house.row === row && house.col === col,
  );
  const fixtureBonus = (state.fixture.bonusSquares ?? []).find(
    (bonus) => bonus.row === row && bonus.col === col,
  );
  const fixtureWall = (state.fixture.walls ?? []).find(
    (wall) => wall.row === row && wall.col === col,
  );

  if (fixtureWall) {
    char = "#";
    style = `${BOLD}${OWNER_COLORS[fixtureWall.ownerId] ?? ""}`;
  } else if (fixtureHouse) {
    char = "H";
    style = `${BOLD}${FG_MAGENTA}`;
  } else if (fixtureBonus) {
    char = "+";
    style = `${BOLD}${FG_MAGENTA}`;
  }

  if (row === state.cursorRow && col === state.cursorCol) {
    return `${INVERSE}${style}${char}${RESET}`;
  }
  if (style) return `${style}${char}${RESET}`;
  return char;
}

/** ANSI style for a seed-baked cell. Mirrors the scheme used by
 *  `scripts/fixture-cli.ts show --color` so the TUI and the show command
 *  agree on what each tile looks like. */
function baseCellStyle(cell: Cell): string {
  switch (cell.kind) {
    case CellKind.Wall:
      return OWNER_COLORS[cell.playerId] ?? "";
    case CellKind.Interior:
      return `${DIM}${OWNER_COLORS[cell.playerId] ?? ""}`;
    case CellKind.House:
      return FG_YELLOW;
    case CellKind.BonusSquare:
      return FG_CYAN;
    case CellKind.TowerAlive:
      return FG_CYAN;
    case CellKind.TowerDead:
      return DIM;
    case CellKind.Cannon:
    case CellKind.Grunt:
      return OWNER_COLORS[cell.playerId] ?? "";
    case CellKind.Water:
    case CellKind.FrozenWater:
      return FG_BLUE;
    default:
      return "";
  }
}

function summarizeOverrides(fixture: FixtureFile): string {
  const parts: string[] = [];
  if (fixture.houses?.length) parts.push(`H:${fixture.houses.length}`);
  if (fixture.bonusSquares?.length) {
    parts.push(`B:${fixture.bonusSquares.length}`);
  }
  if (fixture.walls?.length) parts.push(`W:${fixture.walls.length}`);
  if (parts.length === 0) return "overrides: (none)";
  return `overrides: ${parts.join(" ")}`;
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

function collectTowerTileSet(
  towers: readonly { row: number; col: number }[],
): Set<number> {
  const set = new Set<number>();
  for (const tower of towers) {
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        set.add((tower.row + dr) * GRID_COLS + (tower.col + dc));
      }
    }
  }
  return set;
}

function parseFixtureArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture" && argv[i + 1]) return argv[i + 1]!;
  }
  console.error("usage: deno run -A scripts/fixture-tui.ts --fixture <path>");
  Deno.exit(2);
}

async function readFixture(path: string): Promise<FixtureFile> {
  const text = await Deno.readTextFile(path);
  // Treat the parsed JSON as a FixtureFile but ensure missing arrays are
  // undefined (the loader treats undefined and [] the same).
  return JSON.parse(text) as FixtureFile;
}

function writeStdout(text: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(text));
}
