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
 */

import type { GameMessage, ServerMessage } from "../server/protocol.ts";
import type { SerializedPlayer } from "./checkpoint-data.ts";
import type {
  BattleController,
  BuildController,
  CannonController,
  ControllerIdentity,
  Crosshair,
  InputReceiver,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import type { WatcherTimingState } from "./online-types.ts";
import type { CannonPhantom, PiecePhantom } from "./phantom-types.ts";
import type { RendererInterface, Viewport } from "./render-types.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { SoundSystem } from "./sound-system.ts";
import {
  type BalloonFlight,
  type FrameContext,
  type GameState,
  isPlacementPhase,
  type LifeLostDialogState,
  Mode,
  Phase,
  type SelectionState,
} from "./types.ts";

export type { FrameContext } from "./types.ts";

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
  myPlayerId: number;
  firstHumanPlayerId: number;
  isHost: boolean;
  remoteHumanSlots: ReadonlySet<number>;
  mobileAutoZoom: boolean;
}

export interface RuntimeConfig {
  renderer: RendererInterface;
  /** true for online mode. */
  isOnline?: boolean;
  /** noop for local, ws.send for online. */
  send: (msg: GameMessage) => void;
  /** () => true for local. */
  getIsHost: () => boolean;
  /** () => -1 for local. */
  getMyPlayerId: () => number;
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
  onLobbySlotJoined: (pid: number) => void;
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
    /** Getter returning the dedup map — wraps the direct Map property from
     *  WatcherTickContext/CannonPhaseNet so the runtime doesn't hold a stale reference. */
    lastSentCannonPhantom: () => Map<number, string>;
    /** Getter returning the dedup map — same late-binding pattern as lastSentCannonPhantom. */
    lastSentPiecePhantom: () => Map<number, string>;
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
  myPlayerId: () => number;
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
    wallPlans: readonly { playerId: number; tiles: number[] }[],
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
  init: (pid: number, zone: number) => void;
  enter: () => void;
  syncOverlay: () => void;
  highlight: (idx: number, zone: number, pid: number) => void;
  confirmAndStartBuild: (pid: number, isReselect?: boolean) => boolean;
  allConfirmed: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  setCastleBuildViewport: (
    plans: readonly { playerId: number; tiles: number[] }[],
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
  show: (
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) => void;
  tick: (dt: number) => void;
  afterResolved: (continuing?: readonly number[]) => boolean;
  panelPos: (playerId: number) => { px: number; py: number };
  click: (canvasX: number, canvasY: number) => void;
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
    preserveOldScene?: boolean,
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
    myPlayerId,
    firstHumanPlayerId,
    isHost,
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

  return {
    myPlayerId,
    firstHumanPlayerId,
    isHost,
    remoteHumanSlots,
    mode,
    phase,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    uiBlocking,
    phaseEnding,
    shouldUnzoom,
  };
}
