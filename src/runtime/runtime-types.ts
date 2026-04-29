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
 * ### Readiness state guard (all runtime-*.ts sub-systems)
 *
 * `runtimeState.state` and `runtimeState.frameMeta` hold placeholder values
 * until `startGame()` runs (see runtime-state.ts). They are typed as their
 * real types but must not be read before the readiness flag flips via
 * `setRuntimeGameState`.
 *
 * Sub-system methods run exclusively from game-loop code after startGame(),
 * so they safely access runtimeState.state/frameMeta without null checks.
 * Do NOT call sub-system methods before startGame() completes.
 *
 * For code that MAY run before init (render, input), use:
 *   - `safeState(runtimeState)` → GameState | undefined
 *   - `isStateReady(runtimeState)` → boolean guard
 */

import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import type {
  GameMap,
  Viewport,
  WorldPos,
} from "../shared/core/geometry-types.ts";
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
  ControllerFactory,
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
import type { RendererInterface } from "../shared/ui/overlay-types.ts";
import type { BannerShow, TimingApi } from "./runtime-contracts.ts";
import type { RuntimeState } from "./runtime-state.ts";

export type { FrameContext } from "../shared/core/types.ts";

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
  /** Host: broadcast the cannon-phase entry phase-marker. Watcher runs the
   *  source-phase prefix + `enterCannonPhase` locally on receipt — no
   *  payload. See `CANNON_ENTRY_WATCHER_STEP` in `runtime-phase-machine.ts`. */
  broadcastCannonStart?: () => void;
  /** Host: broadcast the battle-phase entry checkpoint. Carries the
   *  pre-`enterBattlePhase` RNG state so the watcher can run the same
   *  setup (modifier roll, balloon resolution, grunt wall-attack roll)
   *  locally. See `BattleStartData` in checkpoint-data.ts. */
  broadcastBattleStart?: () => void;
  /** Host: broadcast the build-phase entry checkpoint to watchers. */
  /** Host: broadcast the build-phase entry phase-marker. Watcher runs
   *  `finalizeBattle` + `prepareNextRound` locally on receipt — no payload. See
   *  `BuildStartData` in checkpoint-data.ts. */
  broadcastBuildStart?: () => void;
  /** Host: broadcast the end-of-build summary (lives lost + eliminations
   *  + scores). The hook serializes the post-build player snapshot itself
   *  — the runtime does not need to know how to serialize players. */
  /** Host: broadcast the build-phase end phase-marker. Watcher runs
   *  `finalizeRound` followed by `startNextRound` locally on receipt
   *  (score + life penalties + ROUND_END, then state.round++ + ROUND_START)
   *  — no payload. */
  broadcastBuildEnd?: () => void;

  // ── Per-controller crosshair fan-out ───────────────────────────────────
  /** Broadcast a single local controller's crosshair to peers (typically
   *  deduped by aim target). Called once per local controller per frame
   *  from `syncCrosshairs`. The hook self-gates by ownership: only the
   *  local-human's crosshair hits the wire; AI crosshairs are derived
   *  identically on every peer and need no broadcast. */
  broadcastLocalCrosshair?: (
    ctrl: ControllerIdentity,
    crosshair: { x: number; y: number },
    cannonReady: boolean,
  ) => void;

  // ── Per-frame phantom dedup ────────────────────────────────────────────
  /** Check-then-update for outgoing cannon-phantom broadcasts. Returns
   *  true if the runtime should emit. The implementation gates by
   *  ownership (only the local human emits) and dedups by `key` (skips
   *  if the key matches the last emission for this player). */
  shouldSendCannonPhantom?: (playerId: ValidPlayerSlot, key: string) => boolean;
  /** Same contract as `shouldSendCannonPhantom`, for piece-phantoms. */
  shouldSendPiecePhantom?: (playerId: ValidPlayerSlot, key: string) => boolean;

  // ── Cross-machine merging ──────────────────────────────────────────────
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
  tryPlaceCannon: (
    ctrl: ControllerIdentity & CannonController & InputReceiver,
    gameState: CannonViewState,
    max: number,
  ) => boolean;
  /** Try to place a piece; on success, broadcast OPPONENT_PIECE_PLACED. */
  tryPlacePiece: (
    ctrl: ControllerIdentity & BuildController & InputReceiver,
    gameState: BuildViewState,
  ) => boolean;
  /** Fire a cannon; on success, broadcast CANNON_FIRED. */
  fire: (ctrl: BattleController, gameState: BattleViewState) => void;
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

  /** Enables the camera pitch animation for battle tilt. Defaults to `true`
   *  in the browser; headless tests pass `false` so `PITCH_SETTLED` events
   *  stay out of the determinism event log. */
  cameraTiltEnabled?: boolean;

  /** Optional override for per-slot controller construction at bootstrap.
   *  When undefined (production path), the default `createController`
   *  factory is used. Tests use this to install
   *  `AiAssistedHumanController` for selected slots from bootstrap onward,
   *  avoiding mid-game controller swaps. See `assistedSlots` in
   *  `test/runtime-headless.ts`. */
  controllerFactory?: ControllerFactory;
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
  /** Request an immediate pitch=0 ease. Idempotent. Used for "untilt
   *  without unzoom" (pitch only). The transition path already flattens
   *  pitch via `unzoomForOverlays` on `shouldUnzoom`. */
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
  /** Like `screenToWorld` but returns the world position of the first
   *  elevated-geometry hit under battle tilt (walls/towers/etc). At
   *  pitch=0 this is identical to `screenToWorld`. */
  pickHitWorld: (x: number, y: number) => WorldPos;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  pixelToTile: (x: number, y: number) => { row: number; col: number };

  // Pinch gesture handlers
  onPinchStart: (midX: number, midY: number) => void;
  onPinchUpdate: (midX: number, midY: number, scale: number) => void;
  onPinchEnd: () => void;

  /** Snap the camera so `(wx, wy)` is at the viewport center (current zoom
   *  preserved). Used by touch handlers on single-finger touchstart so a
   *  tap re-centers wherever the player pressed. */
  centerCameraOnTap: (wx: number, wy: number) => void;

  // Zone queries
  povPlayerId: () => number;
  getMyZone: () => number | null;
  getBestEnemyZone: () => number | null;
  getEnemyZones: () => number[];

  // Zoom state
  getCameraZone: () => number | undefined;
  setCameraZone: (zone: number | undefined) => void;

  // Lifecycle commands
  /** Park a callback to fire on the first frame where the viewport has
   *  converged to fullMapVp AND pitch settled at 0. Does NOT trigger the
   *  unzoom itself — `unzoomForOverlays` (driven by `shouldUnzoom`,
   *  which includes `isTransition`) owns the flatten. Pair with
   *  `setMode(Mode.TRANSITION)` before the call. `captureScene()` called
   *  inside the callback reads full-map flat pixels. */
  onCameraReady: (onReady: () => void) => void;
  /** Post-render hook — called by the render loop after drawFrame.
   *  Fires any pending `onCameraReady` callback when the viewport has
   *  converged to fullMapVp and pitch is settled. */
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
  isMobileAutoZoom: () => boolean;

  // Touch battle targeting
  /** Compute target position for human crosshair at battle start (touch devices).
   *  Returns null when no target is applicable. Caller applies to controller. */
  computeBattleTarget: () => { x: number; y: number } | null;
  /** Store a crosshair position for restoration at the next battle start. */
  saveBattleCrosshair: (pos: { x: number; y: number }) => void;
}

export interface RuntimeSelection {
  getStates: () => Map<number, SelectionState>;
  enter: () => void;
  syncOverlay: () => void;
  highlight: (idx: number, zone: number, pid: ValidPlayerSlot) => void;
  confirmAndStartBuild: (
    pid: ValidPlayerSlot,
    isReselect?: boolean,
    source?: "local" | "network",
  ) => boolean;
  allConfirmed: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  startReselection: () => void;
  finishReselection: () => void;
  /** Full reset for game restart / rematch. */
  reset: () => void;
}

/**
 * Dialog/animation completion callback — all three dialog sub-systems
 * (ScoreDelta / LifeLost / UpgradePick) share one shape: a closure-scoped
 * `FireOnceSlot` (see fire-once-slot.ts). The axis that genuinely differs
 * is **tick scope**:
 *
 * | System       | Tick scope                                     |
 * |--------------|------------------------------------------------|
 * | ScoreDelta   | Mode-independent (runs during banner animations) |
 * | LifeLost     | Gated on Mode.LIFE_LOST                        |
 * | UpgradePick  | Gated on Mode.UPGRADE_PICK                     |
 *
 * See docs/dialog-completion-patterns.md for details.
 */
export interface RuntimeScoreDelta {
  /** Show animated score deltas after build phase. `onDone` is invoked exactly once
   *  when the animation finishes (or immediately if there are no deltas to show).
   *  Timer ticks mode-independently (during banner/castle-build). */
  show: (onDone: () => void) => void;
  /** Set pre-scores directly (online watcher receives them from host). */
  setPreScores: (scores: readonly number[]) => void;
}

export interface RuntimeLifeLost {
  /** Read current dialog state. Used by watcher-mode to sync overlay display. */
  get: () => LifeLostDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state.
   *  Passing `null` also clears any pending `onResolved` callback so a
   *  force-clear (rematch, host-promote) can't fire it later. */
  set: (d: LifeLostDialogState | null) => void;
  /** Drive the life-lost flow to completion: create the dialog, either
   *  resolve immediately (all pre-resolved — only eliminations) or
   *  show the modal and wait for `tick` to resolve every entry. The
   *  `onResolved(continuing)` callback fires exactly once, with the
   *  list of players who chose CONTINUE. Elimination + PoV auto-zoom
   *  side effects happen inside this flow; routing the next phase
   *  (game-over / reselect / continue) is the CALLER's responsibility
   *  (see the ROUND_END postDisplay in the phase machine).
   *
   *  Returns true when a dialog was actually shown (so callers can
   *  apply early-arrived choices before the first tick — e.g. the
   *  online watcher's `earlyLifeLostChoices`). */
  show: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
    onResolved: (continuing: readonly ValidPlayerSlot[]) => void,
  ) => boolean;
  tick: (dt: number) => void;
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
  /** Runtime-internal lobby reset: clear joined/active/timer/map, clear
   *  quit + options state, render once, flip mode to LOBBY. Hosts call
   *  this from their `RuntimeConfig.showLobby` callback and add their
   *  own platform extras (browser: requestFrame, music start, frame-
   *  timing reset). Headless tests bind `showLobby` straight to this. */
  show: () => void;
  /** Mark a slot joined and re-render the lobby. */
  markJoined: (pid: ValidPlayerSlot) => void;
}

export interface RuntimeLifecycle {
  startGame: () => Promise<void>;
  /** Full reset + fresh bootstrap — production-equivalent to the rematch
   *  button on the game-over screen. Clears game-over / demo-timer state,
   *  then calls `startGame`. Tests use this via `sc.rematch()` to drive
   *  the "finish game 1, start game 2 on the same runtime" path. */
  rematch: () => void | Promise<void>;
  resetUIState: () => void;
  /** Per-session reset matrix shared by `endGame` and `returnToLobby`.
   *  Exposed so the online watcher's game-over handler can run the same
   *  cleanup before flipping Mode.STOPPED — without it, watchers see
   *  lingering score deltas, life-lost dialogs, and stale camera zoom
   *  on the game-over screen. */
  teardownSession: () => void;
  /** Shared game-over terminal sequence: caller-supplied frame paint →
   *  teardown → render → Mode.STOPPED. Frame paint runs first so it
   *  captures live `gameStats` before teardown zeros them. Used by the
   *  host's `endGame`, the watcher's MESSAGE.GAME_OVER handler (paints
   *  from authoritative scores), and the watcher's local last-player-
   *  standing detection (paints nothing — the message will overwrite
   *  when it arrives). Idempotent. */
  finalizeGameOver: (setFrame: () => void) => void;
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
  /** Stop any bg track currently playing and clear `wantsTitle`. Used by the
   *  GAME_EXIT_EVENT (back-button / route-out) handlers to silence music when
   *  the user leaves /play. */
  stopTitle(): Promise<void>;
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
  /** Quit-to-menu cleanup shared by both entry points (local + online).
   *  Sets mode to STOPPED, stops any active bg track, and silences
   *  in-flight SFX. Wired to the GAME_EXIT_EVENT (back-button / hash
   *  navigation away from /play). */
  shutdown: () => void;
  /** Camera sub-system. Exposed so tests (and any future consumer) can
   *  observe zoom/pitch state — the underlying camera value is already
   *  constructed inside `createGameRuntime`, this just surfaces it on
   *  the public handle. */
  camera: CameraSystem;

  // --- Cross-cutting orchestration ---
  mainLoop: (now: number) => void;
  clearFrameData: () => void;
  render: () => void;
  /** Renderer scene capture — exposed so the watcher's PhaseTransitionCtx
   *  (built outside this module) can snapshot the old scene before a
   *  mutation. The banner system owns the matching new-scene capture. */
  rendererCaptureScene: () => HTMLCanvasElement | undefined;

  /** Show a full-screen banner. The banner system owns scene capture
   *  (called as the first operation of `showBanner` itself), so
   *  callers don't thread a prev-scene. `onDone` is invoked exactly
   *  once when the sweep (and optional hold) completes. See
   *  `BannerShow` in runtime-contracts for the full opts. */
  showBanner: BannerShow;
  /** Hide the current banner. The banner no longer auto-dismisses on
   *  sweep completion — it sits in its `swept` state until a caller
   *  hides it or a new `showBanner` overwrites it. */
  hideBanner: () => void;
  /** Park a callback to fire when the camera has converged to fullMapVp
   *  with pitch flat. See `CameraSystem.onCameraReady`. Exposed so the
   *  watcher's PhaseTransitionCtx (built outside this module) can gate
   *  its own runTransition on convergence. */
  onCameraReady: (onReady: () => void) => void;
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
  shouldSendCannonPhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
  },
  shouldSendPiecePhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
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
