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

import { bootstrapFacade } from "../src/game/bootstrap-facade.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  LOBBY_TIMER,
} from "../src/shared/game-constants.ts";
import type { GameMap, Viewport } from "../src/shared/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../src/shared/overlay-types.ts";
import type {
  HapticsObserver,
  SoundObserver,
} from "../src/shared/system-interfaces.ts";

/** Test observer for the headless `network.send` seam. Receives every
 *  outbound message the runtime would broadcast through the production
 *  fan-out path, regardless of host vs. local mode (the headless
 *  `network.send` impl is otherwise a no-op). Mirrors the shape of the
 *  haptics / sound / render observers so the four test seams stay
 *  visually consistent. */
export interface NetworkObserver {
  sent?(msg: GameMessage): void;
}
import { NOOP_DEDUP_CHANNEL } from "../src/shared/phantom-types.ts";
import { SEED_CUSTOM } from "../src/shared/player-config.ts";
import { SPECTATOR_SLOT } from "../src/shared/player-slot.ts";
import type { GameMessage, ServerMessage } from "../src/shared/protocol.ts";
import { Mode } from "../src/shared/ui-mode.ts";
import { createGameRuntime } from "../src/runtime/runtime.ts";
import { setMode } from "../src/runtime/runtime-state.ts";
import type {
  GameRuntime,
  OnlinePhaseTicks,
  TimingApi,
} from "../src/runtime/runtime-types.ts";

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
  /** Initial speed multiplier (1..16, integer). Drives the sub-step loop
   *  in `mainLoop`. Tests use this to verify the dev speed mechanism. */
  speedMultiplier?: number;
  /** When false, skips the automatic `startGame()` call and leaves the
   *  runtime in lobby mode with `lobby.active = true`. Used by input tests
   *  that need to drive the lobby UI (slot joining, options menu) before
   *  the match begins. Defaults to true. */
  autoStartGame?: boolean;
  /** Test observer for the network seam. Receives every message the
   *  runtime would broadcast via `network.send`, regardless of whether
   *  the runtime is in host mode (the headless `network.send` is
   *  otherwise a no-op). Used by tests that assert on host fan-out
   *  payloads (checkpoints, action commands, watcher ticks) without
   *  spinning up a real WebSocket. */
  networkObserver?: NetworkObserver;
  /** Slots the runtime should treat as remote-controlled (i.e. driven by a
   *  peer machine, not by local AI). The headless network adapter exposes
   *  this set via `network.remotePlayerSlots()`, which gates AI controllers,
   *  selection ticks, life-lost prompts, and phase ticks throughout the
   *  runtime. Used by `test/online-headless.ts` so the dispatcher's writes
   *  to a "remote" player's selection state aren't immediately overwritten
   *  by that slot's local AI. Defaults to the empty set (every slot is
   *  local AI), preserving existing test behavior. */
  remotePlayerSlots?: ReadonlySet<number>;
  /** Test observer for haptics intents. Receives every `vibrate(reason, ms,
   *  minLevel)` call BEFORE the platform/level gate, so tests can assert on
   *  game-event → haptic mappings without a real `navigator.vibrate`. */
  hapticsObserver?: HapticsObserver;
  /** Test observer for sound intents. Receives every `played(reason)` call
   *  BEFORE the platform/level gate, so tests can assert on game-event →
   *  sound mappings without a real `AudioContext`. */
  soundObserver?: SoundObserver;
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
  /** Real `EventTarget` the keyboard handler is bound to. Tests dispatch
   *  `KeyboardEvent` instances here to drive the same code path the browser
   *  uses (`document.addEventListener("keydown", ...)`). */
  readonly keyboardEventSource: EventTarget;
  /** Real `EventTarget` the mouse + touch handlers are bound to (the
   *  renderer's canvas in production). Tests dispatch `MouseEvent` /
   *  `TouchEvent` instances here. */
  readonly pointerEventTarget: EventTarget;
  /** Deliver a fake peer message to every handler the runtime registered
   *  via `network.onMessage`. This is the in-memory loopback equivalent
   *  of a WebSocket frame arriving from a peer — handlers run through
   *  the same dispatch path the production code uses. Returns the
   *  combined promise of all handler invocations so tests can `await`
   *  the receive side before asserting on game state. */
  deliverNetworkMessage(msg: ServerMessage): Promise<void>;
  /** Register an additional receive-side handler outside the runtime's
   *  own `network.onMessage` subscriptions. Used by `test/online-headless.ts`
   *  to plug the production `handleServerMessage` dispatcher (which lives
   *  in `online/`, a layer the runtime cannot import) into the same
   *  delivery loop `deliverNetworkMessage` walks. Returns an unsubscribe
   *  function. */
  subscribeNetworkMessage(
    handler: (msg: ServerMessage) => void | Promise<void>,
  ): () => void;
}

/** Shared sentinel for the default `remotePlayerSlots` option — allocated
 *  once so the network adapter returns the same instance on every call
 *  (frame-meta consumers compare via `ReadonlySet.has`, not by reference,
 *  but reusing the instance avoids per-frame allocation in the no-remote
 *  default path). */
const EMPTY_REMOTE_SLOTS: ReadonlySet<number> = new Set();

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
    speedMultiplier,
    autoStartGame = true,
    networkObserver,
    remotePlayerSlots = EMPTY_REMOTE_SLOTS,
    hapticsObserver,
    soundObserver,
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
  // Real EventTarget so tests can dispatch keyboard events at the same source
  // the production browser path uses (`document` in main.ts). The cast widens
  // EventTarget to the Document subset the runtime injects — every method we
  // surface lives on EventTarget itself.
  const keyboardEventSource = new EventTarget() as unknown as Pick<
    Document,
    "addEventListener" | "removeEventListener"
  > & { dispatchEvent(event: Event): boolean };

  // ── Runtime construction ──────────────────────────────────────────
  // Forward-declared so the lobby callbacks (defined below the
  // `createGameRuntime` call) can reach into the constructed runtime.
  // The closures only fire after construction completes, so the holder
  // is always populated by the time they're invoked.
  const runtimeHolder: { current?: GameRuntime } = {};

  // Tracks every handler the runtime registers via `network.onMessage`.
  // Tests use `deliverNetworkMessage` (exposed on the HeadlessRuntime
  // return value) to deliver a fake peer message — same code path the
  // production WebSocket fan-out would hit.
  const messageHandlers = new Set<
    (msg: ServerMessage) => void | Promise<void>
  >();

  const runtime = createGameRuntime({
    renderer,
    timing,
    keyboardEventSource,
    network: {
      // The inner send is a no-op because there are no peers in single-
      // machine headless mode. When a test installs `networkObserver`,
      // it sees every outbound message the runtime would have broadcast,
      // which lets the test assert on host fan-out payloads (checkpoints,
      // action commands) without spinning up a real WebSocket.
      send: (msg) => networkObserver?.sent?.(msg),
      // In-memory loopback: track every handler the runtime registers,
      // and let tests inject messages via `deliverNetworkMessage(msg)`.
      // The future "machines" abstraction will turn this into a full
      // many-to-many delivery between peer headless runtimes; today it
      // exists so tests can drive the receive path with hand-crafted
      // peer messages.
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      amHost: () => true,
      myPlayerId: () => SPECTATOR_SLOT,
      // Returns the same Set instance every call — runtime sub-systems read
      // this as a ReadonlySet via `frameMeta.remotePlayerSlots`, never mutate.
      remotePlayerSlots: () => remotePlayerSlots as Set<number>,
    },
    // No ai wiring here (nor in main.ts / online-runtime-game.ts) — the
    // composition root `src/runtime/runtime.ts` imports the ai functions
    // directly and wires them into the dialog subsystems. Headless plays
    // the real game and observes picks via bus events, same as production.
    log: log ? (msg: string) => console.log(`[headless] ${msg}`) : () => {},
    logThrottled: () => {},
    // Real countdown so the lobby tick can detect expiry. Production main.ts
    // computes the same value (Math.max(0, LOBBY_TIMER - timerAccum)). When
    // `autoStartGame: true` the lobby phase is bypassed before the first
    // tick, so the value is unobservable in that path.
    getLobbyRemaining: () =>
      Math.max(
        0,
        LOBBY_TIMER -
          (runtimeHolder.current?.runtimeState.lobby.timerAccum ?? 0),
      ),
    getUrlRoundsOverride: () => rounds,
    getUrlModeOverride: () =>
      gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    showLobby: () => {},
    // Mirrors main.ts:73 — when a slot is joined (key or mouse), mark it
    // in `lobby.joined` so `tickLobby`'s `allJoined` check can detect when
    // every joined human has confirmed and start the game without waiting
    // for the full timeout.
    onLobbySlotJoined: (pid) => {
      const built = runtimeHolder.current;
      if (!built) return;
      built.runtimeState.lobby.joined[pid] = true;
    },
    // Mirrors main.ts:80 — when the lobby timer expires (or all slots
    // joined), bootstrap the game and enter castle selection. Tests that
    // exercise lobby input rely on this so a click-to-join → game-start
    // flow runs end-to-end through the real handlers.
    onTickLobbyExpired: async () => {
      const built = runtimeHolder.current;
      if (!built) return;
      await built.lifecycle.startGame();
      setMode(built.runtimeState, Mode.SELECTION);
    },
    onlinePhaseTicks: hostMode ? noopHostPhaseTicks() : undefined,
    observers:
      hapticsObserver || soundObserver
        ? { haptics: hapticsObserver, sound: soundObserver }
        : undefined,
  });
  runtimeHolder.current = runtime;

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

  if (autoStartGame) {
    await runtime.lifecycle.startGame();
  } else {
    // Stay in lobby mode for tests that need to drive the lobby UI through
    // real input handlers. `lobby.active = true` is what `lobbyClick` and
    // `lobbyKeyJoin` gate on; the production browser path sets it via
    // `bootstrapNewGame` (runtime-bootstrap.ts:109). The joined array is
    // already initialized to all-false in `createRuntimeState`.
    runtime.runtimeState.lobby.active = true;
  }

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

  async function deliverNetworkMessage(msg: ServerMessage): Promise<void> {
    // Snapshot the handler set so a handler that unsubscribes mid-delivery
    // doesn't perturb the iteration. Handlers run sequentially in
    // registration order to match the production WebSocket fan-out.
    const handlers = [...messageHandlers];
    for (const handler of handlers) {
      await handler(msg);
    }
  }

  function subscribeNetworkMessage(
    handler: (msg: ServerMessage) => void | Promise<void>,
  ): () => void {
    messageHandlers.add(handler);
    return () => {
      messageHandlers.delete(handler);
    };
  }

  return {
    runtime,
    now: () => clock,
    runUntil,
    runGame,
    keyboardEventSource: keyboardEventSource as unknown as EventTarget,
    pointerEventTarget: renderer.eventTarget as unknown as EventTarget,
    deliverNetworkMessage,
    subscribeNetworkMessage,
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

/** No-op renderer satisfying `RendererInterface` without canvas/DOM access.
 *
 *  The `eventTarget` is a real `EventTarget` so tests can drive the runtime
 *  through the production input handlers (`registerMouseHandlers`,
 *  `registerTouchHandlers`) by dispatching `MouseEvent` / `TouchEvent`
 *  instances at it. The default `clientToSurface` is the identity, so a test
 *  that dispatches a click at `(canvasX, canvasY)` lands on that exact tile
 *  — no letterbox/DPR math needed in headless. */
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
    clientToSurface: (clientX: number, clientY: number) => ({
      x: clientX,
      y: clientY,
    }),
    screenToContainerCSS: (sx: number, sy: number) => ({ x: sx, y: sy }),
    eventTarget,
    container,
  };
}

/**
 * Minimal `HTMLElement` stub. Backed by a real `EventTarget` so production
 * input handlers can attach listeners and tests can dispatch events at the
 * same surface. Carries the few non-event properties the runtime touches:
 *   - `clientHeight` / `clientWidth` (camera, layout)
 *   - `classList.{add,remove,contains,toggle}` (mode toggles in main.ts)
 *   - `querySelector` (touch UI lookup, returns null)
 *   - `style.cursor` (input-mouse writes this on every mousemove)
 */
function createStubElement(): HTMLElement {
  const target = new EventTarget();
  const props = {
    clientHeight: 720,
    clientWidth: 1280,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    style: { cursor: "default" },
  };
  return Object.assign(target, props) as unknown as HTMLElement;
}
