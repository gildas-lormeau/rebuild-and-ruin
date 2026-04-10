/**
 * Headless full-runtime driver — boots the REAL `createGameRuntime` inside
 * Deno with stub DOM/timing deps so tests can exercise the same composition
 * root the browser uses.
 *
 * This is the primitive behind phase 7B of the test-API unification: instead
 * of instantiating game subsystems directly (the legacy `createHeadlessRuntime`
 * path in `runtime-headless.ts`), tests drive the real runtime and observe
 * state transitions via the typed `GameEventBus` on `state.bus`.
 *
 * Usage:
 *
 *   const dbg = await createDebugFullRuntime({ seed: 42 });
 *   dbg.runtime.runtimeState.state.bus.on(GAME_EVENT.BATTLE_START, (ev) => {...});
 *   dbg.runUntil(() => dbg.runtime.runtimeState.state.round >= 3);
 *
 * The mock clock is driven manually — each `tick(dtMs)` advances time and
 * invokes `mainLoop(now)` once. This gives tests deterministic control over
 * how much simulated time passes per step.
 */

import { aiPickUpgrade } from "../src/ai/ai-upgrade-pick.ts";
import { createGameRuntime } from "../src/runtime/runtime.ts";
import { setMode } from "../src/runtime/runtime-state.ts";
import type {
  GameRuntime,
  TimingApi,
} from "../src/runtime/runtime-types.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
} from "../src/shared/game-constants.ts";
import type { GameMap, Viewport } from "../src/shared/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../src/shared/overlay-types.ts";
import { SEED_CUSTOM } from "../src/shared/player-config.ts";
import { SPECTATOR_SLOT } from "../src/shared/player-slot.ts";
import { Mode } from "../src/shared/ui-mode.ts";

export interface DebugRuntimeOptions {
  /** Map seed — passed through settings so bootstrap picks it up. */
  seed: number;
  /** Game mode. Defaults to classic. Use `"modern"` to enable modifiers/upgrades/combos. */
  gameMode?: GameMode;
  /** Rounds override (wired through URL-override hook). Defaults to 3. */
  rounds?: number;
  /** If true, forwards runtime logs to console. Defaults to false (silent). */
  log?: boolean;
}

export interface DebugRuntime {
  readonly runtime: GameRuntime;
  /** Current mock clock (ms). */
  now(): number;
  /** Advance the mock clock by `dtMs` and run one `mainLoop` iteration. */
  tick(dtMs?: number): void;
  /** Tick until `predicate` returns true or `maxTicks` reached.
   *  Returns the number of ticks taken, or -1 if the predicate never fired. */
  runUntil(
    predicate: () => boolean,
    maxTicks?: number,
    dtMs?: number,
  ): number;
  /** Tick until `mode === STOPPED` (game over) or `maxTicks` reached. */
  runGame(maxTicks?: number, dtMs?: number): void;
}

/**
 * Minimal `HTMLElement` stub — the runtime only touches `.clientHeight`,
 * `.classList.add`, and `.querySelector`. Returning `null` from the query
 * is the same result `main.ts` gets in production when there's no touch UI.
 */
function createStubElement(): HTMLElement {
  const el = {
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
  return el as unknown as HTMLElement;
}

/** No-op renderer — satisfies the `RendererInterface` contract without
 *  touching canvas/DOM APIs. `drawFrame` is called every tick by the render
 *  subsystem; we simply ignore it. */
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

export async function createDebugFullRuntime(
  opts: DebugRuntimeOptions,
): Promise<DebugRuntime> {
  const {
    seed,
    gameMode = GAME_MODE_CLASSIC,
    rounds = 3,
    log = false,
  } = opts;

  // ── Mock clock + timer scheduling ──────────────────────────────────
  // All timing flows through this closure. `mainLoop` is driven manually
  // by `tick()`, so `requestFrame` is a no-op (tests don't want auto-scheduling).
  let clock = 0;
  let nextHandle = 1;
  const pendingTimeouts = new Map<
    number,
    { cb: () => void; fireAt: number }
  >();

  const timing: TimingApi = {
    now: () => clock,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      pendingTimeouts.set(handle, { cb: callback, fireAt: clock + ms });
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

  // ── Runtime construction ───────────────────────────────────────────
  const runtime = createGameRuntime({
    renderer,
    timing,
    keyboardEventSource,
    send: () => {},
    aiPick: aiPickUpgrade,
    getIsHost: () => true,
    getMyPlayerId: () => SPECTATOR_SLOT,
    getRemotePlayerSlots: () => new Set<number>(),
    log: log ? (msg: string) => console.log(`[debug] ${msg}`) : () => {},
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
  // runtimeState.lobby.joined, so we wire them up directly — no
  // need to go through the lobby UI flow.
  runtime.runtimeState.settings.seed = String(seed);
  runtime.runtimeState.settings.seedMode = SEED_CUSTOM;
  runtime.runtimeState.settings.gameMode = gameMode;
  runtime.runtimeState.lobby.seed = seed;
  // All-AI by default: no slots joined → every player is controlled by AI.
  // Tests that need humans can override after construction.

  // ── Sentinel warm-up ──────────────────────────────────────────────
  // `frameMeta` is initialized by `computeFrameContext` inside `mainLoop`.
  // startGame() indirectly touches frameMeta via resetUIState → render,
  // so we need one mainLoop tick (with mode=LOBBY, state=sentinel but
  // gated by `isStateReady`) to hydrate frameMeta before calling startGame.
  setMode(runtime.runtimeState, Mode.LOBBY);
  runtime.runtimeState.lastTime = clock;
  runtime.mainLoop(clock);

  await runtime.lifecycle.startGame();

  // ── Driver API ────────────────────────────────────────────────────
  function fireTimeouts(): void {
    for (const [handle, entry] of pendingTimeouts) {
      if (clock >= entry.fireAt) {
        pendingTimeouts.delete(handle);
        entry.cb();
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
