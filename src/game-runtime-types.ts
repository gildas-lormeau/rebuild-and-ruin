/**
 * Public interfaces for the game runtime factory.
 *
 * Separated from game-runtime.ts to keep the implementation file focused
 * on the factory closure, and to let consumers import just the types.
 */

import type { GameMessage, SerializedPlayer, ServerMessage } from "../server/protocol.ts";
import type { Crosshair, InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { UIContext } from "./game-ui-screens.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import type { CannonPhantom, PiecePhantom, WatcherTimingState } from "./online-types.ts";
import type { RendererInterface } from "./render-types.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { BalloonFlight, GameState, SelectionState } from "./types.ts";

export type { RendererInterface } from "./render-types.ts";

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
  onLocalCrosshairCollected?: (ctrl: PlayerController, ch: { x: number; y: number }, readyCannon: boolean) => void;
  /** Optional non-host tick handler (watcher logic). */
  tickNonHost?: (dt: number) => void;
  /** Called every frame regardless of host/non-host (e.g., timed announcements). */
  everyTick?: (dt: number) => void;
  /** Host-only networking state for tick functions (phantom merging, checkpoints). */
  hostNetworking?: {
    serializePlayers: (state: GameState) => SerializedPlayer[];
    buildCannonStartMessage: (state: GameState) => ServerMessage;
    buildBattleStartMessage: (state: GameState, flights: readonly BalloonFlight[]) => ServerMessage;
    buildBuildStartMessage: (state: GameState) => ServerMessage;
    remoteCannonPhantoms: () => readonly CannonPhantom[];
    remotePiecePhantoms: () => readonly PiecePhantom[];
    lastSentCannonPhantom: () => Map<number, string>;
    lastSentPiecePhantom: () => Map<number, string>;
  };
  /** Watcher timing state (for non-host battle). */
  watcherTiming?: WatcherTimingState;
  /** Send aim_update for mouse movement. */
  maybeSendAimUpdate?: (x: number, y: number) => void;
  /** Try to place cannon and send to server. */
  tryPlaceCannonAndSend?: (ctrl: PlayerController & InputReceiver, gameState: GameState, max: number) => boolean;
  /** Try to place piece and send to server. */
  tryPlacePieceAndSend?: (ctrl: PlayerController & InputReceiver, gameState: GameState) => boolean;
  /** Fire and send to server. */
  fireAndSend?: (ctrl: PlayerController, gameState: GameState) => void;
  /** Room code for lobby overlay. */
  roomCode?: string;
  /** Optional hook called when a game ends (before frame payload is set). */
  onEndGame?: (winner: { id: number } | null, state: GameState) => void;
}

export interface RuntimeSelection {
  getStates: () => Map<number, SelectionState>;
  init: (pid: number, zone: number) => void;
  enter: () => void;
  syncOverlay: () => void;
  highlight: (idx: number, zone: number, pid: number) => void;
  confirm: (pid: number, isReselect?: boolean) => boolean;
  allConfirmed: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  setCastleBuildViewport: (plans: readonly { playerId: number; tiles: number[] }[]) => void;
  startReselection: () => void;
  finishReselection: () => void;
  showBuildScoreDeltas: (onDone: () => void) => void;
}

export interface RuntimeLifeLost {
  get: () => LifeLostDialogState | null;
  set: (d: LifeLostDialogState | null) => void;
  show: (needsReselect: readonly number[], eliminated: readonly number[]) => void;
  tick: (dt: number) => void;
  afterResolved: (continuing?: readonly number[]) => boolean;
  panelPos: (playerId: number) => { px: number; py: number };
  click: (canvasX: number, canvasY: number) => void;
}

export interface GameRuntime {
  /** Mutable runtime state — direct property access replaces getter/setter pairs. */
  rs: RuntimeState;

  // --- Sub-systems ---
  selection: RuntimeSelection;
  lifeLost: RuntimeLifeLost;

  // --- Functions ---
  mainLoop: (now: number) => void;
  resetFrame: () => void;
  clampedFrameDt: (now: number) => number;

  renderLobby: () => void;
  tickLobby: (dt: number) => void;
  lobbyKeyJoin: (key: string) => boolean;
  lobbyClick: (canvasX: number, canvasY: number) => boolean;

  changeOption: (dir: number) => void;
  renderOptions: () => void;
  showOptions: () => void;
  closeOptions: () => void;

  renderControls: () => void;
  showControls: () => void;
  closeControls: () => void;
  togglePause: () => boolean;

  showBanner: (text: string, onDone: () => void, reveal?: boolean, newBattle?: { territory: Set<number>[]; walls: Set<number>[] }) => void;
  tickBanner: (dt: number) => void;

  syncCrosshairs: (canFireNow: boolean, dt?: number) => void;
  snapshotTerritory: () => Set<number>[];
  firstHuman: () => (PlayerController & InputReceiver) | null;
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;

  render: () => void;
  endGame: (winner: { id: number } | null) => void;
  aimAtEnemyCastle: () => void;

  startCannonPhase: () => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  beginBattle: () => void;
  startBuildPhase: () => void;

  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;

  tickGame: (dt: number) => void;
  resetUIState: () => void;
  startGame: () => void;

  uiCtx: UIContext;
  registerInputHandlers: () => void;
}
