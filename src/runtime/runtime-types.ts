/**
 * Public interfaces for the game runtime factory.
 *
 * Separated from runtime-composition.ts to keep the implementation file focused
 * on the factory closure, and to let consumers import just the types.
 *
 * ### Sub-system deps convention (all runtime-*.ts files)
 *
 * Each sub-system factory (`createXxxSystem(deps)`) follows:
 *   - Destructure `runtimeState` (and a few frequently-used deps) at the factory top.
 *   - Access other deps inline as `deps.xxx` — avoids stale captures and makes
 *     the dependency explicit at each call site.
 *   - Deps interfaces use getters/closures for late binding (e.g. `getState()`).
 *   - Sub-systems must not import from each other, only from runtime-types.ts
 *     and runtime-state.ts.
 *
 * State access patterns by sub-system:
 *   STANDARD (destructure runtimeState at top):
 *     runtime-banner.ts, runtime-human.ts, runtime-input.ts,
 *     runtime-life-lost.ts, runtime-lobby.ts, runtime-options.ts,
 *     runtime-phase-ticks.ts, runtime-render.ts, runtime-score-deltas.ts,
 *     runtime-selection.ts, runtime-upgrade-pick.ts
 *   BUILDER (runtimeState passed to dep-builder, not to orchestrator):
 *     runtime-game-lifecycle.ts — buildLifecycleDeps receives runtimeState,
 *     createGameLifecycle only sees its deps interface.
 *   ALL-GETTERS (no runtimeState access — late-bind everything):
 *     runtime-camera.ts — camera state can change during host migration,
 *     so every field must be re-read via getter to avoid stale values.
 *
 * For new sub-systems, prefer the standard `runtimeState` + inline deps pattern.
 * Only use all-getters if the sub-system's state is mutated externally (e.g. host migration).
 *
 * ### Overlay mutation patterns
 *
 * Three patterns exist for updating the render overlay:
 *   PERSISTENT (game phases): Mutate runtimeState.overlay.X in-place, then call render().
 *     Examples: selection highlighting, phase banners, battle overlays.
 *   TRANSIENT (modal screens): Create a fresh overlay via factory, pass to renderFrame().
 *     Examples: lobby, options, controls screens.
 *   INPUT-DELEGATED: input handlers call dispatch functions that internally call render.
 *
 * When adding a new UI modal, use the TRANSIENT pattern. Only game-phase overlays
 * that need to persist across ticks should use PERSISTENT.
 *
 * ### Sentinel state guard (all runtime-*.ts sub-systems)
 *
 * `runtimeState.state` and `runtimeState.frameCtx` start as SENTINEL Proxy
 * objects that throw on ANY property access (see runtime-state.ts).
 * They are replaced with real values only after `startGame()`.
 *
 * Sub-system methods run exclusively from game-loop code after startGame(),
 * so they safely access runtimeState.state/frameCtx without null checks.
 * Do NOT call sub-system methods before startGame() completes — the sentinel
 * will throw "runtimeState.state accessed before initialization".
 *
 * For code that MAY run before init (render, input), use:
 *   - `safeState(runtimeState)` → GameState | undefined
 *   - `isStateReady(runtimeState)` → boolean guard
 */

import type { BattleStartData } from "../protocol/checkpoint-data.ts";
import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import type { BalloonFlight, Crosshair } from "../shared/core/battle-types.ts";
import type {
  GameMap,
  Viewport,
  WorldPos,
} from "../shared/core/geometry-types.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
import type {
  PlayerSlotId,
  ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import type {
  BattleController,
  BattleViewState,
  BuildController,
  BuildViewState,
  CannonController,
  CannonViewState,
  ControllerIdentity,
  HapticsObserver,
  InputReceiver,
  MusicObserver,
  SfxObserver,
} from "../shared/core/system-interfaces.ts";
import type { GameState, SelectionState } from "../shared/core/types.ts";
import type {
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type {
  RendererInterface,
  SceneCapture,
} from "../shared/ui/overlay-types.ts";
import type { BannerShow } from "./runtime-contracts.ts";
import type { RuntimeState } from "./runtime-state.ts";

export type { FrameContext } from "../shared/core/types.ts";

/** Summary of what happened at the end of a build phase. Built by the
 *  runtime, consumed by `OnlinePhaseTicks.broadcastBuildEnd` to construct
 *  the BUILD_END checkpoint payload. */
export interface BuildEndSummary {
  needsReselect: readonly ValidPlayerSlot[];
  eliminated: readonly ValidPlayerSlot[];
  scores: readonly number[];
}

/** Online-only per-frame coordination consumed by runtime-phase-ticks.ts.
 *
 *  Every field is INDEPENDENTLY OPTIONAL — the runtime checks for presence
 *  and silently skips when missing. Tests can wire host-only or watcher-only
 *  subsets, and production wiring (online-runtime-game.ts) supplies all of
 *  them so a single instance can act as either role across host migration.
 *
 *  Role gating happens at the call site in runtime-phase-ticks.ts:
 *    - Host-only fields are guarded by `frameMeta.hostAtFrameStart`.
 *    - Watcher-only fields are guarded by its negation.
 *    - "Both" fields are called unconditionally.
 *  The hooks themselves do not branch on role, so the wiring closures stay
 *  pure with respect to host/watcher state and remain reusable across host
 *  promotion / demotion without any internal `isHost` checks.
 *
 *  When undefined on RuntimeConfig, the runtime runs in single-machine local
 *  mode (main.ts, test/runtime-headless.ts) and never invokes any of these. */
export interface OnlinePhaseTicks {
  // ── Host-only: phase-transition checkpoint broadcasts ──────────────────
  /** Host: broadcast the cannon-phase entry checkpoint to watchers. */
  broadcastCannonStart?: (state: GameState) => void;
  /** Host: broadcast the battle-phase entry checkpoint, including the
   *  resolved balloon flights and the optional modifier diff. */
  broadcastBattleStart?: (
    state: GameState,
    flights: readonly BalloonFlight[],
    modifierDiff?: BattleStartData["modifierDiff"],
  ) => void;
  /** Host: broadcast the build-phase entry checkpoint to watchers. */
  broadcastBuildStart?: (state: GameState) => void;
  /** Host: broadcast the end-of-build summary (lives lost + eliminations
   *  + scores). The hook serializes the post-build player snapshot itself
   *  — the runtime does not need to know how to serialize players. */
  broadcastBuildEnd?: (state: GameState, summary: BuildEndSummary) => void;

  // ── Host-only: per-controller crosshair fan-out ────────────────────────
  /** Host: broadcast a single local controller's crosshair to watchers
   *  (typically deduped by aim target). Called once per local controller
   *  per frame from `syncCrosshairs`. */
  broadcastLocalCrosshair?: (
    ctrl: ControllerIdentity,
    crosshair: { x: number; y: number },
    cannonReady: boolean,
  ) => void;

  // ── Host-only: per-frame phantom dedup ─────────────────────────────────
  /** Host: pending remote cannon phantoms to merge into the local frame. */
  remoteCannonPhantoms?: () => readonly CannonPhantom[];
  /** Host: pending remote piece phantoms to merge into the local frame. */
  remotePiecePhantoms?: () => readonly PiecePhantom[];
  /** Host: check-then-update for outgoing cannon-phantom broadcasts. Returns
   *  true if the runtime should emit (key differs from last send for this
   *  player). Implementation owns the dedup storage and its lifecycle across
   *  host migration — the runtime just asks yes/no per phantom. */
  shouldSendCannonPhantom?: (playerId: ValidPlayerSlot, key: string) => boolean;
  /** Host: check-then-update for outgoing piece-phantom broadcasts. Same
   *  contract as `shouldSendCannonPhantom`. */
  shouldSendPiecePhantom?: (playerId: ValidPlayerSlot, key: string) => boolean;

  // ── Watcher-only: per-frame state apply ────────────────────────────────
  /** Watcher: drive the per-frame state apply (replaces the host tick on
   *  non-host machines). Implementation lives entirely in `online/`. */
  tickWatcher?: (dt: number) => void;
  /** Watcher: record the battle-countdown start so the non-host display can
   *  sync to it. Called unconditionally from `beginBattle`; host wiring is a
   *  no-op (host drives its own countdown via `state.battleCountdown`). */
  watcherBeginBattle?: (nowMs: number) => void;

  // ── Both roles: cross-machine merging ──────────────────────────────────
  /** Both: extend the locally collected crosshair list with remote-human
   *  crosshairs. Called from `syncCrosshairs` after the local pass. */
  extendCrosshairs?: (
    crosshairs: readonly Crosshair[],
    dt: number,
  ) => Crosshair[];
  /** Both: per-frame migration-announcement timer. Displays the
   *  post-host-migration banner without overwriting game announcements. */
  tickMigrationAnnouncement?: (dt: number) => void;
}

/** Online-only action wrappers that send-on-success. Each function executes
 *  the local action AND broadcasts the result to peers if applicable.
 *
 *  When this is undefined (local play), the input system installs local
 *  fallbacks in `assembly.ts:createRuntimeInputAdapters` that just execute
 *  the action without sending — the "AndSend" suffix is a misnomer in that
 *  case but kept for symmetry with the online versions. */
export interface OnlineActions {
  /** Send aim_update for the local pointer's crosshair (deduped). */
  maybeSendAimUpdate: (x: number, y: number) => void;
  /** Try to place a cannon; on success, broadcast OPPONENT_CANNON_PLACED. */
  tryPlaceCannonAndSend: (
    ctrl: ControllerIdentity & CannonController & InputReceiver,
    gameState: CannonViewState,
    max: number,
  ) => boolean;
  /** Try to place a piece; on success, broadcast OPPONENT_PIECE_PLACED. */
  tryPlacePieceAndSend: (
    ctrl: ControllerIdentity & BuildController & InputReceiver,
    gameState: BuildViewState,
  ) => boolean;
  /** Fire a cannon; on success, broadcast CANNON_FIRED. */
  fireAndSend: (ctrl: BattleController, gameState: BattleViewState) => void;
}

/** Network seam for a single runtime instance ("machine"). NetworkApi is
 *  intentionally minimal — it covers the two transport primitives (`send`,
 *  `onMessage`) plus the read-only identity queries that tell sub-systems
 *  who-is-this-machine. It does NOT contain game-action wrappers, checkpoint
 *  serializers, watcher tick drivers, or any other higher-level orchestration:
 *  those belong in domain-specific deps bags, not in the network seam.
 *
 *  All cross-machine communication that the runtime initiates or observes
 *  flows through this interface. Sub-systems must not reach for sockets,
 *  sessions, or remote-player state directly.
 *
 *  Production wiring:
 *    - Local play (main.ts): no-op `send` and `onMessage`, always host,
 *      spectator slot, empty remote set.
 *    - Online (online-runtime-game.ts): WebSocket `send`, fan-out
 *      `onMessage`, host/slot/remote state read from `ctx.session`.
 *    - Tests (test/runtime-headless.ts): no-op send + spectator slot today.
 *      A future "machines" abstraction will wire multiple NetworkApi
 *      instances together via an in-memory message bus, exercising the
 *      same dispatch path as production without a real WebSocket.
 *
 *  `amHost` (not `isHost`) sidesteps the eslint rule banning direct
 *  `.isHost` property access — that rule exists because the session's
 *  `isHost` field is volatile and must never be cached. Reading
 *  `network.amHost()` is always fresh. The other getters (`myPlayerId`,
 *  `remotePlayerSlots`) use plain noun form since they carry no eslint
 *  constraint.
 */
export interface NetworkApi {
  /** Send a message from this machine to its peers. */
  readonly send: (msg: GameMessage) => void;
  /** Subscribe to incoming messages from peers. Returns an unsubscribe
   *  function. Multiple subscribers are supported — the delivery
   *  implementation fans out in registration order and awaits each handler.
   *
   *  Production: WebSocket onmessage routes through the implementation.
   *  Local play: no-op (no peers exist).
   *  Tests/loopback: in-memory delivery between machines in the same
   *  scenario, exercising the same code path the WebSocket would. */
  readonly onMessage: (
    handler: (msg: ServerMessage) => void | Promise<void>,
  ) => () => void;
  /** Whether this machine currently acts as host. May change after host
   *  migration — read fresh, do not cache. Used at frame start to snapshot
   *  hostAtFrameStart. For runtime volatile checks in tick/handler code,
   *  use isHostInContext(net) from tick-context.ts instead. */
  readonly amHost: () => boolean;
  /** This client's player slot in online mode, or SPECTATOR_SLOT (-1) in
   *  local (shared-screen) mode. Only meaningful for online play — local
   *  consumers should use povPlayerId instead. */
  readonly myPlayerId: () => PlayerSlotId;
  /** Slots controlled by other machines (need network sync). Empty set
   *  for local play. */
  readonly remotePlayerSlots: () => ReadonlySet<ValidPlayerSlot>;
}

/** Injected timing primitives. Production callers (main.ts, online-runtime-game.ts)
 *  bind to `performance.now`, `setTimeout`, `clearTimeout`, `requestAnimationFrame`.
 *  Tests pass deterministic stubs or Deno's natives. Following the project's
 *  "DOM/global helpers as deps" rule — no runtime sub-system should reach for
 *  these globals directly. */
export interface TimingApi {
  /** Monotonic timestamp source — produces frame timestamps used by render
   *  animations, dedup channels, and lobby/banner timers. Must be monotonic
   *  within a single runtime instance. */
  readonly now: () => number;
  /** Schedule a one-shot callback after `ms` milliseconds. Returns a handle
   *  that can be passed to `clearTimeout`. */
  readonly setTimeout: (callback: () => void, ms: number) => number;
  /** Cancel a previously scheduled timeout. */
  readonly clearTimeout: (handle: number) => void;
  /** Schedule a callback to run before the next browser paint. Same signature
   *  as `window.requestAnimationFrame` — the `now` argument is a high-resolution
   *  timestamp. Tests pass a synchronous trampoline or no-op (since headless
   *  tests drive the main loop manually). */
  readonly requestFrame: (callback: (now: number) => void) => void;
}

export interface RuntimeConfig {
  renderer: RendererInterface;
  /** Injected timing primitives — see `TimingApi`. */
  timing: TimingApi;
  /** DOM event source for keyboard listeners. Production passes `document`;
   *  tests pass a stub. Only entry points should touch the real `document`. */
  keyboardEventSource: Pick<
    Document,
    "addEventListener" | "removeEventListener"
  >;
  /** Network seam — see `NetworkApi`. Sub-systems read all transport
   *  primitives (send, onMessage) and identity state (host, slot, remote
   *  players) through this bag rather than via scattered config fields. */
  network: NetworkApi;
  /** noop for local. */
  log: (msg: string) => void;
  /** noop for local. */
  logThrottled: (key: string, msg: string) => void;
  /** Different formula per mode. */
  getLobbyRemaining: () => number;
  /** URL-based rounds override (e.g. ?rounds=3). 0 = no override. */
  getUrlRoundsOverride: () => number;
  /** URL-based game mode override (e.g. ?mode=modern). Empty = no override. */
  getUrlModeOverride?: () => string;
  /** Each mode provides its own. */
  showLobby: () => void;
  /** local: set joined; online: send select_slot. */
  onLobbySlotJoined: (pid: ValidPlayerSlot) => void;
  /** Optional extra action on close (e.g., reset timer). */
  onCloseOptions?: () => void;
  /** local: startGame; online: host sends init. */
  onTickLobbyExpired: () => void | Promise<void>;

  /** Online-only per-frame coordination (host fan-out + watcher tick).
   *  See `OnlinePhaseTicks`. Presence on RuntimeConfig implies online mode. */
  onlinePhaseTicks?: OnlinePhaseTicks;
  /** Online-only action wrappers consumed by the input dispatcher.
   *  See `OnlineActions`. When undefined, local fallbacks are installed
   *  in `assembly.ts:createRuntimeInputAdapters`. */
  onlineActions?: OnlineActions;
  /** Online-only game-over broadcast hook. Fires once when the game ends,
   *  before the frame's gameOver payload is set. */
  onEndGame?: (winner: { id: number }, state: GameState) => void;

  /** Test-only sub-system observers. Threaded from the test scenario
   *  through `createHeadlessRuntime` so tests can capture intents
   *  (haptics, render) without monkey-patching module state.
   *  Production callers (`main.ts`, `online-runtime-game.ts`) omit
   *  this entirely. */
  observers?: {
    haptics?: HapticsObserver;
    music?: MusicObserver;
    sfx?: SfxObserver;
  };
}

export interface CameraSystem {
  // Per-frame lifecycle
  tickCamera: () => void;
  updateViewport: () => Viewport | undefined;

  // Coordinate conversion
  getViewport: () => Viewport | undefined;
  /** Current camera pitch in radians (animated on phase transitions). 3D mode
   *  only — 2D mode always returns 0. */
  getPitch: () => number;
  /** Request an immediate pitch=0 ease. Idempotent. Currently subsumed
   *  by `requestUnzoom` (which flattens as part of its contract) — kept
   *  for possible "untilt without unzoom" call sites. */
  beginUntilt: () => void;
  /** Start the build→battle tilt animation. Called explicitly at
   *  battle-banner end so the tilt plays unzoomed, before balloons /
   *  "ready" / auto-zoom into the battle zone. 2D mode: no-op. */
  beginBattleTilt: () => void;
  /** Pitch-animation state machine value. `"flat"` / `"tilted"` are
   *  resting states; `"tilting"` / `"untilting"` indicate an in-progress
   *  ease. 2D mode always returns `"flat"`. Subscribers that want the
   *  settle edge (not the polled state) should listen for
   *  `GAME_EVENT.PITCH_SETTLED` instead. */
  getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
  screenToWorld: (x: number, y: number) => WorldPos;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  pixelToTile: (x: number, y: number) => { row: number; col: number };

  // Pinch gesture handlers
  onPinchStart: (midX: number, midY: number) => void;
  onPinchUpdate: (midX: number, midY: number, scale: number) => void;
  onPinchEnd: () => void;

  // Zone queries
  povPlayerId: () => number;
  getMyZone: () => number | null;
  getBestEnemyZone: () => number | null;
  getEnemyZones: () => number[];

  // Zone bounds (used by advanceToCannonPhase for score delta positions)
  computeZoneBounds: (zoneId: number) => Viewport;

  // Zoom state
  getCameraZone: () => number | undefined;
  setCameraZone: (zone: number | undefined) => void;

  // Lifecycle commands
  /** Phase unzoom: clear cameraZone + pinchVp only (preserves per-phase memory for autoZoom restore). */
  clearPhaseZoom: () => void;
  /** Pre-transition unzoom with a post-convergence callback. Saves the
   *  current pinch into the phase slot, clears zoom targets so
   *  currentVp lerps to fullMapVp, and fires `onReady` on the first
   *  frame whose drawFrame ran at fullMapVp. `captureScene()` called
   *  inside the callback therefore reads full-map pixels. */
  requestUnzoom: (onReady: () => void) => void;
  /** Post-render hook — called by the render loop after drawFrame.
   *  Fires any pending `requestUnzoom` callback when the viewport has
   *  converged to fullMapVp. */
  onRenderedFrame: () => void;
  /** Full unzoom: clear all zoom state for returnToLobby/endGame. */
  clearAllZoomState: () => void;
  /** Full reset for rematch. */
  resetCamera: () => void;

  // Castle build viewport
  setSelectionViewport: (towerRow: number, towerCol: number) => void;
  setCastleBuildViewport: (
    wallPlans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
  ) => void;
  clearCastleBuildViewport: () => void;

  // Mobile zoom
  enableMobileZoom: () => void;
  /** Re-engage the current phase's auto-zoom. Used at life-lost popup
   *  time (spec: `scores → zoom → life lost popup`). No-op when
   *  auto-zoom is disabled. */
  engageAutoZoom: () => void;
  /** Permanently disable auto-zoom for the rest of the match. Called
   *  when the pov player abandons or is eliminated — the camera then
   *  sits at fullMapVp as a static spectator view. `resetCamera`
   *  re-arms it. */
  disableAutoZoom: () => void;
  isMobileAutoZoom: () => boolean;

  // Touch battle targeting
  /** Compute target position for human crosshair at battle start (touch devices).
   *  Returns null when no target is applicable. Caller applies to controller. */
  computeBattleTarget: () => { x: number; y: number } | null;
  /** Store a crosshair position for restoration at the next battle start. */
  saveBattleCrosshair: (pos: { x: number; y: number }) => void;
  /** Clear saved crosshair (called on resetUIState). */
  resetBattleCrosshair: () => void;
}

export interface RuntimeSelection {
  getStates: () => Map<number, SelectionState>;
  enter: () => void;
  syncOverlay: () => void;
  highlight: (idx: number, zone: number, pid: ValidPlayerSlot) => void;
  confirmAndStartBuild: (pid: ValidPlayerSlot, isReselect?: boolean) => boolean;
  allConfirmed: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  setCastleBuildViewport: (
    plans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
  ) => void;
  startReselection: () => void;
  finishReselection: () => void;
  /** Full reset for game restart / rematch. */
  reset: () => void;
}

/**
 * Dialog/animation completion callback patterns — three distinct approaches by design:
 *
 * | System       | Storage            | Invocation       | Reason                             |
 * |--------------|--------------------|------------------|------------------------------------|
 * | ScoreDelta   | runtimeState field | fireOnce()       | Ticks mode-independently (banner)  |
 * | LifeLost     | method on system   | onResolved()     | Multi-path (game-over/reselect/go) |
 * | UpgradePick  | local closure      | tryShow(onDone)  | Single-path (resume build banner)  |
 *
 * For new dialogs: use the UpgradePick closure pattern (simplest) unless the dialog
 * has multiple resolution paths (use LifeLost method) or must tick during banners
 * (use ScoreDelta runtimeState pattern).
 */
export interface RuntimeScoreDelta {
  /** Show animated score deltas after build phase. `onDone` is invoked exactly once
   *  when the animation finishes (or immediately if there are no deltas to show).
   *  Stored on runtimeState — timer ticks mode-independently (during banner/castle-build). */
  show: (onDone: () => void) => void;
  /** Set pre-scores directly (online watcher receives them from host). */
  setPreScores: (scores: readonly number[]) => void;
}

export interface RuntimeLifeLost {
  /** Read current dialog state. Used by watcher-mode to sync overlay display. */
  get: () => LifeLostDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
  set: (d: LifeLostDialogState | null) => void;
  /** Show life-lost dialog. Returns false if all entries were pre-resolved (dialog skipped). */
  tryShow: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => boolean;
  tick: (dt: number) => void;
  /** Resolve life-lost outcome (life-lost only — multi-path).
   *  May end game, start reselection, or advance to cannon phase.
   *  No callback param — resolution logic is internal to the system. */
  onResolved: (continuing?: readonly ValidPlayerSlot[]) => boolean;
  panelPos: (playerId: ValidPlayerSlot) => { px: number; py: number };
}

export interface RuntimeUpgradePick {
  /** Read current dialog state. Used by watcher-mode to sync overlay display. */
  get: () => UpgradePickDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
  set: (dialog: UpgradePickDialogState | null) => void;
  /** Show upgrade pick dialog. Returns false if no offers (dialog skipped).
   *  `onDone` stored in a local closure — single path (resume build-phase banner). */
  tryShow: (onDone: () => void) => boolean;
  tick: (dt: number) => void;
  /** Pre-create dialog for progressive reveal during banner sweep (upgrade-pick only).
   *  Does NOT activate Mode.UPGRADE_PICK — call tryShow() after the banner ends. */
  prepare: () => boolean;
}

export interface RuntimeLobby {
  renderLobby: () => void;
}

export interface RuntimeLifecycle {
  startGame: () => Promise<void>;
  /** Full reset + fresh bootstrap — production-equivalent to the rematch
   *  button on the game-over screen. Clears game-over / demo-timer state,
   *  then calls `startGame`. Tests use this via `sc.rematch()` to drive
   *  the "finish game 1, start game 2 on the same runtime" path. */
  rematch: () => void | Promise<void>;
  resetUIState: () => void;
}

export interface RuntimePhaseTicks {
  startCannonPhase: () => void;
  beginBattle: () => void;
  /** Subscribe the runtime's stats accumulator to the current `state.bus`.
   *  Must be called after each new-game `setState` so rematches rebind to
   *  the fresh bus. */
  subscribeBusObservers: () => void;
}

/** Narrow handle exposed to the app shell so the home-page "Play" button can
 *  pre-warm audio from within a user-gesture handler, and the lobby entry can
 *  start the title track before any game bus exists. */
export interface RuntimeMusic {
  /** Kick off WASM + AudioContext init inside the click handler, before the
   *  subsystem is bound to a bus. No-op if Rampart files aren't in IDB yet. */
  activate(): Promise<void>;
  /** Start the title track. Called from `enterLocalLobby` so music covers the
   *  pre-game lobby screen (the bus-based stop-on-WALL_BUILD subscription
   *  happens separately inside the runtime when a game starts). */
  startTitle(): Promise<void>;
}

/** Narrow handle for the SFX sub-system. Parallel to RuntimeMusic so the
 *  home-page "Play" click can pre-warm the SFX AudioContext at the same
 *  time as the music synth. */
export interface RuntimeSfx {
  /** Create + resume the SFX AudioContext and decode SOUND.RSC. No-op if
   *  the player hasn't loaded their Rampart files yet. */
  activate(): Promise<void>;
}

export interface GameRuntime {
  /** Mutable runtime state — direct property access replaces getter/setter pairs. */
  runtimeState: RuntimeState;

  // --- Sub-system handles ---
  selection: RuntimeSelection;
  lifeLost: RuntimeLifeLost;
  upgradePick: RuntimeUpgradePick;
  scoreDelta: RuntimeScoreDelta;
  lobby: RuntimeLobby;
  lifecycle: RuntimeLifecycle;
  phaseTicks: RuntimePhaseTicks;
  music: RuntimeMusic;
  sfx: RuntimeSfx;
  /** Camera sub-system. Exposed so tests (and any future consumer) can
   *  observe zoom/pitch state — the underlying camera value is already
   *  constructed inside `createGameRuntime`, this just surfaces it on
   *  the public handle. */
  camera: CameraSystem;

  // --- Cross-cutting orchestration ---
  mainLoop: (now: number) => void;
  clearFrameData: () => void;
  render: () => void;

  /** Show a full-screen banner. `onDone` is invoked exactly once when
   *  the banner finishes. Callers pass `prevScene` for the cross-fade
   *  (capture via `captureScene`); `undefined` means "sweep without
   *  fade." See `BannerShow` in runtime-contracts for the full opts. */
  showBanner: BannerShow;
  /** Capture the current scene for the next banner's prev-scene. The
   *  returned `SceneCapture` carries the raw pixels plus a monotonic
   *  tick stamp used by the render path to fence out stale snapshots.
   *  Returns `undefined` before the first frame / in headless mode. */
  captureScene: () => SceneCapture | undefined;
  /** Pre-transition unzoom with post-convergence callback. See
   *  `CameraSystem.requestUnzoom`. Exposed so the watcher's
   *  PhaseTransitionCtx (built outside this module) can gate its own
   *  runTransition on fullMapVp convergence. */
  requestUnzoom: (onReady: () => void) => void;
  snapshotTerritory: () => Set<number>[];
  aimAtEnemyCastle: () => void;
  /** Pre-warm the terrain render cache for a map (avoids first-frame stall). */
  warmMapCache: (map: GameMap) => void;

  /** Outbound network send — same callback every production broadcast flows
   *  through. Exposed so tests (and any other consumer constructing their
   *  own controllers) can wire into the runtime's broadcast pipeline
   *  without rebuilding the NetworkApi. */
  networkSend: NetworkApi["send"];
  /** Camera pitch-state getter exposed so the watcher phase-transition
   *  ctx (built outside this module) can gate balloon-anim start on
   *  tilt-in. Host ctx reads the same value via its phase-ticks deps. */
  getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
  /** Start the build→battle tilt. Called from `proceedToBattle` so the
   *  watcher plays the same tilt-before-balloons sequence as the host. */
  beginBattleTilt: () => void;
  /** Re-engage the current phase's auto-zoom. Forwarded to the
   *  watcher's life-lost display step. */
  engageAutoZoom: () => void;
}

/** Consumer registry for `OnlinePhaseTicks` hooks.
 *
 *  Each hook maps to the files that wire it. The `satisfies
 *  Record<keyof OnlinePhaseTicks, ...>` clause forces exhaustiveness:
 *  adding a new hook to the interface without an entry here is a compile
 *  error. `scripts/lint-registries.ts` then verifies every listed path
 *  exists on disk, so a renamed wiring file surfaces at pre-commit.
 *
 *  Roles are free-form documentation strings by convention:
 *    - "wire:prod"        → `src/online/online-runtime-game.ts`
 *    - "wire:test-host"   → host-side builder in `test/network-setup.ts`
 *    - "wire:test-watcher"→ watcher-side builder in `test/network-setup.ts`
 *    - "wire:test-stub"   → no-op stub in `test/runtime-headless.ts`
 *
 *  A hook doesn't need every role — only production (`wire:prod`) is
 *  effectively required (every hook is wired there today). Test fixtures
 *  opt in only when their scenario needs the behavior. */
export const ONLINE_PHASE_TICKS_CONSUMERS = {
  broadcastCannonStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBattleStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBuildStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBuildEnd: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastLocalCrosshair: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  remoteCannonPhantoms: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  remotePiecePhantoms: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  shouldSendCannonPhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
  },
  shouldSendPiecePhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
  },
  tickWatcher: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-watcher": "test/network-setup.ts",
  },
  watcherBeginBattle: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-watcher": "test/network-setup.ts",
  },
  extendCrosshairs: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-watcher": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  tickMigrationAnnouncement: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-watcher": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
} as const satisfies Record<
  keyof OnlinePhaseTicks,
  Readonly<Record<string, string>>
>;
