/**
 * E2E test helpers — typed Playwright wrapper for game interaction.
 *
 * Provides world-coordinate mouse/touch input, game state queries,
 * phase advancement, and pause/step control via the window.__e2e bridge.
 *
 * Usage:
 *   import { E2EGame } from "./e2e-helpers.ts";
 *   const game = await E2EGame.create({ seed: 42, humans: 1, headless: true });
 *   await game.advanceTo("CANNON_PLACE");
 *   await game.mouse.clickTile(10, 10);
 *   const ctrl = await game.query.controller();
 *   await game.close();
 */

import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Game constants (mirrored from src/shared — avoid importing game code)
// ---------------------------------------------------------------------------

const TILE_SIZE = 16;
const BASE_URL = "http://localhost:5173";

/** Known phase durations (seconds). Used to compute advanceTo timeouts. */
const PHASE_DURATIONS: Record<string, number> = {
  LOBBY: 15,
  CASTLE_SELECT: 10,
  BANNER: 3,
  CASTLE_BUILD: 5,
  WALL_BUILD: 25,
  CANNON_PLACE: 15,
  BATTLE: 10,
};

/** Approximate max seconds from game start to reach a given phase. */
function maxSecondsToPhase(target: string): number {
  const order = [
    "CASTLE_SELECT",
    "CASTLE_BUILD",
    "WALL_BUILD",
    "CANNON_PLACE",
    "BATTLE",
  ];
  const idx = order.indexOf(target);
  if (idx < 0) return 120; // unknown — generous default
  let total = PHASE_DURATIONS.LOBBY! + 2; // lobby + margin
  for (let i = 0; i <= idx; i++) {
    total += (PHASE_DURATIONS[order[i]!] ?? 10) + PHASE_DURATIONS.BANNER!;
  }
  return total + 5; // extra margin
}

// ---------------------------------------------------------------------------
// Bridge types (mirrors E2EBridge from runtime-e2e-bridge.ts)
// ---------------------------------------------------------------------------

interface E2EEntitySnapshot {
  houses: { row: number; col: number; alive: boolean }[];
  grunts: { row: number; col: number }[];
  towerAlive: boolean[];
  burningPits: { row: number; col: number }[];
  bonusSquares: { row: number; col: number }[];
  frozenTiles: number[];
}

interface E2EBridgeSnapshot {
  mode: string;
  phase: string;
  round: number;
  timer: number;
  overlay: {
    entities: E2EEntitySnapshot | null;
    bannerPrevEntities: E2EEntitySnapshot | null;
    phantoms: {
      pieces: {
        row: number;
        col: number;
        valid: boolean;
        playerId: number;
      }[];
      cannons: {
        row: number;
        col: number;
        valid: boolean;
        mode: string;
        playerId: number;
      }[];
    } | null;
    banner: {
      text: string;
      y: number;
      modifierDiff: {
        id: string;
        changedTiles: number[];
        gruntsSpawned: number;
      } | null;
    } | null;
    battle: {
      cannonballs: number;
      impacts: number;
      crosshairs: { x: number; y: number; playerId: number }[];
    } | null;
    ui: {
      statusBar: {
        round: string;
        phase: string;
        timer: string;
        modifier?: string;
      } | null;
      gameOver: { winner: string } | null;
      lifeLostDialog: {
        entries: { playerId: number; choice: string }[];
      } | null;
      upgradePick: {
        entries: { playerName: string; resolved: boolean }[];
      } | null;
    };
  };
  players: {
    id: number;
    score: number;
    lives: number;
    eliminated: boolean;
    walls: number;
    cannons: number;
  }[];
  controller: {
    buildCursor: { row: number; col: number } | null;
    cannonCursor: { row: number; col: number } | null;
    cannonMode: string | null;
    crosshair: { x: number; y: number } | null;
  } | null;
  camera: {
    viewport: { x: number; y: number; w: number; h: number } | null;
  };
  network: {
    messages: { dir: "in" | "out"; type: string; time: number }[];
    logLevel: string;
  };
}

// ---------------------------------------------------------------------------
// E2EGame class
// ---------------------------------------------------------------------------

export interface E2EGameOptions {
  seed?: number;
  humans?: number;
  headless?: boolean;
  rounds?: number;
  /** Game mode override (e.g. "modern"). Passed as ?mode= URL param. */
  mode?: string;
}

export class E2EGame {
  readonly page: Page;
  readonly canvas: Locator;
  private readonly browser: Browser;
  private readonly logs: string[] = [];

  private constructor(browser: Browser, page: Page) {
    this.browser = browser;
    this.page = page;
    this.canvas = page.locator("#canvas");
    page.on("console", (msg) => {
      this.logs.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      this.logs.push(`[ERROR] ${err.message}`);
    });
  }

  // --- Factory ---

  static async create(opts: E2EGameOptions = {}): Promise<E2EGame> {
    const {
      seed,
      humans = 1,
      headless = true,
      rounds = 3,
      mode,
    } = opts;

    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const game = new E2EGame(browser, page);

    const seedParam = seed !== undefined ? String(seed) : "";
    const modeParam = mode ? `&mode=${mode}` : "";
    await page.goto(`${BASE_URL}?rounds=${rounds}${modeParam}`);

    // Set seed via localStorage
    if (seedParam) {
      await page.evaluate((sd: string) => {
        const settings = JSON.parse(
          localStorage.getItem("castles99_settings") || "{}",
        );
        settings.seedMode = "custom";
        settings.seed = sd;
        localStorage.setItem("castles99_settings", JSON.stringify(settings));
      }, seedParam);
    }

    // Start local game
    await page.click("#btn-local");
    await page.waitForSelector("#game-container.active", { timeout: 5000 });

    // Fast mode — always on by default, can be toggled via setFastMode()
    // Also enables the render spy on the first frame so all phases are captured.
    await page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      win.__e2eOriginalRAF = globalThis.requestAnimationFrame;
      let spyEnabled = false;
      let fakeTime = performance.now();
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => {
          if (!spyEnabled) {
            const e2e = win.__e2e as { enableRenderSpy?: () => void } | undefined;
            if (e2e?.enableRenderSpy) {
              e2e.enableRenderSpy();
              spyEnabled = true;
            }
          }
          fakeTime += 100;
          cb(fakeTime);
        }, 1) as unknown) as typeof requestAnimationFrame;
    });

    // Join human slots
    const slotKeys = ["n", "f", "h"];
    for (let i = 0; i < humans; i++) {
      await page.keyboard.press(slotKeys[i]!);
    }

    // Wait for game to start (fast mode makes the lobby timer < 1s)
    await page.waitForFunction(
      () => {
        const win = globalThis as unknown as Record<string, unknown>;
        const e2e = win.__e2e as { mode?: string } | undefined;
        return e2e?.mode !== undefined && e2e.mode !== "" && e2e.mode !== "LOBBY";
      },
      { timeout: 90_000 },
    );

    return game;
  }

  // --- Lifecycle ---

  async close(): Promise<void> {
    await this.page.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /** Save collected logs to a file. */
  saveLogs(label = "e2e"): string {
    mkdirSync("logs", { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `logs/${label}-${ts}.log`;
    writeFileSync(path, this.logs.join("\n"));
    return path;
  }

  getLogs(): readonly string[] {
    return this.logs;
  }

  // --- Phase control ---

  /** Wait until the game reaches a specific phase. Timeout derived from game constants. */
  async advanceTo(
    phase: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeout = (opts?.timeout ?? maxSecondsToPhase(phase)) * 1000;
    await this.page.waitForFunction(
      (targetPhase: string) => {
        const win = globalThis as unknown as Record<string, unknown>;
        const e2e = win.__e2e as { phase?: string } | undefined;
        return (
          (e2e?.phase === targetPhase) ||
          ((win.__e2e as { phase?: string } | undefined)?.phase === targetPhase)
        );
      },
      phase,
      { timeout },
    );
  }

  /** Wait until a predicate on the bridge snapshot returns true. */
  async waitUntil(
    predicate: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeout = opts?.timeout ?? 30_000;
    await this.page.waitForFunction(
      new Function(
        "e2e",
        `return (${predicate})(e2e)`,
      ) as unknown as string,
      { timeout },
    );
  }

  /** Toggle fast mode on/off. Fast mode is on by default. Disable for
   *  precise mouse interaction where camera lerp timing matters. */
  async setFastMode(enabled: boolean): Promise<void> {
    await this.page.evaluate((on: boolean) => {
      const win = globalThis as unknown as Record<string, unknown>;
      if (on) {
        let fakeTime = performance.now();
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
          setTimeout(() => {
            fakeTime += 100;
            cb(fakeTime);
          }, 1) as unknown) as typeof requestAnimationFrame;
      } else {
        const orig = win.__e2eOriginalRAF as typeof requestAnimationFrame;
        if (orig) globalThis.requestAnimationFrame = orig;
      }
    }, enabled);
  }

  // --- Pause / step ---

  async pause(): Promise<void> {
    await this.page.evaluate(() => {
      const e2e = (globalThis as unknown as Record<string, unknown>)
        .__e2e as { paused?: boolean };
      if (e2e) e2e.paused = true;
    });
  }

  async resume(): Promise<void> {
    await this.page.evaluate(() => {
      const e2e = (globalThis as unknown as Record<string, unknown>)
        .__e2e as { paused?: boolean };
      if (e2e) e2e.paused = false;
    });
  }

  async step(): Promise<void> {
    await this.page.evaluate(() => {
      const e2e = (globalThis as unknown as Record<string, unknown>)
        .__e2e as { step?: boolean };
      if (e2e) e2e.step = true;
    });
    // Wait for the step flag to be consumed (bridge processes one frame)
    await this.page.waitForFunction(() => {
      const e2e = (globalThis as unknown as Record<string, unknown>)
        .__e2e as { step?: boolean } | undefined;
      return !e2e?.step;
    }, { timeout: 5000 });
  }

  // --- Query ---

  readonly query = {
    /** Full bridge snapshot. */
    state: (): Promise<E2EBridgeSnapshot> => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as E2EBridgeSnapshot | undefined;
        if (!e2e) throw new Error("__e2e bridge not available");
        return JSON.parse(JSON.stringify(e2e, (_k, vi) => {
          // Strip functions — they can't cross the bridge
          if (typeof vi === "function") return undefined;
          return vi;
        }));
      }) as Promise<E2EBridgeSnapshot>;
    },
    phase: (): Promise<string> => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { phase?: string } | undefined;
        return e2e?.phase ?? "";
      });
    },
    mode: (): Promise<string> => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { mode?: string } | undefined;
        return e2e?.mode ?? "";
      });
    },
    timer: (): Promise<number> => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { timer?: number } | undefined;
        return e2e?.timer ?? 0;
      });
    },
    overlay: async (): Promise<E2EBridgeSnapshot["overlay"]> => {
      const snap = await this.query.state();
      return snap.overlay;
    },
    players: async (): Promise<E2EBridgeSnapshot["players"]> => {
      const snap = await this.query.state();
      return snap.players;
    },
    controller: async (): Promise<E2EBridgeSnapshot["controller"]> => {
      const snap = await this.query.state();
      return snap.controller;
    },
    phantoms: async (): Promise<E2EBridgeSnapshot["overlay"]["phantoms"]> => {
      const snap = await this.query.state();
      return snap.overlay.phantoms;
    },
  };

  // --- Render spy ---

  readonly spy = {
    /** Get the current frame's text draws from the bridge. */
    textDraws: (): Promise<
      { text: string; color: string; x: number; y: number; scale: number }[]
    > => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { textSpy?: unknown[] | null } | undefined;
        return (e2e?.textSpy ?? []) as {
          text: string;
          color: string;
          x: number;
          y: number;
          scale: number;
        }[];
      });
    },
    /** Get the current frame's sprite draws from the bridge. */
    spriteDraws: (): Promise<
      { name: string; x: number; y: number }[]
    > => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { renderSpy?: unknown[] | null } | undefined;
        return (e2e?.renderSpy ?? []) as { name: string; x: number; y: number }[];
      });
    },
    /**
     * Install a per-frame collector that accumulates draws matching a filter.
     * The filter runs in page context — pass a JS expression string that
     * receives `draw` (text draw) and `e2e` (bridge) and returns a bucket
     * name string, or null to skip.
     *
     * Example:
     *   await game.spy.collect(`
     *     if (draw.color === "rgba(255,180,50,1)" && draw.scale > 1) return "lockout";
     *     if (draw.color === "rgb(255,255,255)" && draw.scale === 1) return "normal";
     *     return null;
     *   `, { maxPerBucket: 5 });
     *   // ... wait for game to finish ...
     *   const results = await game.spy.collected();
     */
    collect: async (
      filterBody: string,
      opts?: { maxPerBucket?: number },
    ): Promise<void> => {
      const max = opts?.maxPerBucket ?? 10;
      await this.page.evaluate(
        ([body, limit]: [string, number]) => {
          const win = globalThis as unknown as Record<string, unknown>;
          const buckets: Record<string, unknown[]> = {};
          win.__spyCollector = buckets;
          const classify = new Function("draw", "e2e", body) as (
            draw: unknown,
            e2e: unknown,
          ) => string | null;

          const prevRAF = globalThis.requestAnimationFrame;
          globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
            prevRAF((time: number) => {
              cb(time);
              const e2e = win.__e2e as {
                textSpy?: { text: string; color: string; scale: number }[];
              } | undefined;
              if (!e2e?.textSpy) return;
              for (const draw of e2e.textSpy) {
                const bucket = classify(draw, e2e);
                if (!bucket) continue;
                if (!buckets[bucket]) buckets[bucket] = [];
                if (buckets[bucket]!.length < limit) {
                  buckets[bucket]!.push({ ...draw });
                }
              }
            });
        },
        [filterBody, max] as [string, number],
      );
    },
    /** Read the collected buckets from a prior `collect()` call. */
    collected: (): Promise<
      Record<string, { text: string; color: string; scale: number }[]>
    > => {
      return this.page.evaluate(() => {
        const win = globalThis as unknown as Record<string, unknown>;
        return (win.__spyCollector ?? {}) as Record<
          string,
          { text: string; color: string; scale: number }[]
        >;
      });
    },
  };

  // --- Mouse input (world coordinates) ---

  readonly mouse = {
    /** Move the mouse to a world-pixel position. */
    moveToWorld: async (wx: number, wy: number): Promise<void> => {
      const { cx, cy } = await this.worldToClient(wx, wy);
      await this.page.mouse.move(cx, cy);
    },
    /** Move the mouse to the center of a tile. */
    moveToTile: async (row: number, col: number): Promise<void> => {
      const { cx, cy } = await this.tileToClient(row, col);
      await this.page.mouse.move(cx, cy);
    },
    /** Click at a world-pixel position. */
    clickWorld: async (wx: number, wy: number): Promise<void> => {
      const { cx, cy } = await this.worldToClient(wx, wy);
      await this.page.mouse.click(cx, cy);
    },
    /** Click at the center of a tile. */
    clickTile: async (row: number, col: number): Promise<void> => {
      const { cx, cy } = await this.tileToClient(row, col);
      await this.page.mouse.click(cx, cy);
    },
    /** Right-click at a world-pixel position. */
    rightClickWorld: async (wx: number, wy: number): Promise<void> => {
      const { cx, cy } = await this.worldToClient(wx, wy);
      await this.page.mouse.click(cx, cy, { button: "right" });
    },
    /** Sweep the mouse pixel by pixel between two world positions. */
    sweep: async (
      from: { wx: number; wy: number },
      to: { wx: number; wy: number },
      opts?: { stepPx?: number; delayMs?: number },
    ): Promise<void> => {
      const stepPx = opts?.stepPx ?? 1;
      const delayMs = opts?.delayMs ?? 0;
      const dx = to.wx - from.wx;
      const dy = to.wy - from.wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / stepPx));
      for (let i = 0; i <= steps; i++) {
        const frac = i / steps;
        const wx = from.wx + dx * frac;
        const wy = from.wy + dy * frac;
        const { cx, cy } = await this.worldToClient(wx, wy);
        await this.page.mouse.move(cx, cy);
        if (delayMs > 0) await this.page.waitForTimeout(delayMs);
      }
    },
  };

  // --- Keyboard ---

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      await this.page.keyboard.press(key);
    },
    hold: async (key: string): Promise<void> => {
      await this.page.keyboard.down(key);
    },
    release: async (key: string): Promise<void> => {
      await this.page.keyboard.up(key);
    },
  };

  // --- Touch ---

  readonly touch = {
    tapWorld: async (wx: number, wy: number): Promise<void> => {
      const { cx, cy } = await this.worldToClient(wx, wy);
      await this.page.touchscreen.tap(cx, cy);
    },
    tapTile: async (row: number, col: number): Promise<void> => {
      const { cx, cy } = await this.tileToClient(row, col);
      await this.page.touchscreen.tap(cx, cy);
    },
  };

  // --- DOM ---

  readonly dom = {
    /** Click a button by its data-action attribute. */
    clickButton: async (action: string): Promise<void> => {
      await this.page.click(`[data-action="${action}"]`);
    },
    /** Check if a button is visible. */
    isVisible: async (action: string): Promise<boolean> => {
      const el = this.page.locator(`[data-action="${action}"]`).first();
      return await el.isVisible();
    },
    dpad: {
      press: async (
        direction: "up" | "down" | "left" | "right",
      ): Promise<void> => {
        await this.page.click(`[data-action="${direction}"]`);
      },
      pressConfirm: async (): Promise<void> => {
        await this.page.click(`[data-action="confirm"]`);
      },
      pressRotate: async (): Promise<void> => {
        await this.page.click(`[data-action="rotate"]`);
      },
    },
  };

  // --- Network ---

  readonly network = {
    getMessages: (): Promise<
      { dir: "in" | "out"; type: string; time: number }[]
    > => {
      return this.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as { network?: { messages: unknown[] } } | undefined;
        return (e2e?.network?.messages ?? []) as {
          dir: "in" | "out";
          type: string;
          time: number;
        }[];
      });
    },
  };

  // --- Coord conversion ---

  private async worldToClient(
    wx: number,
    wy: number,
  ): Promise<{ cx: number; cy: number }> {
    return await this.page.evaluate(
      ([worldX, worldY]: [number, number]) => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as {
          worldToClient?: (wx: number, wy: number) => { cx: number; cy: number };
        } | undefined;
        if (e2e?.worldToClient) return e2e.worldToClient(worldX, worldY);
        // Fallback: assume no viewport transform
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

  private async tileToClient(
    row: number,
    col: number,
  ): Promise<{ cx: number; cy: number }> {
    return await this.worldToClient(
      (col + 0.5) * TILE_SIZE,
      (row + 0.5) * TILE_SIZE,
    );
  }
}
