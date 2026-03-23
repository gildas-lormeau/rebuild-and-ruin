/**
 * Public interfaces for the game runtime factory.
 *
 * Separated from game-runtime.ts to keep the implementation file focused
 * on the factory closure, and to let consumers import just the types.
 */

import type { GameState } from "./types.ts";
import type { PlayerController, Crosshair } from "./player-controller.ts";
import type { RenderOverlay } from "./map-renderer.ts";
import type { SelectionState } from "./selection.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import type { SerializedPlayer } from "./online-serialize.ts";
import type { CannonPhantom, PiecePhantom } from "./online-types.ts";
import type { WatcherTimingState } from "./online-watcher-battle.ts";
import type { BalloonFlight } from "./battle-system.ts";
import type { GameMessage, ServerMessage } from "../server/protocol.ts";
import type { CastleBuildState } from "./castle-build.ts";
import type { BannerState } from "./phase-banner.ts";
import type { UIContext } from "./game-ui-screens.ts";
import type {
  TimerAccums,
  GameSettings,
  ControlsState,
  FrameData,
  BattleAnimState,
  LobbyState,
} from "./game-ui-types.ts";
import { Mode } from "./game-ui-types.ts";

// ---------------------------------------------------------------------------
// RuntimeConfig
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  canvas: HTMLCanvasElement;
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
  /** Host-only networking state for tick functions (phantom merging, checkpoints, auto-placement). */
  hostNetworking?: {
    autoPlaceCannons: (player: GameState["players"][number], max: number, state: GameState) => void;
    serializePlayers: (state: GameState) => SerializedPlayer[];
    buildCannonStartMessage: (state: GameState) => ServerMessage;
    buildBattleStartMessage: (state: GameState, flights: BalloonFlight[]) => ServerMessage;
    buildBuildStartMessage: (state: GameState) => ServerMessage;
    remoteCannonPhantoms: () => CannonPhantom[];
    remotePiecePhantoms: () => PiecePhantom[];
    lastSentCannonPhantom: () => Map<number, string>;
    lastSentPiecePhantom: () => Map<number, string>;
  };
  /** Watcher timing state (for non-host battle). */
  watcherTiming?: WatcherTimingState;
  /** Send aim_update for mouse movement. */
  maybeSendAimUpdate?: (x: number, y: number) => void;
  /** Try to place cannon and send to server. */
  tryPlaceCannonAndSend?: (ctrl: PlayerController, gameState: GameState, max: number) => boolean;
  /** Try to place piece and send to server. */
  tryPlacePieceAndSend?: (ctrl: PlayerController, gameState: GameState) => boolean;
  /** Fire and send to server. */
  fireAndSend?: (ctrl: PlayerController, gameState: GameState) => void;
  /** Room code for lobby overlay. */
  roomCode?: string;
  /** Optional hook called when a game ends (before frame payload is set). */
  onEndGame?: (winner: { id: number } | null, state: GameState) => void;
}

// ---------------------------------------------------------------------------
// GameRuntime return type
// ---------------------------------------------------------------------------

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
  animateCastle: (onDone: () => void) => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;
  startReselection: () => void;
  finishReselection: () => void;
  animateReselectionCastles: (onDone: () => void) => void;
}

export interface RuntimeLifeLost {
  get: () => LifeLostDialogState | null;
  set: (d: LifeLostDialogState | null) => void;
  show: (needsReselect: number[], eliminated: number[]) => void;
  tick: (dt: number) => void;
  afterResolved: (continuing?: number[]) => boolean;
  panelPos: (playerId: number) => { px: number; py: number };
  click: (canvasX: number, canvasY: number) => void;
}

export interface GameRuntime {
  // --- State getters ---
  getState: () => GameState;
  setState: (s: GameState) => void;
  getOverlay: () => RenderOverlay;
  getControllers: () => PlayerController[];
  setControllers: (c: PlayerController[]) => void;
  getAccum: () => TimerAccums;
  setAccum: (a: TimerAccums) => void;
  getBattleAnim: () => BattleAnimState;
  setBattleAnim: (b: BattleAnimState) => void;
  getFrame: () => FrameData;
  getCastleBuild: () => CastleBuildState | null;
  setCastleBuild: (c: CastleBuildState | null) => void;
  getReselectQueue: () => number[];
  setReselectQueue: (q: number[]) => void;
  getReselectionPids: () => number[];
  setReselectionPids: (p: number[]) => void;
  getMode: () => Mode;
  setMode: (m: Mode) => void;
  getSettings: () => GameSettings;
  getPaused: () => boolean;
  setPaused: (v: boolean) => void;
  getQuitPending: () => boolean;
  setQuitPending: (v: boolean) => void;
  getQuitTimer: () => number;
  setQuitTimer: (v: number) => void;
  getOptionsReturnMode: () => Mode | null;
  setOptionsReturnMode: (m: Mode | null) => void;
  getOptionsCursor: () => number;
  setOptionsCursor: (v: number) => void;
  getControlsState: () => ControlsState;
  getLobby: () => LobbyState;
  getBanner: () => BannerState;
  setBanner: (b: BannerState) => void;
  getLastTime: () => number;
  setLastTime: (t: number) => void;

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

  collectCrosshairs: (canFireNow: boolean, dt?: number) => void;
  snapshotTerritory: () => Set<number>[];
  firstHuman: () => PlayerController | null;
  withFirstHuman: (action: (human: PlayerController) => void) => void;

  render: () => void;
  endGame: (winner: { id: number } | null) => void;

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
