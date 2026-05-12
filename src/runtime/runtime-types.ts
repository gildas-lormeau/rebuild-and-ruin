/**
 * Public interfaces for the runtime factory (split from runtime-composition
 * so consumers import types only). Convention: `createXxxSystem(deps)`
 * destructures runtimeState at top; deps use getters for late binding;
 * sub-systems import only runtime-types/runtime-state. Overlay updates:
 * PERSISTENT / TRANSIENT / INPUT-DELEGATED. Pre-init code must guard reads
 * via safeState / isStateInstalled / isSessionLive.
 */

import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import type {
  GameMap,
  Viewport,
  WorldPos,
} from "../shared/core/geometry-types.ts";
import type { PlayerId, ValidPlayerId } from "../shared/core/player-slot.ts";
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
} from "../shared/core/system-interfaces.ts";
import type { GameState, SelectionState } from "../shared/core/types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type {
  LifeLostDialogState,
  ResolvedChoice,
  UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type { RendererInterface } from "../shared/ui/overlay-types.ts";
import type { TimingApi } from "./runtime-contracts.ts";
import type { RuntimeState } from "./runtime-state.ts";

/** Online-only per-frame coordination consumed by runtime-phase-ticks.ts.
 *
 *  Every field is INDEPENDENTLY OPTIONAL — the runtime checks for presence
 *  and silently skips when missing.
 *
 *  Under clone-everywhere, every peer runs the same phase ticks locally
 *  and dispatches transitions itself. The only role-gated fields are the
 *  four `broadcast*` phase markers, gated by `frameMeta.hostAtFrameStart`
 *  at the call site in `buildHostPhaseCtx` (runtime-phase-ticks.ts) — only
 *  the host emits to the wire. Every other field is called unconditionally
 *  on every peer (each self-gates by ownership where relevant).
 *
 *  When undefined on RuntimeConfig, the runtime runs in single-machine
 *  local mode (main.ts, test/runtime-headless.ts) and never invokes any
 *  of these. */
export interface OnlinePhaseTicks {
  // ── Host-only: phase-transition phase markers ──────────────────────────
  // Each is a payload-less marker. Non-host peers receive but ignore them
  // — every peer dispatches the matching transition from its own local
  // tick, which means `state.rng` is consumed in lockstep by definition.
  /** Host: broadcast the cannon-phase entry marker. */
  broadcastCannonStart?: () => void;
  /** Host: broadcast the battle-phase entry marker. */
  broadcastBattleStart?: () => void;
  /** Host: broadcast the build-phase entry marker. */
  broadcastBuildStart?: () => void;
  /** Host: broadcast the build-phase exit marker. */
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
  shouldSendCannonPhantom?: (playerId: ValidPlayerId, key: string) => boolean;
  /** Same contract as `shouldSendCannonPhantom`, for piece-phantoms. */
  shouldSendPiecePhantom?: (playerId: ValidPlayerId, key: string) => boolean;

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
 *  fallbacks inline at `runtime-composition.ts`'s `inputActions` object,
 *  which just execute the action without sending — the "AndSend" suffix
 *  is a misnomer in that case but kept for symmetry with the online versions. */
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

/** Online-only drain hooks for wire-arrived dialog choices that landed
 *  before the local sim made the dialog interactable. The session-side
 *  queues (`earlyLifeLostChoices`, `earlyUpgradePickChoices`) accumulate
 *  these in two windows:
 *    - life-lost: the brief gap between host broadcast and the non-host
 *      peer's local ROUND_END building the dialog.
 *    - upgrade-pick: the banner-preview window where the dialog exists
 *      for rendering but `Mode.UPGRADE_PICK` isn't active yet, so the
 *      wire path's `getUpgradePickDialog` returns null.
 *  Each drain is called once when the corresponding subsystem makes the
 *  dialog interactable; it iterates its session queue, calls `apply` for
 *  each pending entry, then clears the queue. */
export interface OnlineDialogDrains {
  drainLifeLost: (
    apply: (playerId: ValidPlayerId, choice: ResolvedChoice) => boolean,
  ) => void;
  drainUpgradePick: (
    apply: (playerId: ValidPlayerId, choice: UpgradeId) => boolean,
  ) => void;
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
  readonly myPlayerId: () => PlayerId;
  /** Slots controlled by other machines (need network sync). Empty set
   *  for local play. */
  readonly remotePlayerSlots: () => ReadonlySet<ValidPlayerId>;
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
  onLobbySlotJoined: (pid: ValidPlayerId) => void;
  /** Optional extra action on close (e.g., reset timer). */
  onCloseOptions?: () => void;
  /** local: startGame; online: host sends init. */
  onTickLobbyExpired: () => void | Promise<void>;

  /** Online-only per-frame coordination (host fan-out + watcher tick).
   *  See `OnlinePhaseTicks`. Presence on RuntimeConfig implies online mode. */
  onlinePhaseTicks?: OnlinePhaseTicks;
  /** Online-only action wrappers consumed by the input dispatcher.
   *  See `OnlineActions`. When undefined, local fallbacks are installed
   *  inline in `runtime-composition.ts`'s `inputActions` object. */
  onlineActions?: OnlineActions;
  /** Online-only drain hooks for wire-arrived dialog choices that landed
   *  before the local sim made the dialog interactable. See
   *  `OnlineDialogDrains`. Undefined in local play. */
  onlineDialogDrains?: OnlineDialogDrains;
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
  /** Maximum pitch the camera reaches when fully tilted into the 3D
   *  battle view. Constant for the lifetime of the runtime; exposed so
   *  the renderer can normalize `getPitch()` into a `[0, 1]` tilt
   *  progress without duplicating the constant cross-domain. 2D mode
   *  returns 0. */
  getPitchMax: () => number;
  /** Request an immediate pitch=0 ease. Idempotent. Used for "untilt
   *  without unzoom" (pitch only). The transition path already flattens
   *  pitch via `unzoomForOverlays` on `shouldUnzoom`. */
  beginUntilt: () => void;
  /** Start the build→battle tilt animation. Called explicitly at
   *  battle-banner end so the tilt plays unzoomed, before balloons /
   *  "ready" / auto-zoom into the battle zone. 2D mode: no-op. */
  beginTilt: () => void;
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
  getEnemyZones: () => ZoneId[];

  // Zoom state
  getCameraZone: () => ZoneId | undefined;
  /** The zone the user is visually looking at — explicit zone target if set,
   *  otherwise the zone at the pinch viewport center, or undefined when on
   *  full map / over a river. Drives the touch zone-cycle button preview. */
  getViewedZone: () => ZoneId | undefined;
  setCameraZone: (zone: ZoneId) => void;

  // Lifecycle commands
  /** Run `cb` once the next-rendered frame is at fullMap AND pitch is at
   *  0. Fires synchronously when both already hold. Flattens the pitch
   *  target as part of the call. Does NOT trigger the viewport unzoom —
   *  `unzoomForOverlays` (driven by `shouldUnzoom`, which includes
   *  `isTransition`) owns that. Pair with `setMode(Mode.TRANSITION)`
   *  before the call. `captureScene()` called inside `cb` reads full-map
   *  flat pixels. */
  awaitCameraFlat: (callback: () => void) => void;
  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction — `flat` and `tilted` both count as settled). Fires
   *  synchronously when pitch is already settled, including the headless
   *  `cameraTiltEnabled === false` case. Used by the phase machine's
   *  battle-banner postDisplay to gate balloon-anim / battle-mode entry
   *  behind the build→battle tilt-in. Caller-overwrite semantics. */
  awaitPitchSettled: (callback: () => void) => void;
  /** Post-render hook — called by the render loop after drawFrame.
   *  Fires any pending `awaitCameraFlat` callback when the viewport has
   *  converged to fullMapVp and pitch is settled. */
  onRenderedFrame: () => void;
  /** Full unzoom: clear all zoom state for returnToLobby/endGame. */
  clearAllZoomState: () => void;
  /** Full reset for rematch. */
  resetCamera: () => void;

  // Castle build viewport
  setSelectionViewport: (towerRow: number, towerCol: number) => void;
  setCastleBuildViewport: (playerId: ValidPlayerId) => void;
  clearCastleBuildViewport: () => void;

  // Mobile zoom
  enableMobileZoom: () => void;
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
  /** Enter CASTLE_SELECT. Omit `queue` for the initial cycle (bootstrap
   *  path: round 1 / watcher SELECT_START); pass an explicit queue for
   *  the lifeLostRoute reselect cycle. */
  enter: (queue?: readonly ValidPlayerId[]) => void;
  syncOverlay: () => void;
  highlight: (idx: number, zone: ZoneId, pid: ValidPlayerId) => void;
  confirmAndStartBuild: (
    pid: ValidPlayerId,
    source?: "local" | "network",
    applyAt?: number,
  ) => boolean;
  allConfirmed: () => boolean;
  isReady: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  /** Full reset for game restart / rematch. */
  reset: () => void;
}

/**
 * Dialog/animation completion callbacks — each sub-system stores its
 * "fire once when done" callback in a closure-local `let cb |
 * undefined`. Tick scope is what actually differs:
 *
 * | System       | Tick scope                                     |
 * |--------------|------------------------------------------------|
 * | ScoreDelta   | Mode-independent (runs during banner animations) |
 * | LifeLost     | Gated on Mode.LIFE_LOST                        |
 * | UpgradePick  | Gated on Mode.UPGRADE_PICK                     |
 */
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
   *  Wire-arrived choices that landed before the dialog was built are
   *  drained inside `show()` via `OnlineDialogDrains.drainLifeLost`
   *  (online wiring only).
   *
   *  Returns true when a dialog was actually shown. */
  show: (
    needsReselect: readonly ValidPlayerId[],
    eliminated: readonly ValidPlayerId[],
    onResolved: (continuing: readonly ValidPlayerId[]) => void,
  ) => boolean;
  tick: (dt: number) => void;
  panelPos: (playerId: ValidPlayerId) => { px: number; py: number };
}

export interface RuntimeUpgradePick {
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
  set: (dialog: UpgradePickDialogState | null) => void;
}

export interface RuntimeLobby {
  renderLobby: () => void;
  /** Runtime-internal lobby reset: clear joined/active/timer/map, clear
   *  quit + options state, render once, flip mode to LOBBY. Hosts call
   *  this from their `RuntimeConfig.showLobby` callback and add their
   *  own platform extras (browser: title music start). Headless tests
   *  bind `showLobby` straight to this. */
  show: () => void;
  /** Mark a slot joined and re-render the lobby. */
  markJoined: (pid: ValidPlayerId) => void;
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
  dispatchAdvanceToCannon: () => void;
  beginBattle: () => void;
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
  /** Hide the current banner. The banner no longer auto-dismisses on
   *  sweep completion — it sits in its `swept` state until a caller
   *  hides it or a new `showBanner` overwrites it. */
  hideBanner: () => void;
  /** Pre-warm the terrain render cache for a map (avoids first-frame stall). */
  warmMapCache: (map: GameMap) => void;
}
