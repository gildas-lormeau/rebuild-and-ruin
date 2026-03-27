/**
 * Mutable runtime state bag — replaces the loose closure variables
 * that used to live inside createGameRuntime().
 *
 * Exposing state as a plain object lets inner functions be extracted
 * to separate modules (they just take rs: RuntimeState) and eliminates
 * the getter/setter boilerplate on the GameRuntime interface.
 */

import type { CastleBuildState } from "./castle-build.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { FrameContext } from "./frame-context.ts";
import type {
  ControlsState,
  GameSettings,
  LobbyState,
} from "./game-ui-types.ts";
import {
  createControlsState,
  loadSettings,
} from "./game-ui-types.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import { type BannerState, createBannerState } from "./phase-banner.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import type { FrameData, PlayerStats, RenderOverlay } from "./render-types.ts";
import {
  type BattleAnimState,
  createBattleAnimState,
  createTimerAccums,
  type GameState,
  Mode,
  type SelectionState,
  type TimerAccums,
} from "./types.ts";

export interface RuntimeState {
  // Core game
  state: GameState;
  overlay: RenderOverlay;
  controllers: PlayerController[];

  // Phase / selection
  reselectQueue: number[];
  reselectionPids: number[];
  selectionStates: Map<number, SelectionState>;
  castleBuilds: CastleBuildState[];
  castleBuildOnDone: (() => void) | null;
  lifeLostDialog: LifeLostDialogState | null;

  // Timers / accumulators
  accum: TimerAccums;
  lastTime: number;
  frameDt: number;

  // Grouped sub-state
  battleAnim: BattleAnimState;
  banner: BannerState;
  ctx: FrameContext;
  frame: FrameData;
  lobby: LobbyState;

  // UI / mode
  mode: Mode;
  paused: boolean;
  quitPending: boolean;
  quitTimer: number;
  quitMessage: string;
  optionsReturnMode: Mode | null;
  optionsCursor: number;

  // Settings (mutable object, never reassigned after init)
  settings: GameSettings;
  controlsState: ControlsState;

  // Score display
  scoreDeltas: { playerId: number; delta: number; total: number; cx: number; cy: number }[];
  scoreDeltaTimer: number;
  scoreDeltaOnDone: (() => void) | null;
  preScores: readonly number[];
  gameStats: PlayerStats[];

  // Input tracking
  mouseJoinedSlot: number;
  /** True when the player is using direct touch on the canvas (not d-pad). */
  directTouchActive: boolean;
}

/** Default frame delta time (assumes 60fps). */
const DEFAULT_FRAME_DT = 1 / 60;

export function createRuntimeState(): RuntimeState {
  return {
    state: null! as GameState,
    overlay: { selection: { highlighted: null, selected: null } },
    controllers: [],

    reselectQueue: [],
    reselectionPids: [],
    selectionStates: new Map(),
    castleBuilds: [],
    castleBuildOnDone: null,
    lifeLostDialog: null,

    accum: createTimerAccums(),
    lastTime: 0,
    frameDt: DEFAULT_FRAME_DT,

    battleAnim: createBattleAnimState(),
    banner: createBannerState(),
    ctx: null! as FrameContext, // computed at top of every mainLoop frame
    frame: { crosshairs: [], phantoms: {} },
    lobby: {
      joined: new Array(MAX_PLAYERS).fill(false),
      active: false,
      timerAccum: 0,
      seed: 0,
      map: null,
    },

    mode: Mode.STOPPED,
    paused: false,
    quitPending: false,
    quitTimer: 0,
    quitMessage: "",
    optionsReturnMode: null,
    optionsCursor: 0,

    settings: loadSettings(),
    controlsState: createControlsState(),

    scoreDeltas: [],
    scoreDeltaTimer: 0,
    scoreDeltaOnDone: null,
    preScores: [],
    gameStats: [],

    mouseJoinedSlot: -1,
    directTouchActive: false,
  };
}
