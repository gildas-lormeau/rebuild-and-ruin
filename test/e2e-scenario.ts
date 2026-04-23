/**
 * Async E2E scenario — mirrors the headless `createScenario` shape for
 * browser-based tests.
 *
 * Provides the same mental model (bus events, state reads, input dispatch)
 * but async, since all access crosses the Playwright process boundary.
 *
 * Usage:
 *   import { createE2EScenario, E2ETest } from "./e2e-scenario.ts";
 *   const sc = await createE2EScenario({ seed: 42, headless: true });
 *   sc.bus.on("bannerStart", (ev) => console.log(ev.text));
 *   await sc.runGame();
 *   await sc.close();
 */

import { chromium, type CDPSession, type Page } from "playwright";
import { installFastMode } from "./e2e-fast-mode.ts";
import { waitForPageFn } from "./e2e-helpers.ts";
import type {
  E2EBridgeSnapshot,
  E2EBusEntry,
  E2EBusEntryOf,
  SerializedGameState,
} from "../src/runtime/runtime-e2e-bridge.ts";
import type {
  MapLayer,
  TileInspection,
} from "../src/runtime/dev-console-grid.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import type { Phase } from "../src/shared/core/game-phase.ts";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { TILE_SIZE } from "../src/shared/core/grid.ts";
import type { Mode } from "../src/shared/ui/ui-mode.ts";

// Re-export so tests can import GAME_EVENT from the same place.
export { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
export type {
  E2EBusEntry,
  E2EBusEntryOf,
  SerializedGameState,
} from "../src/runtime/runtime-e2e-bridge.ts";
export type {
  MapLayer,
  TileInspection,
} from "../src/runtime/dev-console-grid.ts";

/** Stringified `Mode` enum key (e.g. "LOBBY", "GAME", "STOPPED"). The bridge
 *  emits names rather than numeric values so E2E tests compare against string
 *  literals; "" before the first frame. */
export type E2EMode = keyof typeof Mode | "";

/** `Phase` enum (string-valued), or "" before state is ready. */
export type E2EPhase = Phase | "";

export interface E2EScenarioOptions {
  seed?: number;
  humans?: number;
  headless?: boolean;
  rounds?: number;
  /** Game mode. Matches the headless `ScenarioOptions.mode` shape. */
  mode?: "classic" | "modern";
  /** When false, the factory returns while the lobby is still up instead
   *  of waiting for the game to auto-start. Tests that exercise lobby
   *  input (slot clicks, key joins) use this to drive the UI before
   *  players are seated. Defaults to true. Mirrors the headless
   *  `ScenarioOptions.autoStartGame`. */
  autoStartGame?: boolean;
  /** Online mode. `"host"` creates a room and waits for peers.
   *  `"join"` joins an existing room via `roomCode`. Omit for local play. */
  online?: "host" | "join";
  /** Room code to join when `online: "join"`. */
  roomCode?: string;
  /** Emulate a touch device (mobile). Sets `isMobile: true`,
   *  `hasTouch: true`, a phone-sized viewport, and a mobile UA on the
   *  Playwright browser context. Flips `IS_TOUCH_DEVICE` inside the
   *  runtime so `setupTouchControls` (and its `camera.enableMobileZoom`
   *  call) fires naturally — no bridge back-door. Use for tests that
   *  exercise mobile-only code paths (touch loupe, auto-zoom, ✕ quit
   *  button). Defaults to false. */
  mobile?: boolean;
  /** Replace `requestAnimationFrame` with a 100×-speed fake-clock
   *  loop (see `installFastMode`). Defaults to true so normal E2E
   *  tests run in seconds. Disable for perf tests — fake-clock
   *  timings are meaningless to DevTools, and the whole point of a
   *  CPU profile / Chrome trace is real wall-clock frame cost. */
  fastMode?: boolean;
}

/** Event type — GAME_EVENT constants (string literal keys of GameEventMap). */
type E2EEventType = keyof GameEventMap;

/** Shared opts shape for `runUntil` / `runGame` / `waitFor*`. Units are
 *  wall-clock milliseconds (Playwright's poll loop is real-time).
 *  Matches the headless `RunOpts` shape so agents don't mix up units —
 *  the only difference is clock type (wall-clock here, mock clock on
 *  headless). */
export interface E2ERunOpts {
  /** Wall-clock budget in milliseconds. Defaults to 120_000 for
   *  `runGame`, 30_000 for `waitFor*`, 30_000 for `runUntil`. */
  timeoutMs?: number;
}

/** Typed handler for a specific event type. Receives the busLog entry with
 *  the event's full payload fields + bridge metadata. */
export type E2EBusHandler<K extends E2EEventType> = (
  event: E2EBusEntryOf<K>,
) => void;

/** Catch-all handler. Receives the event type string and the entry. */
type E2EAnyHandler = (type: E2EEventType, event: E2EBusEntry) => void;

export interface E2EScenario extends AsyncDisposable {
  /** Escape hatch for custom page.evaluate calls. */
  readonly page: Page;
  /** Read the current bridge snapshot (UI-facing summary — mode, phase,
   *  overlay, controller). For the full game state (players, grunts,
   *  cannonballs, …), use `gameState()`. */
  state(): Promise<E2EBridgeSnapshot>;
  /** Read the current `GameState` as a JSON-safe snapshot. Mirrors the
   *  headless `sc.state` field: same field names, same structure, but
   *  `Set`s are arrays, `Map`s are entry-tuple arrays, and the transient
   *  `bus` / `rng` services are dropped. Returns `null` before the state
   *  is ready (e.g. while the lobby is still up). */
  gameState(): Promise<SerializedGameState | null>;
  /** Text-grid snapshot of the map — same format as the headless
   *  `AsciiRenderer.snapshot()`. Produced on demand from the live
   *  `GameState`. Returns null before the state is ready. `layer`
   *  defaults to "all". Useful for inspection in failing-test logs:
   *
   *      console.log(await sc.asciiSnapshot());
   *
   *  Coordinate margins default ON (set `coords: false` to match the
   *  headless format). Accepts a bare `MapLayer` for back-compat. */
  asciiSnapshot(
    opts?: MapLayer | { layer?: MapLayer; coords?: boolean },
  ): Promise<string | null>;
  /** Structured read of a single tile — mirrors the headless
   *  `Scenario.tileAt(row, col)`. Returns null before state is ready. */
  tileAt(row: number, col: number): Promise<TileInspection | null>;
  /** Current UI mode (LOBBY, GAME, STOPPED, …) — stringified `Mode` enum key. */
  mode(): Promise<E2EMode>;
  /** Current game phase — `Phase` enum (string-valued), or "" before ready. */
  phase(): Promise<E2EPhase>;
  /** Whether the lobby UI is currently active. */
  lobbyActive(): Promise<boolean>;
  /** Read current camera state across the Playwright boundary. Mirrors
   *  the headless `Scenario.camera` accessor. The `enableMobileZoom`
   *  method flips the camera's `mobileZoomEnabled` flag so tests can
   *  simulate touch-device setup without wiring a real touch UI. */
  camera: {
    state(): Promise<{
      cameraZone: number | undefined;
      pitch: number;
      pitchState: "flat" | "tilting" | "tilted" | "untilting";
      hasViewport: boolean;
      autoZoomOn: boolean;
    }>;
    enableMobileZoom(): Promise<void>;
  };
  /** Game bus — mirrors the headless GameEventBus shape. Handlers fire
   *  during `runUntil` / `runGame` as new events appear in busLog. */
  bus: {
    /** Subscribe to a specific event type. The handler receives the full
     *  typed payload (same shape as the headless `GameEventBus`) plus the
     *  bridge's recording metadata (`_seq`, `capture`, …). */
    on<K extends E2EEventType>(eventType: K, handler: E2EBusHandler<K>): void;
    /** Unsubscribe from a specific event type. */
    off<K extends E2EEventType>(eventType: K, handler: E2EBusHandler<K>): void;
    /** Subscribe to ALL events. */
    onAny(handler: E2EAnyHandler): void;
    /** Unsubscribe a catch-all handler. */
    offAny(handler: E2EAnyHandler): void;
    /** Read the full event log, or filter by type. The filtered overload
     *  returns the entries narrowed to that event type's payload. */
    events(): Promise<E2EBusEntry[]>;
    events<K extends E2EEventType>(eventType: K): Promise<E2EBusEntryOf<K>[]>;
  };
  /** Drive the game until a predicate returns true. The predicate
   *  receives the scenario itself — use `await sc.phase()`, `await sc.state()`,
   *  etc. Bus handlers fire for each new event during the wait.
   *
   *  Throws `E2ETimeoutError` if the predicate never fires within
   *  `timeoutMs` (default 120_000). The headless equivalent returns -1
   *  on timeout; E2E throws because the alternative (silent success) has
   *  bitten tests in the past. */
  runUntil(
    predicate: (sc: E2EScenario) => Promise<boolean> | boolean,
    opts?: E2ERunOpts,
  ): Promise<void>;
  /** Wait until the game reaches STOPPED mode. Throws on timeout.
   *  Bus handlers fire for each new event during the wait. */
  runGame(opts?: E2ERunOpts): Promise<void>;
  /** Register a capture filter: every bus event of `type` matching
   *  `predicate` will carry a PNG of the canvas, captured synchronously
   *  in-browser at the event's emit moment, as `entry.capture` on its
   *  busLog record.
   *
   *  `predicate` runs in-browser (stringified + re-constructed via
   *  `new Function`); it may only reference the event payload, not
   *  closures from the Deno-side test. Omit to match every event of
   *  the given type.
   *
   *  Fires for every matching event — this is listener-style. Tests
   *  read captured PNGs by walking the busLog (`await sc.bus.events()`)
   *  after running, or via `sc.bus.on(type, (ev) => ev.capture)`. */
  captureOn<K extends keyof GameEventMap>(
    type: K,
    predicate?: (ev: GameEventMap[K]) => boolean,
  ): Promise<void>;
  /** Input helpers. The `*Tile(row, col)` variants are preferred — they
   *  work the same on headless and E2E. The raw pixel variants take
   *  world-space coords (converted to client coords via the bridge). */
  input: {
    mouseMove(wx: number, wy: number): Promise<void>;
    click(wx: number, wy: number): Promise<void>;
    rightClick(wx: number, wy: number): Promise<void>;
    /** Press + release a key in one call. */
    pressKey(key: string): Promise<void>;
    /** Press a key (no release). Pair with `keyUp` for held-key tests. */
    keyDown(key: string): Promise<void>;
    /** Release a previously-pressed key. */
    keyUp(key: string): Promise<void>;
    tap(wx: number, wy: number): Promise<void>;
    /** Dispatch a `touchstart` event at the given world-space points.
     *  Each touch gets a sequential identifier; keep that order for
     *  matching `touchMove` / `touchEnd` calls. */
    touchStart(touches: readonly { wx: number; wy: number }[]): Promise<void>;
    /** Dispatch a `touchmove` event with the current touch positions. */
    touchMove(touches: readonly { wx: number; wy: number }[]): Promise<void>;
    /** Dispatch a `touchend`. `touches` is the set of fingers still on
     *  screen; `changedTouches` is the fingers being lifted. */
    touchEnd(
      touches?: readonly { wx: number; wy: number }[],
      changedTouches?: readonly { wx: number; wy: number }[],
    ): Promise<void>;
    /** Move the mouse to the centre of a game tile. Stable across
     *  camera/letterbox — same call signature as headless. */
    hoverTile(row: number, col: number): Promise<void>;
    /** Left-click at the centre of a tile. */
    clickTile(row: number, col: number): Promise<void>;
    /** Single-finger tap at the centre of a tile. */
    tapTile(row: number, col: number): Promise<void>;
  };
  /** Room code (only available when `online: "host"`). */
  roomCode(): Promise<string>;
  /** Chrome DevTools performance reporting. Each artifact is written
   *  straight to disk in a DevTools-compatible format, so tests can
   *  drop the file into Chrome DevTools (or chrome://tracing /
   *  Perfetto for traces) and get the native flame graph, bottom-up,
   *  event table, etc.
   *
   *  - `startTrace` / `stopTrace` — Chrome trace (Performance panel)
   *  - `startCpuProfile` / `stopCpuProfile` — V8 sampled profile
   *  - `heapSnapshot` — Memory panel snapshot
   *  - `metrics` — raw CDP `Performance.getMetrics` counters
   *
   *  The CDP session attaches lazily on first use — tests that never
   *  touch `perf` pay nothing. `close()` detaches automatically. */
  perf: E2EPerf;
  /** Close the browser. */
  close(): Promise<void>;
}

/** Chrome-driven perf reporting surface. See `E2EScenario.perf`. */
export interface E2EPerf {
  /** Start a Chrome trace. Categories default to the DevTools
   *  Performance-panel preset (timeline, v8, blink, devtools.timeline,
   *  screenshots if enabled). The resulting file opens in Chrome
   *  DevTools (Performance panel → Load profile), chrome://tracing,
   *  or Perfetto. Calling `startTrace` while one is already running
   *  throws. */
  startTrace(opts?: {
    /** Trace categories. Defaults to the DevTools preset — a good
     *  baseline for frame-level attribution (includes v8 sampling,
     *  paint, layout, GC, compositor). Pass your own array to scope
     *  the trace (e.g. just `["v8"]` for JS-only, or add
     *  `"disabled-by-default-cpu_profiler"` for per-function samples). */
    categories?: readonly string[];
    /** Include screenshots in the trace (handy for correlating jank
     *  with rendered frames in DevTools). Defaults to false because
     *  screenshots bloat the trace file 10-100x. */
    screenshots?: boolean;
  }): Promise<void>;
  /** Stop the trace and write it to `path` as a DevTools-compatible
   *  JSON file. `path` is resolved via Deno's CWD. */
  stopTrace(path: string): Promise<void>;
  /** Start a V8 CPU profile. Higher sample rates catch more short
   *  frames but grow the file. Default 1000us (1kHz) matches DevTools. */
  startCpuProfile(opts?: { samplingIntervalUs?: number }): Promise<void>;
  /** Stop the CPU profile and write it to `path` as a `.cpuprofile`
   *  file (DevTools Performance panel → Load profile). */
  stopCpuProfile(path: string): Promise<void>;
  /** Take a heap snapshot and write it to `path` as a
   *  `.heapsnapshot` file (DevTools Memory panel → Load). Blocks the
   *  page while capturing. */
  heapSnapshot(path: string): Promise<void>;
  /** Raw CDP performance counters — JS heap size, documents, nodes,
   *  layout count, recalc-style count, task duration, etc. Cheap to
   *  call; use between phases to catch runaway growth. */
  metrics(): Promise<PerfMetrics>;
  /** Dump recorded game-bus events to NDJSON so a perf spike (CPU
   *  peak at t=42s) can be correlated with a game moment (e.g.
   *  `towerEnclosed` fired at t=42.03s). One JSON object per line;
   *  the first line is a meta object carrying the origin timestamp
   *  and the event-type histogram. Subsequent lines carry one event
   *  each, including a `tMs` field (ms since the first recorded
   *  event) for easy filtering.
   *
   *  The file is written synchronously from the current busLog — call
   *  after `runGame` to capture the whole run. */
  writeEventLog(path: string, opts?: EventLogOpts): Promise<void>;
}

/** Options for `sc.perf.writeEventLog`. */
export interface EventLogOpts {
  /** Whitelist of event types to keep. Pass a list of `GAME_EVENT.*`
   *  string values (e.g. `["phaseStart", "modifierApplied"]`) to emit
   *  only those. Mutually exclusive with `exclude`; if both are
   *  given, `include` wins. */
  include?: readonly string[];
  /** Event types to drop. Defaults to high-volume per-frame events
   *  (`tick`) so the file stays readable. Pass `[]` to keep everything. */
  exclude?: readonly string[];
}

/** Parsed form of `Performance.getMetrics`. Only the most useful
 *  counters are spelled out; the rest are in `raw`. Values are the
 *  raw CDP numbers (no unit conversion) — timings are seconds,
 *  memory is bytes, counts are counts. */
export interface PerfMetrics {
  /** `performance.now()` — monotonic clock in the renderer. */
  timestamp: number;
  /** Used JS heap in bytes (`JSHeapUsedSize`). */
  jsHeapUsedBytes: number;
  /** Total JS heap in bytes (`JSHeapTotalSize`). */
  jsHeapTotalBytes: number;
  /** Live DOM node count. */
  nodes: number;
  /** Layouts triggered since page load. */
  layoutCount: number;
  /** Style recalcs triggered since page load. */
  recalcStyleCount: number;
  /** Total task duration (s) — wall-clock time the renderer was busy. */
  taskDuration: number;
  /** All counters, keyed by name, exactly as CDP returned them. */
  raw: Record<string, number>;
}

const BASE_URL = "http://localhost:5173";
/** Polling interval (ms) for draining busLog during runUntil/runGame. */
const POLL_MS = 50;
/** Default budget for wait helpers (30s wall-clock). Shorter than
 *  `runGame`'s 120s because wait helpers target a single event, not the
 *  whole game. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Timeout for online lobby page readiness + transition off after create/join. */
const ONLINE_PAGE_TIMEOUT_MS = 10_000;
/** DevTools Performance-panel tracing preset. Mirrors the categories
 *  Chrome's own Recording button enables, so the resulting trace has
 *  everything the flame-graph / main-thread / GC-pressure views need.
 *  Overridable via `startTrace({ categories })` for scoped captures. */
const DEVTOOLS_TRACE_CATEGORIES: readonly string[] = [
  "-*",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "v8",
  "v8.execute",
  "blink.user_timing",
  "blink.console",
  "loading",
  "latencyInfo",
  "toplevel",
  "disabled-by-default-lighthouse",
];
/** Screenshot category added on top of the preset when
 *  `startTrace({ screenshots: true })`. */
const DEVTOOLS_SCREENSHOT_CATEGORY = "disabled-by-default-devtools.screenshot";
/** Default `writeEventLog` exclude list. `tick` fires every sim
 *  sub-step so it drowns out everything else in the NDJSON; other
 *  high-volume events can be added here if they become noisy. */
const DEFAULT_EVENT_LOG_EXCLUDE: readonly string[] = ["tick"];

/** Thrown by `runUntil` / `runGame` / `waitFor*` when the predicate / target
 *  state doesn't materialize within the budget. Carries `elapsedMs` so tests
 *  can assert on timing too. */
export class E2ETimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(message: string, elapsedMs: number) {
    super(`${message} (waited ${elapsedMs}ms)`);
    this.name = "E2ETimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

export async function createE2EScenario(
  opts: E2EScenarioOptions = {},
): Promise<E2EScenario> {
  const {
    seed,
    humans = 1,
    headless = true,
    rounds = 3,
    mode,
    autoStartGame = true,
    online,
    roomCode: joinCode,
    mobile = false,
    fastMode = true,
  } = opts;

  const browser = await chromium.launch({ headless });
  // Mobile emulation: Playwright's `isMobile: true` + `hasTouch: true`
  // are what the runtime's `IS_TOUCH_DEVICE` detection keys on, so the
  // touch controls wire up (and `camera.enableMobileZoom` fires from
  // `setupTouchControls`) just like on a phone. Use a Pixel-5-ish
  // portrait viewport + UA; any modern phone profile works as long
  // as the touch flags are set.
  const ctx = mobile
    ? await browser.newContext({
        viewport: { width: 393, height: 851 },
        userAgent:
          "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        deviceScaleFactor: 2.75,
        isMobile: true,
        hasTouch: true,
      })
    : await browser.newContext();
  const page = await ctx.newPage();

  // Navigate
  const modeParam = mode ? `&mode=${mode}` : "";
  await page.goto(`${BASE_URL}?rounds=${rounds}${modeParam}`);

  // Set seed via localStorage
  if (seed !== undefined) {
    await page.evaluate((sd: string) => {
      const settings = JSON.parse(
        localStorage.getItem("castles99_settings") || "{}",
      );
      settings.seedMode = "custom";
      settings.seed = sd;
      localStorage.setItem("castles99_settings", JSON.stringify(settings));
    }, String(seed));
  }

  // --- Launch flow: local / host / join ---
  let extractedRoomCode: string | undefined;

  if (online === "host") {
    // Create an online room.
    await page.click("#btn-online");
    await page.waitForSelector("#page-online[data-ready]", { timeout: ONLINE_PAGE_TIMEOUT_MS });
    await page.selectOption("#create-wait", "10");
    await page.selectOption("#create-rounds", String(rounds));
    await page.click("#btn-create-confirm");
    await waitForPageFn(
      page,
      () => document.getElementById("page-online")?.hidden === true,
      ONLINE_PAGE_TIMEOUT_MS,
    );
    await page.waitForTimeout(300);
    extractedRoomCode = await page.evaluate(() => {
      const el = document.getElementById("room-code-overlay");
      return el?.innerText?.trim()?.match(/[A-Z]{4}/)?.[0] ?? "";
    });
    if (extractedRoomCode.length !== 4) {
      throw new Error(`Failed to extract room code: "${extractedRoomCode}"`);
    }
  } else if (online === "join") {
    if (!joinCode) throw new Error("online: 'join' requires roomCode");
    await page.click("#btn-online");
    await page.waitForSelector("#page-online[data-ready]", { timeout: ONLINE_PAGE_TIMEOUT_MS });
    await page.fill("#join-code", joinCode);
    await page.click("#btn-join-confirm");
    await waitForPageFn(
      page,
      () => document.getElementById("page-online")?.hidden === true,
      ONLINE_PAGE_TIMEOUT_MS,
    );
  } else {
    // Local game.
    await page.click("#btn-local");
    await page.waitForSelector("#game-container.active", { timeout: 5000 });
  }

  if (fastMode) await installFastMode(page);

  // Join human slots (local only — online lobby handles slots differently).
  // Skipped when autoStartGame is false so tests can drive the lobby UI
  // from scratch.
  if (!online && autoStartGame) {
    const slotKeys = ["n", "f", "h"];
    for (let idx = 0; idx < humans; idx++) {
      await page.keyboard.press(slotKeys[idx]!);
    }
  }

  // Wait for game to start (skip for online — lobby exit happens during
  // runGame/runUntil so both host and client can join before the timer expires).
  // Also skip when autoStartGame=false so tests can drive the lobby themselves.
  if (!online && autoStartGame) {
    await waitForPageFn(
      page,
      () => {
        const win = globalThis as unknown as Record<string, unknown>;
        const e2e = win.__e2e as { mode?: string } | undefined;
        return (
          e2e?.mode !== undefined && e2e.mode !== "" && e2e.mode !== "LOBBY"
        );
      },
      90_000,
    );
  }

  // --- Bus handler state ---
  // The internal storage type is existential over K — each set holds handlers
  // for one event type, and the generic `bus.on<K>` API casts at the boundary.
  type InternalHandler = (event: E2EBusEntry) => void;
  const typedHandlers = new Map<E2EEventType, Set<InternalHandler>>();
  const anyHandlers = new Set<E2EAnyHandler>();
  let lastSeenSeq = 0;

  /** Fetch new busLog entries since lastSeenSeq and fire handlers.
   *  Strips the `capture` PNG payload from entries to avoid transferring
   *  megabytes of data across the Playwright IPC boundary for handlers
   *  that don't need pixels. Use `sc.bus.events()` to read entries with
   *  captures intact. */
  async function drainBus(): Promise<void> {
    const newEntries: E2EBusEntry[] = await page.evaluate(
      (fromSeq: number) => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { busLog?: E2EBusEntry[] } | undefined;
        const log = e2e?.busLog;
        if (!log || log.length <= fromSeq) return [];
        return log.slice(fromSeq).map((entry) => {
          if (!entry.capture) return entry;
          const { capture: _c, ...rest } = entry;
          return rest as typeof entry;
        });
      },
      lastSeenSeq,
    );

    for (const entry of newEntries) {
      lastSeenSeq = entry._seq + 1;
      // Fire typed handlers.
      const handlers = typedHandlers.get(entry.type as E2EEventType);
      if (handlers) {
        for (const handler of handlers) handler(entry);
      }
      // Fire catch-all handlers.
      for (const handler of anyHandlers) {
        handler(entry.type as E2EEventType, entry);
      }
    }
  }

  /** Polling loop: drain bus + check predicate until done or timeout.
   *  Returns true on predicate success, false on timeout. Callers decide
   *  whether to throw — `runUntil` / `runGame` / `waitFor*` all throw. */
  async function pollUntil(
    checkDone: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; elapsedMs: number }> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      await drainBus();
      if (await checkDone()) {
        // One final drain to catch events emitted on the same frame.
        await drainBus();
        return { ok: true };
      }
      await page.waitForTimeout(POLL_MS);
    }
    // Final drain even on timeout.
    await drainBus();
    return { ok: false, elapsedMs: Date.now() - start };
  }

  // --- Coord conversion helper ---
  async function worldToClient(
    wx: number,
    wy: number,
  ): Promise<{ cx: number; cy: number }> {
    return await page.evaluate(
      ([worldX, worldY]: [number, number]) => {
        const win = globalThis as unknown as Record<string, unknown>;
        const e2e = win.__e2e as {
          worldToClient?: (
            wx: number,
            wy: number,
          ) => { cx: number; cy: number };
        } | undefined;
        if (e2e?.worldToClient) return e2e.worldToClient(worldX, worldY);
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width / canvas.width;
        const scaleY = rect.height / canvas.height;
        return {
          cx: rect.left + worldX * 2 * scaleX,
          cy: rect.top + worldY * 2 * scaleY,
        };
      },
      [wx, wy] as [number, number],
    );
  }

  /** Dispatch a multi-touch `TouchEvent` at the canvas. World-space points
   *  are converted to client coords before crossing the Playwright IPC
   *  boundary. Playwright's `touchscreen.tap` is single-finger only, so
   *  multi-touch flows need a hand-dispatched event. */
  async function dispatchTouch(
    type: "touchstart" | "touchmove" | "touchend",
    touches: readonly { wx: number; wy: number }[],
    changedTouches?: readonly { wx: number; wy: number }[],
  ): Promise<void> {
    const touchClient = await Promise.all(
      touches.map((t) => worldToClient(t.wx, t.wy)),
    );
    const changedClient = changedTouches
      ? await Promise.all(
          changedTouches.map((t) => worldToClient(t.wx, t.wy)),
        )
      : touchClient;
    await page.evaluate(
      ({
        eventType,
        touchPoints,
        changedPoints,
      }: {
        eventType: "touchstart" | "touchmove" | "touchend";
        touchPoints: { cx: number; cy: number }[];
        changedPoints: { cx: number; cy: number }[];
      }) => {
        const canvas = document.getElementById(
          "canvas",
        ) as HTMLCanvasElement | null;
        if (!canvas) throw new Error("canvas element not found");
        const mkList = (points: { cx: number; cy: number }[]): Touch[] =>
          points.map(
            (p, index) =>
              new Touch({
                identifier: index,
                clientX: p.cx,
                clientY: p.cy,
                target: canvas,
              }),
          );
        canvas.dispatchEvent(
          new TouchEvent(eventType, {
            bubbles: true,
            cancelable: true,
            touches: mkList(touchPoints),
            targetTouches: mkList(touchPoints),
            changedTouches: mkList(changedPoints),
          }),
        );
      },
      {
        eventType: type,
        touchPoints: touchClient,
        changedPoints: changedClient,
      },
    );
  }

  // --- CDP perf session (lazy) ---
  // A single CDP session is shared by all `sc.perf.*` calls. Attached
  // on first use so tests that never touch perf pay nothing, and
  // detached by `close()` / async-dispose so we don't leak across
  // browser shutdown.
  let cdp: CDPSession | null = null;
  let traceBuffer: {
    events: unknown[];
    onData: (ev: { value: unknown[] }) => void;
  } | null = null;
  let cpuProfiling = false;

  async function getCdp(): Promise<CDPSession> {
    if (cdp) return cdp;
    cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    return cdp;
  }

  const perf: E2EPerf = {
    startTrace: async (traceOpts = {}) => {
      if (traceBuffer) {
        throw new Error("perf.startTrace: trace already running");
      }
      const session = await getCdp();
      const cats = [...(traceOpts.categories ?? DEVTOOLS_TRACE_CATEGORIES)];
      if (traceOpts.screenshots) cats.push(DEVTOOLS_SCREENSHOT_CATEGORY);
      // Attach the dataCollected listener BEFORE `Tracing.start`:
      // Chrome flushes the trace buffer mid-recording once it fills,
      // not only on `Tracing.end`, so late-attaching would silently
      // drop events on long traces.
      const events: unknown[] = [];
      const onData = (ev: { value: unknown[] }) => {
        for (const entry of ev.value) events.push(entry);
      };
      session.on("Tracing.dataCollected", onData);
      await session.send("Tracing.start", {
        transferMode: "ReportEvents",
        categories: cats.join(","),
      });
      traceBuffer = { events, onData };
    },

    stopTrace: async (path) => {
      if (!traceBuffer) throw new Error("perf.stopTrace: no trace running");
      const session = cdp!;
      const buffer = traceBuffer;
      const done = new Promise<void>((resolve) => {
        session.once("Tracing.tracingComplete", () => resolve());
      });
      await session.send("Tracing.end");
      await done;
      session.off("Tracing.dataCollected", buffer.onData);
      traceBuffer = null;
      // Chrome's trace format is `{ "traceEvents": [...] }` — the
      // object form DevTools' Performance panel loads. The bare-array
      // form also works for chrome://tracing but is less portable.
      await Deno.writeTextFile(
        path,
        JSON.stringify({ traceEvents: buffer.events }),
      );
    },

    startCpuProfile: async (cpuOpts = {}) => {
      if (cpuProfiling) {
        throw new Error("perf.startCpuProfile: profile already running");
      }
      const session = await getCdp();
      await session.send("Profiler.enable");
      if (cpuOpts.samplingIntervalUs !== undefined) {
        await session.send("Profiler.setSamplingInterval", {
          interval: cpuOpts.samplingIntervalUs,
        });
      }
      await session.send("Profiler.start");
      cpuProfiling = true;
    },

    stopCpuProfile: async (path) => {
      if (!cpuProfiling) {
        throw new Error("perf.stopCpuProfile: no profile running");
      }
      const session = cdp!;
      const result = await session.send("Profiler.stop");
      cpuProfiling = false;
      // `result.profile` is already in `.cpuprofile` shape — nodes,
      // samples, timeDeltas — exactly what DevTools expects.
      await Deno.writeTextFile(path, JSON.stringify(result.profile));
    },

    heapSnapshot: async (path) => {
      const session = await getCdp();
      const chunks: string[] = [];
      const onChunk = (ev: { chunk: string }) => {
        chunks.push(ev.chunk);
      };
      session.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
      try {
        await session.send("HeapProfiler.takeHeapSnapshot", {
          reportProgress: false,
          captureNumericValue: false,
        });
      } finally {
        session.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      }
      // Chunks are pre-serialized JSON fragments — concat, don't JSON.stringify.
      await Deno.writeTextFile(path, chunks.join(""));
    },

    metrics: async () => {
      const session = await getCdp();
      const result = await session.send("Performance.getMetrics");
      const raw: Record<string, number> = {};
      for (const { name, value } of result.metrics) raw[name] = value;
      return {
        timestamp: raw.Timestamp ?? 0,
        jsHeapUsedBytes: raw.JSHeapUsedSize ?? 0,
        jsHeapTotalBytes: raw.JSHeapTotalSize ?? 0,
        nodes: raw.Nodes ?? 0,
        layoutCount: raw.LayoutCount ?? 0,
        recalcStyleCount: raw.RecalcStyleCount ?? 0,
        taskDuration: raw.TaskDuration ?? 0,
        raw,
      };
    },

    writeEventLog: async (path, eventOpts = {}) => {
      // Pull the raw busLog (minus PNG captures, which would bloat
      // the file and aren't useful for timing correlation).
      const entries: E2EBusEntry[] = await page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { busLog?: E2EBusEntry[] } | undefined;
        const log = e2e?.busLog ?? [];
        return log.map((entry) => {
          if (!entry.capture) return entry;
          const { capture: _c, ...rest } = entry;
          return rest as typeof entry;
        });
      });

      const includeSet = eventOpts.include
        ? new Set(eventOpts.include)
        : null;
      const excludeSet = new Set(
        eventOpts.exclude ?? DEFAULT_EVENT_LOG_EXCLUDE,
      );
      const kept = entries.filter((entry) => {
        if (includeSet) return includeSet.has(entry.type);
        return !excludeSet.has(entry.type);
      });

      const originMs = kept.length > 0 ? kept[0]._tMs : 0;
      const typeCounts: Record<string, number> = {};
      for (const entry of kept) {
        typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
      }

      // NDJSON: one JSON object per line. The first line is a meta
      // record carrying the origin timestamp so downstream analyzers
      // can reconstruct absolute `performance.now()` values if
      // needed. Event lines carry `tMs = entry._tMs - originMs`
      // (relative to first event) as the primary timestamp, alongside
      // `tAbsMs` (absolute performance.now()) for cross-file alignment.
      const lines: string[] = [];
      lines.push(
        JSON.stringify({
          _meta: true,
          originMs,
          totalEvents: entries.length,
          keptEvents: kept.length,
          droppedTypes: [...excludeSet].filter(
            (type) => !includeSet || !includeSet.has(type),
          ),
          typeCounts,
        }),
      );
      for (const entry of kept) {
        const { _tMs, _seq, capture: _c, ...payload } = entry;
        lines.push(
          JSON.stringify({
            tMs: +(entry._tMs - originMs).toFixed(3),
            tAbsMs: entry._tMs,
            seq: _seq,
            ...payload,
          }),
        );
      }
      await Deno.writeTextFile(path, lines.join("\n") + "\n");
    },
  };

  async function teardown(): Promise<void> {
    if (cdp) {
      if (traceBuffer) {
        await cdp.send("Tracing.end").catch(() => {});
        cdp.off("Tracing.dataCollected", traceBuffer.onData);
        traceBuffer = null;
      }
      if (cpuProfiling) {
        await cdp.send("Profiler.stop").catch(() => {});
        cpuProfiling = false;
      }
      await cdp.detach().catch(() => {});
      cdp = null;
    }
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // --- Build scenario object ---
  const scenario: E2EScenario = {
    page,

    state: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as Record<string, unknown> | undefined;
        if (!e2e) throw new Error("__e2e bridge not available");
        return JSON.parse(
          JSON.stringify(e2e, (_k, vi) => {
            if (typeof vi === "function") return undefined;
            return vi;
          }),
        );
      }),

    gameState: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as
          | { gameState?: () => SerializedGameState | null }
          | undefined;
        if (!e2e) throw new Error("__e2e bridge not available");
        return e2e.gameState?.() ?? null;
      }) as Promise<SerializedGameState | null>,

    asciiSnapshot: (opts) =>
      page.evaluate(
        (arg: MapLayer | { layer?: MapLayer; coords?: boolean } | undefined) => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as
            | {
                asciiSnapshot?: (
                  opts?:
                    | MapLayer
                    | { layer?: MapLayer; coords?: boolean },
                ) => string | null;
              }
            | undefined;
          if (!e2e) throw new Error("__e2e bridge not available");
          return e2e.asciiSnapshot?.(arg) ?? null;
        },
        opts,
      ),

    tileAt: (row, col) =>
      page.evaluate(
        ([r, c]: [number, number]) => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as
            | { tileAt?: (row: number, col: number) => TileInspection | null }
            | undefined;
          if (!e2e) throw new Error("__e2e bridge not available");
          return e2e.tileAt?.(r, c) ?? null;
        },
        [row, col] as [number, number],
      ) as Promise<TileInspection | null>,

    mode: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { mode?: string } | undefined;
        return (e2e?.mode ?? "") as E2EMode;
      }),

    phase: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { phase?: string } | undefined;
        return (e2e?.phase ?? "") as E2EPhase;
      }),

    lobbyActive: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { lobbyActive?: boolean } | undefined;
        return e2e?.lobbyActive ?? false;
      }),

    camera: {
      state: () =>
        page.evaluate(() => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as
            | {
                camera?: {
                  cameraZone: number | undefined;
                  pitch: number;
                  pitchState: "flat" | "tilting" | "tilted" | "untilting";
                  hasViewport: boolean;
                  autoZoomOn: boolean;
                };
              }
            | undefined;
          return (
            e2e?.camera ?? {
              cameraZone: undefined as number | undefined,
              pitch: 0,
              pitchState: "flat" as const,
              hasViewport: false,
              autoZoomOn: false,
            }
          );
        }),
      enableMobileZoom: async () => {
        await page.evaluate(() => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as { enableMobileZoom?: () => void } | undefined;
          e2e?.enableMobileZoom?.();
        });
      },
    },

    bus: {
      on<K extends E2EEventType>(
        eventType: K,
        handler: E2EBusHandler<K>,
      ): void {
        let set = typedHandlers.get(eventType);
        if (!set) {
          set = new Set();
          typedHandlers.set(eventType, set);
        }
        set.add(handler as unknown as InternalHandler);
      },
      off<K extends E2EEventType>(
        eventType: K,
        handler: E2EBusHandler<K>,
      ): void {
        typedHandlers.get(eventType)?.delete(handler as unknown as InternalHandler);
      },
      onAny(handler: E2EAnyHandler): void {
        anyHandlers.add(handler);
      },
      offAny(handler: E2EAnyHandler): void {
        anyHandlers.delete(handler);
      },
      events: (<K extends E2EEventType>(
        eventType?: K,
      ): Promise<E2EBusEntry[] | E2EBusEntryOf<K>[]> =>
        page.evaluate((filterType?: string) => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as { busLog?: unknown[] } | undefined;
          const log = (e2e?.busLog ?? []) as E2EBusEntry[];
          if (!filterType) return log;
          return log.filter((entry) => entry.type === filterType);
        }, eventType)) as E2EScenario["bus"]["events"],
    },

    runUntil: async (predicate, opts2) => {
      const result = await pollUntil(
        async () => Boolean(await predicate(scenario)),
        opts2?.timeoutMs ?? 120_000,
      );
      if (!result.ok) {
        throw new E2ETimeoutError("runUntil predicate never fired", result.elapsedMs);
      }
    },

    runGame: async (opts2) => {
      const result = await pollUntil(
        () =>
          page.evaluate(() => {
            const e2e = (globalThis as unknown as Record<string, unknown>)
              .__e2e as { mode?: string } | undefined;
            return e2e?.mode === "STOPPED";
          }),
        opts2?.timeoutMs ?? 120_000,
      );
      if (!result.ok) {
        throw new E2ETimeoutError(
          "runGame: mode did not reach STOPPED",
          result.elapsedMs,
        );
      }
    },

    captureOn: async (type, predicate) => {
      const predicateSrc = predicate ? predicate.toString() : null;
      await page.evaluate(
        (args) => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as
            | {
                captureOn?: (
                  type: string,
                  predicateSrc: string | null,
                ) => void;
              }
            | undefined;
          if (!e2e?.captureOn) {
            throw new Error("__e2e.captureOn not installed");
          }
          e2e.captureOn(args.type, args.predicateSrc);
        },
        { type: String(type), predicateSrc },
      );
    },

    input: {
      mouseMove: async (wx, wy) => {
        const { cx, cy } = await worldToClient(wx, wy);
        await page.mouse.move(cx, cy);
      },
      click: async (wx, wy) => {
        const { cx, cy } = await worldToClient(wx, wy);
        await page.mouse.click(cx, cy);
      },
      rightClick: async (wx, wy) => {
        const { cx, cy } = await worldToClient(wx, wy);
        await page.mouse.click(cx, cy, { button: "right" });
      },
      pressKey: async (key) => {
        await page.keyboard.press(key);
      },
      keyDown: async (key) => {
        await page.keyboard.down(key);
      },
      keyUp: async (key) => {
        await page.keyboard.up(key);
      },
      tap: async (wx, wy) => {
        const { cx, cy } = await worldToClient(wx, wy);
        await page.touchscreen.tap(cx, cy);
      },
      touchStart: (touches) => dispatchTouch("touchstart", touches),
      touchMove: (touches) => dispatchTouch("touchmove", touches),
      touchEnd: (touches = [], changedTouches) =>
        dispatchTouch(
          "touchend",
          touches,
          changedTouches ??
            (touches.length === 0 ? [{ wx: 0, wy: 0 }] : touches),
        ),
      hoverTile: async (row, col) => {
        const { wx, wy } = tileCenterWorld(row, col);
        const { cx, cy } = await worldToClient(wx, wy);
        await page.mouse.move(cx, cy);
      },
      clickTile: async (row, col) => {
        const { wx, wy } = tileCenterWorld(row, col);
        const { cx, cy } = await worldToClient(wx, wy);
        await page.mouse.click(cx, cy);
      },
      tapTile: async (row, col) => {
        const { wx, wy } = tileCenterWorld(row, col);
        const { cx, cy } = await worldToClient(wx, wy);
        await page.touchscreen.tap(cx, cy);
      },
    },

    roomCode: () => {
      if (!extractedRoomCode) {
        throw new Error("roomCode() is only available with online: 'host'");
      }
      return Promise.resolve(extractedRoomCode);
    },

    perf,

    close: teardown,
    [Symbol.asyncDispose]: teardown,
  };

  return scenario;
}

/** Tick until a `phaseStart` event for `phase` fires. Returns the captured
 *  bus entry with full `phaseStart` payload typing. Throws `E2ETimeoutError`
 *  on timeout. Mirrors the headless `waitForPhase`. */
export function waitForPhase(
  sc: E2EScenario,
  phase: Phase,
  opts?: E2ERunOpts,
): Promise<E2EBusEntryOf<"phaseStart">> {
  return waitForEvent(
    sc,
    GAME_EVENT.PHASE_START,
    (ev) => ev.phase === phase,
    { ...opts, label: `waitForPhase(${phase})` },
  );
}

/** Tick until a modifier is applied. Filter by `modifierId` if provided.
 *  Listens to the domain event (`MODIFIER_APPLIED`), not the UI banner. */
export function waitForModifier(
  sc: E2EScenario,
  modifierId?: ModifierId,
  opts?: E2ERunOpts,
): Promise<E2EBusEntryOf<"modifierApplied">> {
  return waitForEvent(
    sc,
    GAME_EVENT.MODIFIER_APPLIED,
    (ev) => modifierId === undefined || ev.modifierId === modifierId,
    { ...opts, label: "waitForModifier" },
  );
}

/** Tick until a `bannerStart` event matching `predicate` fires. Throws
 *  `E2ETimeoutError` on timeout. */
export function waitForBanner(
  sc: E2EScenario,
  predicate: (ev: E2EBusEntryOf<"bannerStart">) => boolean,
  opts?: E2ERunOpts,
): Promise<E2EBusEntryOf<"bannerStart">> {
  return waitForEvent(sc, GAME_EVENT.BANNER_START, predicate, {
    ...opts,
    label: "waitForBanner",
  });
}

/** Generic "drive the game until an event matching `predicate` fires"
 *  helper. Mirrors the headless `waitForEvent` — the three specific
 *  `waitFor*` functions below are one-line wrappers. Throws
 *  `E2ETimeoutError` (re-thrown from `runUntil` with `opts.label`) if
 *  the target event never fires within the budget. */
export async function waitForEvent<K extends keyof GameEventMap>(
  sc: E2EScenario,
  eventType: K,
  predicate: (ev: E2EBusEntryOf<K>) => boolean,
  opts?: E2ERunOpts & { label?: string },
): Promise<E2EBusEntryOf<K>> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const label = opts?.label ?? `waitForEvent(${String(eventType)})`;
  let captured: E2EBusEntryOf<K> | null = null;
  const handler = (ev: E2EBusEntryOf<K>) => {
    if (captured === null && predicate(ev)) captured = ev;
  };
  sc.bus.on(eventType, handler);
  try {
    await sc.runUntil(() => captured !== null, { timeoutMs });
  } catch (err) {
    if (err instanceof E2ETimeoutError) {
      throw new E2ETimeoutError(label, err.elapsedMs);
    }
    throw err;
  } finally {
    sc.bus.off(eventType, handler);
  }
  // Unreachable: runUntil either succeeded (captured is non-null) or
  // threw above. Kept as a belt-and-braces invariant check.
  if (captured === null) throw new Error(`${label}: handler did not capture`);
  return captured;
}

/** Lightweight assertion tracker for e2e tests. Prints PASS/FAIL per check,
 *  prints a summary, and calls Deno.exit(1) on failure from done(). */
export class E2ETest {
  private passed = 0;
  private failed = 0;
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
    console.log(`Starting ${label}...\n`);
  }

  check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
      console.log(`  PASS: ${name}`);
      this.passed++;
    } else {
      console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
      this.failed++;
    }
  }

  done(): void {
    console.log(`\n--- ${this.label} ---`);
    console.log(`${this.passed} passed, ${this.failed} failed\n`);
    if (this.failed > 0) Deno.exit(1);
  }

  get failures(): number {
    return this.failed;
  }
}

/** Tile → world-pixel centre. Used by the `*Tile(row, col)` input helpers
 *  to convert stable tile coords into the world-space coords that
 *  `worldToClient` accepts. */
function tileCenterWorld(
  row: number,
  col: number,
): { wx: number; wy: number } {
  return {
    wx: (col + 0.5) * TILE_SIZE,
    wy: (row + 0.5) * TILE_SIZE,
  };
}
