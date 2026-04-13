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
} from "../src/runtime/runtime-e2e-bridge.ts";
import type { GameEventMap } from "../src/shared/core/game-event-bus.ts";

// Re-export so tests can import GAME_EVENT from the same place.
export { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
export type { E2EBusEntry } from "../src/runtime/runtime-e2e-bridge.ts";

export interface E2EScenarioOptions {
  seed?: number;
  humans?: number;
  headless?: boolean;
  rounds?: number;
  mode?: string;
  /** Online mode. `"host"` creates a room and waits for peers.
   *  `"join"` joins an existing room via `roomCode`. Omit for local play. */
  online?: "host" | "join";
  /** Room code to join when `online: "join"`. */
  roomCode?: string;
}

/** Event type — accepts GAME_EVENT constants or raw strings. */
type E2EEventType = keyof GameEventMap;

/** Handler for a specific event type. Receives the busLog entry. */
type E2EBusHandler = (event: E2EBusEntry) => void;

/** Catch-all handler. Receives the event type string and the entry. */
type E2EAnyHandler = (type: string, event: E2EBusEntry) => void;

export interface E2EScenario {
  /** Escape hatch for custom page.evaluate calls. */
  readonly page: Page;
  /** Read the current bridge snapshot. */
  state(): Promise<E2EBridgeSnapshot>;
  /** Current UI mode (LOBBY, GAME, STOPPED, etc). */
  mode(): Promise<string>;
  /** Current game phase. */
  phase(): Promise<string>;
  /** Whether the lobby UI is currently active. */
  lobbyActive(): Promise<boolean>;
  /** Game bus — mirrors the headless GameEventBus shape. Handlers fire
   *  during `runUntil` / `runGame` as new events appear in busLog. */
  bus: {
    /** Subscribe to a specific event type. Accepts GAME_EVENT constants. */
    on(eventType: E2EEventType, handler: E2EBusHandler): void;
    /** Unsubscribe from a specific event type. */
    off(eventType: E2EEventType, handler: E2EBusHandler): void;
    /** Subscribe to ALL events. */
    onAny(handler: E2EAnyHandler): void;
    /** Unsubscribe a catch-all handler. */
    offAny(handler: E2EAnyHandler): void;
    /** Read the full event log (or filtered by type). */
    events(eventType?: E2EEventType): Promise<E2EBusEntry[]>;
  };
  /** Drive the game until a predicate returns true. The predicate
   *  receives the scenario itself — use `await sc.phase()`, `await sc.state()`,
   *  etc. Bus handlers fire for each new event during the wait. */
  runUntil(
    predicate: (sc: E2EScenario) => Promise<boolean> | boolean,
    opts?: { timeout?: number },
  ): Promise<void>;
  /** Wait until the game reaches STOPPED mode.
   *  Bus handlers fire for each new event during the wait. */
  runGame(opts?: { timeout?: number }): Promise<void>;
  /** Input helpers — world coordinates, converted to client coords via bridge. */
  input: {
    mouseMove(wx: number, wy: number): Promise<void>;
    click(wx: number, wy: number): Promise<void>;
    rightClick(wx: number, wy: number): Promise<void>;
    pressKey(key: string): Promise<void>;
    tap(wx: number, wy: number): Promise<void>;
  };
  /** Room code (only available when `online: "host"`). */
  roomCode(): Promise<string>;
  /** Close the browser. */
  close(): Promise<void>;
}

const BASE_URL = "http://localhost:5173";
/** Polling interval (ms) for draining busLog during runUntil/runGame. */
const POLL_MS = 50;

export async function createE2EScenario(
  opts: E2EScenarioOptions = {},
): Promise<E2EScenario> {
  const {
    seed,
    humans = 1,
    headless = true,
    rounds = 3,
    mode,
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
  if (!online) {
    const slotKeys = ["n", "f", "h"];
    for (let idx = 0; idx < humans; idx++) {
      await page.keyboard.press(slotKeys[idx]!);
    }
  }

  // Wait for game to start (skip for online — lobby exit happens during
  // runGame/runUntil so both host and client can join before the timer expires).
  if (!online) {
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
  const typedHandlers = new Map<string, Set<E2EBusHandler>>();
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
      const handlers = typedHandlers.get(entry.type);
      if (handlers) {
        for (const handler of handlers) handler(entry);
      }
      // Fire catch-all handlers.
      for (const handler of anyHandlers) handler(entry.type, entry);
    }
  }

  /** Polling loop: drain bus + check predicate until done or timeout. */
  async function pollUntil(
    checkDone: () => Promise<boolean>,
    timeout: number,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await drainBus();
      if (await checkDone()) {
        // One final drain to catch events emitted on the same frame.
        await drainBus();
        return;
      }
      await page.waitForTimeout(POLL_MS);
    }
    // Final drain even on timeout.
    await drainBus();
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

    mode: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { mode?: string } | undefined;
        return e2e?.mode ?? "";
      }),

    phase: () =>
      page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { phase?: string } | undefined;
        return e2e?.phase ?? "";
      }),

    lobbyActive: async () => (await scenario.mode()) === "LOBBY",

    bus: {
      on(eventType: string, handler: E2EBusHandler): void {
        let set = typedHandlers.get(eventType);
        if (!set) {
          set = new Set();
          typedHandlers.set(eventType, set);
        }
        set.add(handler);
      },
      off(eventType: string, handler: E2EBusHandler): void {
        typedHandlers.get(eventType)?.delete(handler);
      },
      onAny(handler: E2EAnyHandler): void {
        anyHandlers.add(handler);
      },
      offAny(handler: E2EAnyHandler): void {
        anyHandlers.delete(handler);
      },
      events: (eventType?: string): Promise<E2EBusEntry[]> =>
        page.evaluate((filterType?: string) => {
          const e2e = (globalThis as unknown as Record<string, unknown>)
            .__e2e as { busLog?: unknown[] } | undefined;
          const log = (e2e?.busLog ?? []) as E2EBusEntry[];
          if (!filterType) return log;
          return log.filter((entry) => entry.type === filterType);
        }, eventType),
    },

    runUntil: async (predicate, opts2) => {
      const timeout = opts2?.timeout ?? 120_000;
      await pollUntil(
        async () => Boolean(await predicate(scenario)),
        timeout,
      );
    },

    runGame: async (opts2) => {
      const timeout = opts2?.timeout ?? 120_000;
      await pollUntil(
        () =>
          page.evaluate(() => {
            const e2e = (globalThis as unknown as Record<string, unknown>)
              .__e2e as { mode?: string } | undefined;
            return e2e?.mode === "STOPPED";
          }),
        timeout,
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
      tap: async (wx, wy) => {
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
  };

  return scenario;
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
