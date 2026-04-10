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

import { bootstrapFacade } from "../game/bootstrap-facade.ts";
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
import { NOOP_DEDUP_CHANNEL } from "../shared/phantom-types.ts";
import { SEED_CUSTOM } from "../shared/player-config.ts";
import { SPECTATOR_SLOT, type ValidPlayerSlot } from "../shared/player-slot.ts";
import type { GameState } from "../shared/types.ts";
import { Mode } from "../shared/ui-mode.ts";
import type { UpgradeId } from "../shared/upgrade-defs.ts";
import { createGameRuntime } from "./runtime.ts";
import { setMode } from "./runtime-state.ts";
import type {
  GameRuntime,
  OnlinePhaseTicks,
  TimingApi,
} from "./runtime-types.ts";

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
  /** When true, the runtime is wired in "online host" mode: it constructs a
   *  no-op `OnlinePhaseTicks` so every host fan-out hook fires (broadcasts go
   *  to /dev/null, dedup channels are NOOP, watcher hooks unset). Used by the
   *  host-vs-local sync test to verify the online code path produces the same
   *  state as the local one. The runtime never receives any messages because
   *  there are no peers. */
  hostMode?: boolean;
  /** Optional renderer override. When provided, replaces the default no-op
   *  stub renderer — used by tests that need the real draw pipeline to fire
   *  (e.g. for `RenderObserver` assertions). The caller is responsible for
   *  installing the canvas factory before constructing the renderer. */
  renderer?: RendererInterface;
  /** Optional AI upgrade picker. Defaults to "always pick the first offer"
   *  for simple deterministic tests. Pass `aiPickUpgrade` from `src/ai/`
   *  to match the production browser path — this is what makes seed-based
   *  modifier sequences in headless line up with what a browser session
   *  with the same seed would produce. (Domain rule: runtime/ cannot import
   *  from ai/, so the test layer injects it.) */
  aiPick?: (
    offers: readonly [UpgradeId, UpgradeId, UpgradeId],
    state: GameState,
    playerId: ValidPlayerSlot,
  ) => UpgradeId;
  /** Initial speed multiplier (1..16, integer). Drives the sub-step loop
   *  in `mainLoop`. Tests use this to verify the dev speed mechanism. */
  speedMultiplier?: number;
}

export interface HeadlessRuntime {
  readonly runtime: GameRuntime;
  /** Current mock clock (ms). */
  now(): number;
  /** Drive the simulation until `predicate` returns true or `maxFrames`
   *  reached. Returns the number of frames taken, or -1 if the predicate
   *  never fired. */
  runUntil(predicate: () => boolean, maxFrames?: number, dtMs?: number): number;
  /** Drive the simulation until `mode === STOPPED` (game over) or
   *  `maxFrames` reached. */
  runGame(maxFrames?: number, dtMs?: number): void;
}

export async function createHeadlessRuntime(
  opts: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  const {
    seed,
    gameMode = GAME_MODE_CLASSIC,
    rounds = 3,
    log = false,
    hostMode = false,
    renderer: rendererOverride,
    aiPick = (offers) => offers[0],
    speedMultiplier,
  } = opts;

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

  const renderer = rendererOverride ?? createStubRenderer();
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
      // No peers in single-machine headless mode. The future "machines"
      // abstraction will replace this with an in-memory loopback that
      // delivers messages from a peer machine's `send` to this `onMessage`.
      onMessage: () => () => {},
      amHost: () => true,
      myPlayerId: () => SPECTATOR_SLOT,
      remotePlayerSlots: () => new Set<number>(),
    },
    // Default: always take the first offer. Tests opt into the real
    // `aiPickUpgrade` (from ai/) by passing `aiPick: aiPickUpgrade` — that's
    // what makes seed-based modifier sequences in headless line up with the
    // browser. (Domain rule: runtime/ cannot import from ai/.)
    aiPick,
    log: log ? (msg: string) => console.log(`[headless] ${msg}`) : () => {},
    logThrottled: () => {},
    getLobbyRemaining: () => 0,
    getUrlRoundsOverride: () => rounds,
    getUrlModeOverride: () =>
      gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    showLobby: () => {},
    onLobbySlotJoined: () => {},
    onTickLobbyExpired: async () => {},
    onlinePhaseTicks: hostMode ? noopHostPhaseTicks() : undefined,
  });

  // ── Seed injection ────────────────────────────────────────────────
  // bootstrapNewGameFromSettings reads runtimeState.lobby.seed and
  // runtimeState.lobby.joined, so we wire them up directly — no need
  // to go through the lobby UI flow. All slots stay un-joined → all AI.
  // Hydrate lobby.map immediately so the warm-up tick (which dispatches to
  // the LOBBY tick → renderLobby) has a real map to render. In production
  // main.ts goes through showLobby() → refreshLobbySeed() to get this; we
  // short-circuit by calling bootstrapFacade.generateMap directly. Skipping
  // this is invisible to the no-op stub renderer but crashes drawTerrain
  // when a real renderer is wired in via `opts.renderer`.
  runtime.runtimeState.settings.seed = String(seed);
  runtime.runtimeState.settings.seedMode = SEED_CUSTOM;
  runtime.runtimeState.settings.gameMode = gameMode;
  runtime.runtimeState.lobby.seed = seed;
  runtime.runtimeState.lobby.map = bootstrapFacade.generateMap(seed);

  // ── Sentinel warm-up ──────────────────────────────────────────────
  // `frameMeta` is initialized by `computeFrameContext` inside `mainLoop`.
  // startGame() indirectly touches frameMeta via resetUIState → render,
  // so we need one mainLoop tick (mode=LOBBY, state=sentinel but gated
  // by `isStateReady`) to hydrate frameMeta before calling startGame.
  setMode(runtime.runtimeState, Mode.LOBBY);
  runtime.runtimeState.lastTime = clock;
  runtime.mainLoop(clock);

  await runtime.lifecycle.startGame();

  // Apply optional speed multiplier — must happen AFTER startGame because
  // startGame() calls resetAll() which resets speedMultiplier back to 1.
  if (speedMultiplier !== undefined) {
    runtime.runtimeState.speedMultiplier = speedMultiplier;
  }

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
    runUntil,
    runGame,
  };
}

/** Build a no-op `OnlinePhaseTicks` for headless host mode. Every broadcast
 *  is a black hole, every getter returns the empty/noop equivalent, no
 *  watcher fields are set (this machine is host-only). */
function noopHostPhaseTicks(): OnlinePhaseTicks {
  return {
    broadcastCannonStart: () => {},
    broadcastBattleStart: () => {},
    broadcastBuildStart: () => {},
    broadcastBuildEnd: () => {},
    broadcastLocalCrosshair: () => {},
    remoteCannonPhantoms: () => [],
    remotePiecePhantoms: () => [],
    cannonPhantomDedup: () => NOOP_DEDUP_CHANNEL,
    piecePhantomDedup: () => NOOP_DEDUP_CHANNEL,
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
    // tickWatcher / watcherTiming intentionally omitted — host-only stub.
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
