/**
 * Public interfaces for the runtime factory (split from composition.ts
 * so consumers import types only). Convention: `createXxxSystem(deps)`
 * destructures runtimeState at top; deps use getters for late binding;
 * sub-systems import only runtime/types + runtime/state. Overlay updates:
 * PERSISTENT / TRANSIENT / INPUT-DELEGATED. Pre-init code must guard reads
 * via safeState / isStateInstalled / isSessionLive.
 */

import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
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
import type { GameState } from "../shared/core/types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { ResolvedChoice } from "../shared/ui/interaction-types.ts";
import type { RendererInterface } from "../shared/ui/overlay-types.ts";
import type { TimingApi } from "./timing-api.ts";

/** Online-only per-frame coordination consumed by subsystems/phase-ticks.ts.
 *
 *  Every field is INDEPENDENTLY OPTIONAL — the runtime checks for presence
 *  and silently skips when missing.
 *
 *  Under clone-everywhere, every peer runs the same phase ticks locally
 *  and dispatches transitions itself. The only role-gated fields are the
 *  four `broadcast*` phase markers, gated by `frameMeta.hostAtFrameStart`
 *  at the call site in `buildHostPhaseCtx` (subsystems/phase-ticks.ts) — only
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

/** Action surface for the input dispatcher. The same shape is wired both
 *  online and offline: online wrappers broadcast after a successful apply
 *  (see `online-send-actions.ts`), local wrappers execute against state
 *  directly (see `input-actions.ts`). The dispatcher consumes one
 *  surface regardless of mode. */
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
interface OnlineDialogDrains {
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
 *    - Online (online/runtime/game.ts): WebSocket `send`, fan-out
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
   *  scenario, exercising the same code path the WebSocket would.
   *
   *  lint:allow-callback-inversion -- network observer: handler runs at
   *  the caller's identity when a peer message arrives. */
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
   *  See `OnlineActions`. When undefined, composition uses
   *  `createLocalInputActions` to produce the same shape. */
  onlineActions?: OnlineActions;
  /** Online-only drain hooks for wire-arrived dialog choices that landed
   *  before the local sim made the dialog interactable. See
   *  `OnlineDialogDrains`. Undefined in local play. */
  onlineDialogDrains?: OnlineDialogDrains;
  /** Online-only game-over broadcast hook. Fires once when the game ends,
   *  before the frame's gameOver payload is set. */
  onEndGame?: (winner: { id: ValidPlayerId }, state: GameState) => void;

  /** Test-only sub-system observers. Threaded from the test scenario
   *  through `createHeadlessRuntime` so tests can capture intents
   *  (haptics, render) without monkey-patching module state.
   *  Production callers (`main.ts`, `online/runtime/game.ts`) omit
   *  this entirely. */
  observers?: {
    haptics?: HapticsObserver;
  };

  /** Emit the per-frame `GAME_EVENT.TICK` event. Defaults to `IS_DEV` (true
   *  on the Vite dev server / localhost — covers E2E + local dev — false in
   *  deployed prod). Headless tests pass `true` explicitly because `IS_DEV`
   *  is false under Deno. Deployed prod never emits it: TICK has no prod
   *  consumers, so suppressing it keeps the bus free of per-frame churn. */
  emitTickEvent?: boolean;

  /** Optional override for per-slot controller construction at bootstrap.
   *  When undefined (production path), the default `createController`
   *  factory is used. Tests use this to install
   *  `AiAssistedHumanController` for selected slots from bootstrap onward,
   *  avoiding mid-game controller swaps. See `assistedSlots` in
   *  `test/runtime-headless.ts`. */
  controllerFactory?: ControllerFactory;
}
