/**
 * Headless runtime variant — boots `createGameRuntime` with stub DOM/timing
 * deps and a manually-driven main loop. Used by the test scenario API
 * (`test/scenario.ts`) and reusable by future dev tools (preview mode,
 * AI showcase, demo recording).
 *
 * The runtime sub-systems are unchanged — same composition root the browser
 * uses. Only the *injected* dependencies are stubbed:
 *   - Renderer: no-op `drawFrame`, dummy HTMLElement-shaped container
 *   - Timing: mock clock advanced by `tick(dtMs)`, deterministic setTimeout
 *   - Keyboard event source: no-op add/removeEventListener
 *
 * Tests observe state changes via the typed `GameEventBus` on
 * `runtime.runtimeState.state.bus` rather than reaching into runtime internals.
 */

import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
} from "../shared/game-constants.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../shared/overlay-types.ts";
import { SEED_CUSTOM } from "../shared/player-config.ts";
import { SPECTATOR_SLOT } from "../shared/player-slot.ts";
import { Mode } from "../shared/ui-mode.ts";
import { createGameRuntime } from "./runtime.ts";
import { setMode } from "./runtime-state.ts";
import type { GameRuntime, TimingApi } from "./runtime-types.ts";

interface HeadlessRuntimeOptions {
  /** Map seed — controls map, AI, and modifier rolls. */
  seed: number;
  /** Game mode. Defaults to `"classic"`. Use `"modern"` to enable
   *  modifiers, upgrades, and combo scoring. */
  gameMode?: GameMode;
  /** Number of rounds before the game ends. Defaults to 3. */
  rounds?: number;
  /** When true, runtime log lines are forwarded to console. Defaults to false. */
  log?: boolean;
}

export interface HeadlessRuntime {
  readonly runtime: GameRuntime;
  /** Current mock clock (ms). */
  now(): number;
  /** Advance the mock clock by `dtMs` and run one `mainLoop` iteration. */
  tick(dtMs?: number): void;
  /** Tick until `predicate` returns true or `maxTicks` reached.
   *  Returns the number of ticks taken, or -1 if the predicate never fired. */
  runUntil(predicate: () => boolean, maxTicks?: number, dtMs?: number): number;
  /** Tick until `mode === STOPPED` (game over) or `maxTicks` reached. */
  runGame(maxTicks?: number, dtMs?: number): void;
}

export async function createHeadlessRuntime(
  opts: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  const { seed, gameMode = GAME_MODE_CLASSIC, rounds = 3, log = false } = opts;

  // ── Mock clock + deterministic timer scheduling ───────────────────
  // All timing flows through this closure. `mainLoop` is driven manually
  // by `tick()`, so `requestFrame` is a no-op (no auto-rescheduling).
  let clock = 0;
  let nextHandle = 1;
  const pendingTimeouts = new Map<
    number,
    { callback: () => void; fireAt: number }
  >();

  const timing: TimingApi = {
    now: () => clock,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      pendingTimeouts.set(handle, { callback, fireAt: clock + ms });
      return handle;
    },
    clearTimeout: (handle) => {
      pendingTimeouts.delete(handle);
    },
    requestFrame: () => {},
  };

  const renderer = createStubRenderer();
  const keyboardEventSource: Pick<
    Document,
    "addEventListener" | "removeEventListener"
  > = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // ── Runtime construction ──────────────────────────────────────────
  const runtime = createGameRuntime({
    renderer,
    timing,
    keyboardEventSource,
    network: {
      send: () => {},
      getIsHost: () => true,
      getMyPlayerId: () => SPECTATOR_SLOT,
      getRemotePlayerSlots: () => new Set<number>(),
    },
    // Deterministic upgrade pick: always take the first offer. Headless tests
    // care about whether the upgrade flow runs, not which option is chosen.
    // (Domain rule: runtime/ cannot import from ai/.)
    aiPick: (offers) => offers[0],
    log: log ? (msg: string) => console.log(`[headless] ${msg}`) : () => {},
    logThrottled: () => {},
    getLobbyRemaining: () => 0,
    getUrlRoundsOverride: () => rounds,
    getUrlModeOverride: () =>
      gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    showLobby: () => {},
    onLobbySlotJoined: () => {},
    onTickLobbyExpired: async () => {},
  });

  // ── Seed injection ────────────────────────────────────────────────
  // bootstrapNewGameFromSettings reads runtimeState.lobby.seed and
  // runtimeState.lobby.joined, so we wire them up directly — no need
  // to go through the lobby UI flow. All slots stay un-joined → all AI.
  runtime.runtimeState.settings.seed = String(seed);
  runtime.runtimeState.settings.seedMode = SEED_CUSTOM;
  runtime.runtimeState.settings.gameMode = gameMode;
  runtime.runtimeState.lobby.seed = seed;

  // ── Sentinel warm-up ──────────────────────────────────────────────
  // `frameMeta` is initialized by `computeFrameContext` inside `mainLoop`.
  // startGame() indirectly touches frameMeta via resetUIState → render,
  // so we need one mainLoop tick (mode=LOBBY, state=sentinel but gated
  // by `isStateReady`) to hydrate frameMeta before calling startGame.
  setMode(runtime.runtimeState, Mode.LOBBY);
  runtime.runtimeState.lastTime = clock;
  runtime.mainLoop(clock);

  await runtime.lifecycle.startGame();

  // ── Driver API ────────────────────────────────────────────────────
  function fireTimeouts(): void {
    for (const [handle, entry] of pendingTimeouts) {
      if (clock >= entry.fireAt) {
        pendingTimeouts.delete(handle);
        entry.callback();
      }
    }
  }

  function tick(dtMs = 16): void {
    clock += dtMs;
    fireTimeouts();
    runtime.mainLoop(clock);
  }

  function runUntil(
    predicate: () => boolean,
    maxTicks = 10000,
    dtMs = 16,
  ): number {
    for (let i = 0; i < maxTicks; i++) {
      if (predicate()) return i;
      tick(dtMs);
    }
    return -1;
  }

  function runGame(maxTicks = 50000, dtMs = 16): void {
    for (let i = 0; i < maxTicks; i++) {
      if (runtime.runtimeState.mode === Mode.STOPPED) return;
      tick(dtMs);
    }
  }

  return {
    runtime,
    now: () => clock,
    tick,
    runUntil,
    runGame,
  };
}

/** No-op renderer satisfying `RendererInterface` without canvas/DOM access. */
function createStubRenderer(): RendererInterface {
  const container = createStubElement();
  const eventTarget = createStubElement();
  return {
    drawFrame: (
      _map: GameMap,
      _overlay: RenderOverlay | undefined,
      _viewport: Viewport | null | undefined,
      _now: number,
    ) => {},
    warmMapCache: (_map: GameMap) => {},
    clientToSurface: (_clientX: number, _clientY: number) => ({ x: 0, y: 0 }),
    screenToContainerCSS: (_sx: number, _sy: number) => ({ x: 0, y: 0 }),
    eventTarget,
    container,
  };
}

/**
 * Minimal `HTMLElement` stub — the runtime only touches `.clientHeight`,
 * `.classList.add`, and `.querySelector`. Returning `null` from the query
 * matches what `main.ts` gets in production when no touch UI is mounted.
 */
function createStubElement(): HTMLElement {
  const stub = {
    clientHeight: 720,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return stub as unknown as HTMLElement;
}
