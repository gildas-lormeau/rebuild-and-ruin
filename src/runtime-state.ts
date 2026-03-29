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
import { loadSettings } from "./game-ui-settings.ts";
import { type BannerState, createBannerState } from "./phase-banner.ts";
import { type GameSettings, MAX_PLAYERS } from "./player-config.ts";
import type { FrameData, PlayerStats, RenderOverlay } from "./render-types.ts";
import {
  type BattleAnimState,
  type ControlsState,
  createBattleAnimState,
  createControlsState,
  createTimerAccums,
  type FrameContext,
  type GameState,
  type LifeLostDialogState,
  type LobbyState,
  Mode,
  type SelectionState,
  type TimerAccums,
} from "./types.ts";

export interface RuntimeState {
  // Core game
  /** The current game state. IMPORTANT: guarded by an uninitialized sentinel
   *  before startGame() assigns a real value. Always check `isStateReady(rs)`
   *  or use `safeState(rs)` before accessing — direct access throws if uninitialized. */
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
  /** Per-frame context (dt, mode, etc.). IMPORTANT: guarded by an uninitialized
   *  sentinel before the first mainLoop tick. Same rules as `state` — check
   *  `isStateReady(rs)` before accessing. */
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
  scoreDeltas: {
    playerId: number;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
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
/**
 * Create a typed sentinel that throws a descriptive error on any property
 * access.  Replaces `null! as T` — same zero-cost for valid code paths,
 * but produces a clear "not yet initialized" error instead of a cryptic
 * "Cannot read properties of null" when accessed before assignment.
 */
const SENTINEL = Symbol("uninitialized");

/** Create initial runtime state. `state` and `ctx` are sentinel-guarded:
 * they throw on any property access until startGame() assigns real values.
 * All other fields are safe to access immediately. */
export function createRuntimeState(): RuntimeState {
  return {
    state: uninitializedSentinel<GameState>("state"),
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
    ctx: uninitializedSentinel<FrameContext>("ctx"),
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

/** Returns `rs.state` if initialized, `undefined` otherwise. */
export function safeState(rs: RuntimeState): GameState | undefined {
  return isStateReady(rs) ? rs.state : undefined;
}

/** Returns true when `rs.state` has been assigned a real GameState. */
export function isStateReady(rs: RuntimeState): boolean {
  return !(rs.state as unknown as Record<symbol, unknown>)[SENTINEL];
}

function uninitializedSentinel<T extends object>(name: string): T {
  const proxy = new Proxy<T>(Object.create(null), {
    get(_, prop) {
      if (prop === SENTINEL) return true;
      throw new Error(
        `rs.${name} accessed before initialization (property: ${String(prop)})`,
      );
    },
  });
  return proxy;
}
