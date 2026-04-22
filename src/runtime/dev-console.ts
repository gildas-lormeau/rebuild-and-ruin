import { isPerfHudEnabled, setPerfHudEnabled } from "../render/3d/perf-hud.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  buildGrid,
  buildLegend,
  type Cell,
  CellKind,
  DEFAULT_MAP_LAYER,
  type MapLayer,
  type Rect,
  zoneBounds,
} from "./dev-console-grid.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";
import type { TimingApi } from "./runtime-types.ts";

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
  fixedStep: (ms?: number | false) => void;
  pause: () => void;
  step: () => void;
  perfHud: (on?: boolean) => boolean;
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
 *  no stale snapshots are retained between invocations.
 *
 *  `timing` is passed so the `step()` command schedules its next-frame
 *  callback through the injected TimingApi instead of reaching for the
 *  global `requestAnimationFrame`. */
export function exposeDevConsole(
  runtimeState: RuntimeState,
  timing: TimingApi,
): void {
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

    map(layer: MapLayer = DEFAULT_MAP_LAYER) {
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
        layer = DEFAULT_MAP_LAYER,
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
        // Clamp to integer in [1, 16]. Slow-mo (< 1) is not supported —
        // use __dev.pause() to freeze. Cap at 16 because the speed-up
        // mechanism is sub-stepping (each real frame runs N normal-sized
        // game ticks instead of one inflated tick), so values > 16 just
        // burn CPU without producing perceptibly faster gameplay — the
        // browser still has to render each visible frame.
        const clamped = Math.min(16, Math.max(1, Math.floor(multiplier)));
        if (clamped !== multiplier) {
          console.log(`Speed clamped to ${clamped}× (range: 1..16, integer).`);
        }
        runtimeState.speedMultiplier = clamped;
        console.log(`Speed: ${clamped}×`);
      } else {
        console.log(`Speed: ${runtimeState.speedMultiplier}×`);
      }
      return runtimeState.speedMultiplier;
    },

    fixedStep(ms?: number | false) {
      if (ms === false) {
        runtimeState.fixedStepMs = undefined;
        console.log("Fixed step: off (variable rAF timing)");
      } else if (ms !== undefined) {
        runtimeState.fixedStepMs = ms;
        console.log(`Fixed step: ${ms}ms per frame`);
      } else {
        const current = runtimeState.fixedStepMs;
        console.log(
          current !== undefined
            ? `Fixed step: ${current}ms per frame`
            : "Fixed step: off (variable rAF timing)",
        );
      }
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
      timing.requestFrame(() => {
        runtimeState.paused = true;
      });
    },

    perfHud(on?: boolean): boolean {
      const next = on ?? !isPerfHudEnabled();
      setPerfHudEnabled(next);
      console.log(`Perf HUD ${next ? "on" : "off"} (3D renderer only)`);
      return next;
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
  __dev.speed(3)           3× speed (integer in 1..16)
  Note: speed-up runs the game-tick path N times per real frame with
  normal-sized dt — preserves determinism and collision boundaries.
  Slow-mo is not supported; use __dev.pause() to freeze.

%cFixed Step%c
  __dev.fixedStep()        Show current fixed-step state
  __dev.fixedStep(16)      Lock frame dt to 16ms (deterministic)
  __dev.fixedStep(false)   Disable (use variable rAF timing)
  Auto-enabled when a custom seed is set. Makes browser simulation
  match headless tests so seeds reproduce across environments.

%cPause%c
  __dev.pause()            Toggle pause
  __dev.step()             Advance one frame (while paused)

%cPerf HUD%c
  __dev.perfHud()          Toggle fixed-corner FPS + draw-call HUD
  __dev.perfHud(true)      Show  __dev.perfHud(false)  Hide
  3D renderer only. Reads three.js renderer.info counters per frame.

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
    HEADING_CSS,
    RESET_CSS,
    HEADING_CSS,
    RESET_CSS,
  );
}

function renderStyledGrid(
  grid: readonly Cell[][],
  crop: Rect,
  state: GameState,
): void {
  const { minRow, maxRow, minCol, maxCol } = crop;

  const { tens, units } = buildColHeaders(minCol, maxCol);
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
    case CellKind.FrozenWater:
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
    const { tens, units } = buildColHeaders(minCol, maxCol);
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

function buildColHeaders(
  minCol: number,
  maxCol: number,
): {
  tens: string;
  units: string;
} {
  const pad = "   ";
  let tens = pad;
  let units = pad;
  for (let col = minCol; col <= maxCol; col++) {
    tens += col >= 10 ? String(Math.floor(col / 10)) : " ";
    units += String(col % 10);
  }
  return { tens, units };
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
