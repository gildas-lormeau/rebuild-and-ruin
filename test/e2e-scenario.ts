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

import { chromium, type Page } from "playwright";
import type {
  E2EBridgeSnapshot,
  E2EBusEntry,
  E2EBusEntryOf,
  SerializedGameState,
} from "../src/runtime/runtime-e2e-bridge.ts";
import type { MapLayer } from "../src/runtime/dev-console-grid.ts";
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
export type { MapLayer } from "../src/runtime/dev-console-grid.ts";

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
}

/** Event type — GAME_EVENT constants (string literal keys of GameEventMap). */
type E2EEventType = keyof GameEventMap;

/** Shared opts shape for `runUntil` / `runGame` / `waitFor*`. Units are
 *  wall-clock milliseconds because the Playwright poll loop is real-time.
 *  (The headless equivalents measure in sim frames — `maxTicks`.) */
export interface E2ERunOpts {
  /** Wall-clock budget in milliseconds. Defaults to 120_000 for run-game-
   *  level operations, 30_000 for waitFor* helpers. */
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
   */
  asciiSnapshot(layer?: MapLayer): Promise<string | null>;
  /** Current UI mode (LOBBY, GAME, STOPPED, …) — stringified `Mode` enum key. */
  mode(): Promise<E2EMode>;
  /** Current game phase — `Phase` enum (string-valued), or "" before ready. */
  phase(): Promise<E2EPhase>;
  /** Whether the lobby UI is currently active. */
  lobbyActive(): Promise<boolean>;
  /** Game bus — mirrors the headless GameEventBus shape. Handlers fire
   *  during `runUntil` / `runGame` as new events appear in busLog. */
  bus: {
    /** Subscribe to a specific event type. The handler receives the full
     *  typed payload (same shape as the headless `GameEventBus`) plus the
     *  bridge's recording metadata (`_seq`, `_canvasSnapshot`, …). */
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
  /** Enable per-frame canvas snapshot capture. Tick entries during banners
   *  and banner events always carry snapshots; enabling this also captures
   *  the "frame before banner" via `_prevSnapshot`. Opt-in because
   *  `toDataURL` every frame is expensive. */
  enableCanvasSnapshots(): Promise<void>;
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
  /** Close the browser. */
  close(): Promise<void>;
}

const BASE_URL = "http://localhost:5173";
/** Polling interval (ms) for draining busLog during runUntil/runGame. */
const POLL_MS = 50;
/** Default budget for wait helpers (30s wall-clock). Shorter than
 *  `runGame`'s 120s because wait helpers target a single event, not the
 *  whole game. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

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
  } = opts;

  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext();
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
    await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
    await page.selectOption("#create-wait", "10");
    await page.selectOption("#create-rounds", String(rounds));
    await page.click("#btn-create-confirm");
    await page.waitForFunction(
      () => document.getElementById("page-online")?.hidden === true,
      { timeout: 10000 },
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
    await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
    await page.fill("#join-code", joinCode);
    await page.click("#btn-join-confirm");
    await page.waitForFunction(
      () => document.getElementById("page-online")?.hidden === true,
      { timeout: 10000 },
    );
  } else {
    // Local game.
    await page.click("#btn-local");
    await page.waitForSelector("#game-container.active", { timeout: 5000 });
  }

  // Fast mode — replace RAF with a tight setTimeout loop. Each callback
  // advances the fake clock by 100ms of sim time but fires after ~1ms of
  // real time, giving ~100× speed without touching __dev.
  await page.evaluate(() => {
    let fakeTime = performance.now();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => {
        fakeTime += 100;
        cb(fakeTime);
      }, 1) as unknown) as typeof requestAnimationFrame;
  });

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
    await page.waitForFunction(
      () => {
        const win = globalThis as unknown as Record<string, unknown>;
        const e2e = win.__e2e as { mode?: string } | undefined;
        return (
          e2e?.mode !== undefined && e2e.mode !== "" && e2e.mode !== "LOBBY"
        );
      },
      { timeout: 90_000 },
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
   *  Strips _canvasSnapshot and _prevSnapshot from entries to avoid
   *  transferring megabytes of PNG data across the Playwright IPC
   *  boundary — handlers don't need pixel data. Use bus.events() to
   *  read entries with snapshots intact. */
  async function drainBus(): Promise<void> {
    const newEntries: E2EBusEntry[] = await page.evaluate(
      (fromSeq: number) => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { busLog?: E2EBusEntry[] } | undefined;
        const log = e2e?.busLog;
        if (!log || log.length <= fromSeq) return [];
        return log.slice(fromSeq).map((entry) => {
          if (!entry._canvasSnapshot && !entry._prevSnapshot) return entry;
          const { _canvasSnapshot, _prevSnapshot, ...rest } = entry;
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

    asciiSnapshot: (layer = "all") =>
      page.evaluate((filterLayer: MapLayer) => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as
          | { asciiSnapshot?: (layer: MapLayer) => string | null }
          | undefined;
        if (!e2e) throw new Error("__e2e bridge not available");
        return e2e.asciiSnapshot?.(filterLayer) ?? null;
      }, layer),

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

    enableCanvasSnapshots: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { captureTickSnapshots?: boolean } | undefined;
        if (e2e) e2e.captureTickSnapshots = true;
      }),

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

    close: async () => {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    },
    [Symbol.asyncDispose]: async () => {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    },
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

/** Tick until a modifier banner fires. Filter by `modifierId` if provided. */
export function waitForModifier(
  sc: E2EScenario,
  modifierId?: ModifierId,
  opts?: E2ERunOpts,
): Promise<E2EBusEntryOf<"bannerStart">> {
  return waitForBanner(
    sc,
    (ev) =>
      ev.modifierId !== undefined &&
      (modifierId === undefined || ev.modifierId === modifierId),
    opts,
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
