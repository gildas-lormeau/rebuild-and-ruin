/**
 * Public interfaces for the game runtime factory.
 *
 * Separated from runtime.ts to keep the implementation file focused
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
 *     runtime-selection.ts, runtime-input.ts, runtime-life-lost.ts,
 *     runtime-lobby.ts, runtime-options.ts, runtime-game-lifecycle.ts,
 *     runtime-banner.ts, runtime-render.ts, runtime-phase-ticks.ts
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

import type { GameMessage, ServerMessage } from "../../server/protocol.ts";
import type { HapticsSystem } from "../input/haptics-system.ts";
import type { SoundSystem } from "../input/sound-system.ts";
import type { BalloonFlight } from "../shared/battle-types.ts";
import type { SerializedPlayer } from "../shared/checkpoint-data.ts";
import type {
  BattleController,
  BuildController,
  CannonController,
  ControllerIdentity,
  InputReceiver,
} from "../shared/controller-interfaces.ts";
import type {
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/dialog-types.ts";
import {
  isPlacementPhase,
  isTransitionMode,
  Mode,
  Phase,
} from "../shared/game-phase.ts";
import type {
  Crosshair,
  Viewport,
  WorldPos,
} from "../shared/geometry-types.ts";
import type { RendererInterface } from "../shared/overlay-types.ts";
import type {
  CannonPhantom,
  DedupChannel,
  PiecePhantom,
} from "../shared/phantom-types.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "../shared/player-slot.ts";
import type { WatcherTimingState } from "../shared/tick-context.ts";
import {
  type FrameContext,
  type GameState,
  type SelectionState,
} from "../shared/types.ts";
import type { RuntimeState } from "./runtime-state.ts";

export type { FrameContext } from "../shared/types.ts";

/** Exported for headless camera testing (test/scenario-helpers.ts). */
export interface FrameContextInputs {
  mode: Mode;
  phase: Phase;
  timer: number;
  paused: boolean;
  quitPending: boolean;
  hasLifeLostDialog: boolean;
  isSelectionReady: boolean;
  humanIsReselecting: boolean;
  hasPointerPlayer: boolean;
  myPlayerId: PlayerSlotId;
  hostAtFrameStart: boolean;
  remoteHumanSlots: ReadonlySet<number>;
  mobileAutoZoom: boolean;
}

export interface RuntimeConfig {
  renderer: RendererInterface;
  /** true for online mode. */
  isOnline?: boolean;
  /** noop for local, ws.send for online. */
  send: (msg: GameMessage) => void;
  /** Config-level host check: () => true for local play, () => session.isHost for online.
   *  Used at frame start to snapshot hostAtFrameStart. For runtime volatile checks in
   *  tick/handler code, use isHostInContext(net) from tick-context.ts instead. */
  getIsHost: () => boolean;
  /** This client's player slot in online mode, or -1 in local (shared-screen) mode.
   *  Only meaningful for online play — local consumers should use povPlayerId instead. */
  getMyPlayerId: () => PlayerSlotId;
  /** () => emptySet for local. */
  getRemoteHumanSlots: () => Set<number>;
  /** noop for local. */
  log: (msg: string) => void;
  /** noop for local. */
  logThrottled: (key: string, msg: string) => void;
  /** Different formula per mode. */
  getLobbyRemaining: () => number;
  /** Each mode provides its own. */
  showLobby: () => void;
  /** local: set joined; online: send select_slot. */
  onLobbySlotJoined: (pid: ValidPlayerSlot) => void;
  /** Optional extra action on close (e.g., reset timer). */
  onCloseOptions?: () => void;
  /** local: startGame; online: host sends init. */
  onTickLobbyExpired: () => void;

  // -----------------------------------------------------------------------
  // Optional networking deps for tick functions (online-host-phases, etc.)
  // -----------------------------------------------------------------------

  /** Called after local crosshairs are collected; returns extended list (e.g., adds remote human crosshairs). */
  extendCrosshairs?: (crosshairs: Crosshair[], dt: number) => Crosshair[];
  /** Called per controller during crosshair collection (e.g., sends aim_update to watchers). */
  onLocalCrosshairCollected?: (
    ctrl: ControllerIdentity,
    ch: { x: number; y: number },
    readyCannon: boolean,
  ) => void;
  /** Optional non-host tick handler (watcher logic). */
  tickNonHost?: (dt: number) => void;
  /** Called every frame regardless of host/non-host (e.g., timed announcements). */
  everyTick?: (dt: number) => void;
  /** Host-only networking state for tick functions (phantom merging, checkpoints). */
  hostNetworking?: {
    serializePlayers: (state: GameState) => SerializedPlayer[];
    createCannonStartMessage: (state: GameState) => ServerMessage;
    createBattleStartMessage: (
      state: GameState,
      flights: readonly BalloonFlight[],
    ) => ServerMessage;
    createBuildStartMessage: (state: GameState) => ServerMessage;
    remoteCannonPhantoms: () => readonly CannonPhantom[];
    remotePiecePhantoms: () => readonly PiecePhantom[];
    /** Getter returning the dedup channel — wraps the DedupChannel from
     *  WatcherTickContext/CannonPhaseNet so the runtime doesn't hold a stale reference. */
    lastSentCannonPhantom: () => DedupChannel;
    /** Getter returning the dedup channel — same late-binding pattern as lastSentCannonPhantom. */
    lastSentPiecePhantom: () => DedupChannel;
  };
  /** Watcher timing state (for non-host battle). */
  watcherTiming?: WatcherTimingState;
  /** Send aim_update for mouse movement. */
  maybeSendAimUpdate?: (x: number, y: number) => void;
  /** Try to place cannon and send to server. */
  tryPlaceCannonAndSend?: (
    ctrl: ControllerIdentity & CannonController & InputReceiver,
    gameState: GameState,
    max: number,
  ) => boolean;
  /** Try to place piece and send to server. */
  tryPlacePieceAndSend?: (
    ctrl: ControllerIdentity & BuildController & InputReceiver,
    gameState: GameState,
  ) => boolean;
  /** Fire and send to server. */
  fireAndSend?: (ctrl: BattleController, gameState: GameState) => void;
  /** Room code for lobby overlay. */
  roomCode?: string;
  /** Optional hook called when a game ends (before frame payload is set). */
  onEndGame?: (winner: { id: number }, state: GameState) => void;
}

export interface CameraSystem {
  // Per-frame lifecycle
  tickCamera: () => void;
  updateViewport: () => Viewport | null;

  // Coordinate conversion
  getViewport: () => Viewport | null;
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
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;

  // Lifecycle commands
  /** Phase unzoom: clear cameraZone + pinchVp only (preserves per-phase memory for autoZoom restore). */
  clearPhaseZoom: () => void;
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
  isMobileAutoZoom: () => boolean;

  // Touch battle targeting
  /** Aim at enemy castle at battle start (touch devices). */
  aimAtEnemyCastle: () => void;
  /** Save human crosshair position for restoration next battle. */
  saveBattleCrosshair: () => void;
  /** Clear saved crosshair (called on resetUIState). */
  resetBattleCrosshair: () => void;
}

export interface RuntimeSelection {
  getStates: () => Map<number, SelectionState>;
  init: (pid: ValidPlayerSlot, zone: number) => void;
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
  /** Show animated score deltas after build phase. `onDone` is invoked exactly once
   *  when the animation finishes (or immediately if there are no deltas to show). */
  showBuildScoreDeltas: (onDone: () => void) => void;
}

export interface RuntimeLifeLost {
  get: () => LifeLostDialogState | null;
  set: (d: LifeLostDialogState | null) => void;
  /** Show life-lost dialog. Returns false if all entries were pre-resolved (dialog skipped). */
  tryShow: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => boolean;
  tick: (dt: number) => void;
  onResolved: (continuing?: readonly ValidPlayerSlot[]) => boolean;
  panelPos: (playerId: ValidPlayerSlot) => { px: number; py: number };
}

export interface RuntimeUpgradePick {
  /** Show upgrade pick dialog. Returns false if no offers (dialog skipped). */
  tryShow: (onDone: () => void) => boolean;
  tick: (dt: number) => void;
  get: () => UpgradePickDialogState | null;
  set: (dialog: UpgradePickDialogState | null) => void;
}

export interface RuntimeLobby {
  renderLobby: () => void;
}

export interface RuntimeLifecycle {
  startGame: () => void;
  resetUIState: () => void;
}

export interface RuntimePhaseTicks {
  startCannonPhase: (onBannerDone?: () => void) => void;
  beginBattle: () => void;
}

export interface GameRuntime {
  /** Mutable runtime state — direct property access replaces getter/setter pairs. */
  runtimeState: RuntimeState;

  // --- Sub-system handles ---
  selection: RuntimeSelection;
  lifeLost: RuntimeLifeLost;
  upgradePick: RuntimeUpgradePick;
  sound: SoundSystem;
  haptics: HapticsSystem;
  lobby: RuntimeLobby;
  lifecycle: RuntimeLifecycle;
  phaseTicks: RuntimePhaseTicks;

  // --- Cross-cutting orchestration ---
  mainLoop: (now: number) => void;
  clearFrameData: () => void;
  render: () => void;
  registerInputHandlers: () => void;

  /** Show a full-screen banner. `onDone` is invoked exactly once when the banner finishes. */
  showBanner: (
    text: string,
    onDone: () => void,
    preservePrevScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  snapshotTerritory: () => Set<number>[];
  aimAtEnemyCastle: () => void;
}

/** Seconds before timer reaches 0 to trigger unzoom. */
const PHASE_ENDING_THRESHOLD = 1.5;

export function computeFrameContext(inputs: FrameContextInputs): FrameContext {
  const {
    mode,
    phase,
    timer,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    hasPointerPlayer,
    myPlayerId,
    hostAtFrameStart,
    remoteHumanSlots,
    mobileAutoZoom,
  } = inputs;

  const uiBlocking = paused || quitPending || hasLifeLostDialog;

  const timedPhase = isPlacementPhase(phase) || phase === Phase.BATTLE;
  const phaseEnding =
    !mobileAutoZoom &&
    timer > 0 &&
    timer <= PHASE_ENDING_THRESHOLD &&
    timedPhase;

  const shouldUnzoom = uiBlocking || phaseEnding;
  const isTransition = isTransitionMode(mode);

  const povPlayerId: ValidPlayerSlot = isActivePlayer(myPlayerId)
    ? myPlayerId
    : (0 as ValidPlayerSlot);

  return {
    myPlayerId,
    povPlayerId,
    hostAtFrameStart,
    remoteHumanSlots,
    mode,
    phase,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    hasPointerPlayer,
    uiBlocking,
    phaseEnding,
    shouldUnzoom,
    isTransition,
  };
}
