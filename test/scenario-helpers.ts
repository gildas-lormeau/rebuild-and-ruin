/**
 * Scenario test DSL — headless scripted game scenarios.
 *
 * Wraps createHeadlessRuntime with high-level helpers for advancing phases,
 * manipulating state, and asserting game/camera/UI conditions. Designed for
 * agents to quickly reproduce bugs described in plain language.
 *
 * Run with: bun test/scenario.test.ts
 */

import { fireCannon, resolveBalloons, tickCannonballs } from "../src/battle-system.ts";
import { placePiece } from "../src/build-system.ts";
import { placeCannon, resetCannonFacings } from "../src/cannon-system.ts";
import type { PlayerController } from "../src/controller-interfaces.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
  LIFE_LOST_AI_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../src/game-constants.ts";
import {
  computeCannonLimitsForPhase,
  eliminatePlayer,
  finalizeBuildPhase,
  nextPhase,
} from "../src/game-engine.ts";
import { gruntAttackTowers, tickGrunts } from "../src/grunt-system.ts";
import {
  createLifeLostDialogState,
  resolveLifeLostDialogRuntime,
  tickLifeLostDialogRuntime,
} from "../src/life-lost.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "../src/online-checkpoints.ts";
import type { TransitionContext } from "../src/online-phase-transitions.ts";
import { serializePlayers } from "../src/online-serialize.ts";
import type { WatcherTimingState } from "../src/online-types.ts";
import {
  type BannerState,
  createBannerState,
  showBannerTransition,
} from "../src/phase-banner.ts";
import { PLAYER_COLORS } from "../src/player-config.ts";
import { createCameraSystem } from "../src/runtime-camera.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  processHeadlessReselection,
} from "../src/runtime-headless.ts";
import type { CameraSystem } from "../src/runtime-types.ts";
import type { PieceShape } from "../src/pieces.ts";
import {
  type BattleAnimState,
  CannonMode,
  computeFrameContext,
  type FrameContext,
  type FrameContextInputs,
  type GameState,
  type LifeLostDialogState,
  LifeLostChoice,
  Mode,
  Phase,
} from "../src/types.ts";
import { assert } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Scenario factory
// ---------------------------------------------------------------------------

export interface Scenario {
  readonly state: GameState;
  readonly controllers: PlayerController[];
  readonly runtime: HeadlessRuntime;

  // Phase advancement
  advanceTo(phase: Phase): void;
  runCannon(): void;
  runBattle(durationSec?: number): void;
  runBuild(durationSec?: number): void;
  finalizeBuild(): { needsReselect: number[]; eliminated: number[] };
  processReselection(needsReselect: readonly number[]): void;
  playRound(): { needsReselect: number[]; eliminated: number[] };

  // State manipulation
  setLives(playerId: number, lives: number): void;
  clearWalls(playerId: number): void;
  eliminatePlayer(playerId: number): void;

  // Scripted player actions
  placeCannonAt(playerId: number, row: number, col: number, mode?: CannonMode): boolean;
  placePieceAt(playerId: number, piece: PieceShape, row: number, col: number): boolean;
  fireAt(playerId: number, cannonIdx: number, row: number, col: number): boolean;

  // Sub-system creation for isolated testing
  createCamera(overrides?: Partial<CameraTestDeps>): CameraTestHandle;
  createBanner(): BannerState;
  createBattleAnim(): BattleAnimState;
  createLifeLostDialog(
    needsReselect: number[],
    eliminated?: number[],
  ): LifeLostDialogState;
  tickLifeLostDialog(
    dialog: LifeLostDialogState,
    dt: number,
  ): LifeLostDialogState | null;

  // Online transition testing
  createTransitionContext(overrides?: Partial<TransitionTestDeps>): TransitionContext;
}

export interface TransitionTestDeps {
  myPlayerId: number;
}

export interface CameraTestDeps {
  mode: Mode;
  phase: Phase;
  myPlayerId: number;
  firstHumanPlayerId: number;
  isSelectionReady: boolean;
  humanIsReselecting: boolean;
  mobileAutoZoom: boolean;
}

export interface CameraTestHandle {
  camera: CameraSystem;
  tick: () => void;
  setCtx: (overrides: Partial<CameraTestDeps>) => void;
}

export function createScenario(seed = 42): Scenario {
  const runtime = createHeadlessRuntime(seed);
  const { state, controllers } = runtime;
  const playerCount = runtime.playerCount;

  function advanceTo(phase: Phase): void {
    for (let i = 0; i < 6 && state.phase !== phase; i++) {
      nextPhase(state);
    }
    assert(
      state.phase === phase,
      `Failed to advance to ${phase}, stuck at ${state.phase}`,
    );
  }

  function runCannon(): void {
    resetCannonFacings(state);
    computeCannonLimitsForPhase(state);
    for (let i = 0; i < playerCount; i++) {
      const player = state.players[i]!;
      if (player.eliminated) continue;
      const ctrl = controllers[i]!;
      ctrl.placeCannons(state, state.cannonLimits[i]!);
      ctrl.flushCannons(state, state.cannonLimits[i]!);
    }
  }

  function runBattle(durationSec = BATTLE_TIMER): void {
    resolveBalloons(state);
    nextPhase(state);
    for (const ctrl of controllers) ctrl.resetBattle(state);

    let t = 0;
    const dt = 0.1;
    while (t < durationSec || state.cannonballs.length > 0) {
      if (t < durationSec) {
        for (let i = 0; i < playerCount; i++) {
          if (state.players[i]!.eliminated) continue;
          controllers[i]!.battleTick(state, dt);
        }
      }
      gruntAttackTowers(state, dt);
      tickCannonballs(state, dt);
      t += dt;
    }
    for (const ctrl of controllers) ctrl.onBattleEnd();
    nextPhase(state);
  }

  function runBuild(durationSec = BUILD_TIMER + 1): void {
    for (let i = 0; i < playerCount; i++) {
      if (state.players[i]!.eliminated) continue;
      controllers[i]!.startBuild(state);
    }

    let t = 0;
    let gruntAccum = 0;
    const dt = 0.5;
    while (t < durationSec) {
      gruntAccum += dt;
      if (gruntAccum >= 1.0) {
        gruntAccum -= 1.0;
        tickGrunts(state);
      }
      for (let i = 0; i < playerCount; i++) {
        if (state.players[i]!.eliminated) continue;
        controllers[i]!.buildTick(state, dt);
      }
      t += dt;
    }
    for (const ctrl of controllers) ctrl.endBuild(state);
  }

  function doFinalizeBuild() {
    return finalizeBuildPhase(state);
  }

  function doProcessReselection(needsReselect: readonly number[]) {
    processHeadlessReselection(runtime, needsReselect);
  }

  function playRound() {
    runCannon();
    runBattle();
    runBuild();
    return doFinalizeBuild();
  }

  function setLives(playerId: number, lives: number) {
    state.players[playerId]!.lives = lives;
  }

  function clearWalls(playerId: number) {
    state.players[playerId]!.walls.clear();
    state.players[playerId]!.interior.clear();
  }

  function doEliminatePlayer(playerId: number) {
    eliminatePlayer(state.players[playerId]!);
  }

  function doPlaceCannonAt(
    playerId: number,
    row: number,
    col: number,
    mode: CannonMode = CannonMode.NORMAL,
  ): boolean {
    const player = state.players[playerId]!;
    const max = state.cannonLimits[playerId] ?? 99;
    return placeCannon(player, row, col, max, mode, state);
  }

  function doPlacePieceAt(
    playerId: number,
    piece: PieceShape,
    row: number,
    col: number,
  ): boolean {
    return placePiece(state, playerId, piece, row, col);
  }

  function doFireAt(
    playerId: number,
    cannonIdx: number,
    row: number,
    col: number,
  ): boolean {
    return fireCannon(state, playerId, cannonIdx, row, col);
  }

  function createCamera(
    overrides: Partial<CameraTestDeps> = {},
  ): CameraTestHandle {
    const defaults: CameraTestDeps = {
      mode: Mode.GAME,
      phase: state.phase,
      myPlayerId: 0,
      firstHumanPlayerId: 0,
      isSelectionReady: false,
      humanIsReselecting: false,
      mobileAutoZoom: true,
    };
    let ctx: FrameContext = buildFrameCtx({ ...defaults, ...overrides });

    function buildFrameCtx(deps: CameraTestDeps): FrameContext {
      const inputs: FrameContextInputs = {
        mode: deps.mode,
        phase: deps.phase,
        timer: state.timer,
        paused: false,
        quitPending: false,
        hasLifeLostDialog: false,
        isSelectionReady: deps.isSelectionReady,
        humanIsReselecting: deps.humanIsReselecting,
        myPlayerId: deps.myPlayerId,
        firstHumanPlayerId: deps.firstHumanPlayerId,
        isHost: true,
        remoteHumanSlots: new Set(),
        mobileAutoZoom: deps.mobileAutoZoom,
      };
      return computeFrameContext(inputs);
    }

    const camera = createCameraSystem({
      getState: () => state,
      getCtx: () => ctx,
      getFrameDt: () => 1 / 60,
      setFrameAnnouncement: () => {},
    });
    camera.enableMobileZoom();

    return {
      camera,
      tick: () => {
        camera.tickCamera();
        camera.updateViewport();
      },
      setCtx: (o) => {
        ctx = buildFrameCtx({ ...defaults, ...overrides, ...o });
      },
    };
  }

  function createBanner(): BannerState {
    return createBannerState();
  }

  function createBattleAnimState(): BattleAnimState {
    return {
      impacts: [],
      territory: [],
      walls: [],
      flights: [],
    };
  }

  function doCreateLifeLostDialog(
    needsReselect: number[],
    eliminated: number[] = [],
  ): LifeLostDialogState {
    return createLifeLostDialogState({
      needsReselect,
      eliminated,
      state,
      isHost: true,
      myPlayerId: 0,
      remoteHumanSlots: new Set(),
      isHumanController: () => false,
    });
  }

  function doTickLifeLostDialog(
    dialog: LifeLostDialogState,
    dt: number,
  ): LifeLostDialogState | null {
    return tickLifeLostDialogRuntime({
      dt,
      lifeLostDialog: dialog,
      lifeLostAiDelay: LIFE_LOST_AI_DELAY,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      isHost: true,
      render: () => {},
      logResolved: () => {},
      resolveHostDialog: (d) =>
        resolveLifeLostDialogRuntime({
          lifeLostDialog: d,
          afterLifeLostResolved: () => true,
        }),
      onNonHostResolved: () => {},
    });
  }

  function doCreateTransitionContext(
    overrides: Partial<TransitionTestDeps> = {},
  ): TransitionContext {
    const myPlayerId = overrides.myPlayerId ?? 0;
    const banner = createBannerState();
    const battleAnim = createBattleAnimState();
    const watcherTiming: WatcherTimingState = {
      phaseStartTime: 0,
      phaseDuration: 0,
      countdownStartTime: 0,
      countdownDuration: 0,
    };
    const checkpointDeps: CheckpointDeps = {
      state,
      battleAnim,
      accum: { battle: 0, cannon: 0, select: 0, build: 0, grunt: 0 },
      remoteCrosshairs: new Map(),
      watcherCrosshairPos: new Map(),
      watcherOrbitParams: new Map(),
      watcherIdlePhases: new Map(),
      snapshotTerritory: () =>
        state.players.map((p) => new Set(p.interior)),
    };

    return {
      getState: () => state,
      getMyPlayerId: () => myPlayerId,
      getControllers: () => controllers,
      showBanner: (text, onDone, reveal, newBattle) => {
        showBannerTransition({
          banner,
          state,
          battleAnim,
          text,
          onDone,
          reveal,
          newBattle,
          setModeBanner: () => {},
        });
      },
      banner,
      clearSelectionOverlay: () => {},
      now: () => performance.now(),
      watcherTiming,
      setMode: () => {},
      battleCountdown: 3,
      bannerDuration: 3,
      playerColors: PLAYER_COLORS,
      applyCannonStartData: (msg) =>
        applyCannonStartCheckpoint(msg, checkpointDeps),
      applyBattleStartData: (msg) =>
        applyBattleStartCheckpoint(msg, checkpointDeps),
      applyBuildStartData: (msg) =>
        applyBuildStartCheckpoint(msg, checkpointDeps),
      applyPlayersCheckpoint: (s, players) =>
        serializePlayers(s),
      resetZoneState: () => {},
      finalizeCastleConstruction: () => {},
      enterCannonPlacePhase: () => {},
      getSelectionStates: () => new Map(),
      setCastleBuildFromPlans: () => {},
      setCastleBuildViewport: () => {},
      setBattleFlights: () => {},
      snapshotTerritory: () =>
        state.players.map((p) => new Set(p.interior)),
      showLifeLostDialog: () => {},
      showScoreDeltas: (_pre, onDone) => onDone(),
      render: () => {},
      setGameOverFrame: () => {},
    };
  }

  return {
    state,
    controllers,
    runtime,
    advanceTo,
    runCannon,
    runBattle,
    runBuild,
    finalizeBuild: doFinalizeBuild,
    processReselection: doProcessReselection,
    playRound,
    setLives,
    clearWalls,
    eliminatePlayer: doEliminatePlayer,
    placeCannonAt: doPlaceCannonAt,
    placePieceAt: doPlacePieceAt,
    fireAt: doFireAt,
    createCamera,
    createBanner,
    createBattleAnim: createBattleAnimState,
    createLifeLostDialog: doCreateLifeLostDialog,
    tickLifeLostDialog: doTickLifeLostDialog,
    createTransitionContext: doCreateTransitionContext,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function assertPhase(s: Scenario, expected: Phase): void {
  assert(
    s.state.phase === expected,
    `Expected phase ${expected}, got ${s.state.phase}`,
  );
}

export function assertLives(
  s: Scenario,
  playerId: number,
  expected: number,
): void {
  const actual = s.state.players[playerId]!.lives;
  assert(
    actual === expected,
    `Expected player ${playerId} lives=${expected}, got ${actual}`,
  );
}

export function assertEliminated(s: Scenario, playerId: number): void {
  assert(
    s.state.players[playerId]!.eliminated,
    `Expected player ${playerId} to be eliminated`,
  );
}

export function assertNotEliminated(s: Scenario, playerId: number): void {
  assert(
    !s.state.players[playerId]!.eliminated,
    `Expected player ${playerId} to NOT be eliminated`,
  );
}

export function assertHasWalls(s: Scenario, playerId: number): void {
  assert(
    s.state.players[playerId]!.walls.size > 0,
    `Expected player ${playerId} to have walls`,
  );
}

export function assertNoWalls(s: Scenario, playerId: number): void {
  assert(
    s.state.players[playerId]!.walls.size === 0,
    `Expected player ${playerId} to have no walls`,
  );
}

export function assertCameraZone(
  handle: CameraTestHandle,
  expected: number | null,
): void {
  const actual = handle.camera.getCameraZone();
  assert(
    actual === expected,
    `Expected camera zone ${expected}, got ${actual}`,
  );
}

export function assertBannerNewWallsMatch(
  banner: BannerState,
  state: GameState,
): void {
  assert(
    banner.newWalls !== undefined,
    "Expected banner.newWalls to be defined",
  );
  for (let pid = 0; pid < state.players.length; pid++) {
    const bannerWalls = banner.newWalls![pid];
    const stateWalls = state.players[pid]!.walls;
    if (!bannerWalls) continue;
    for (const key of bannerWalls) {
      assert(
        stateWalls.has(key),
        `banner.newWalls[${pid}] has tile ${key} not in player walls (debris leak)`,
      );
    }
  }
}

export function assertLifeLostLabel(
  entry: { choice: LifeLostChoice; lives: number },
  expected: "Continuing..." | "Abandoned" | "none",
): void {
  if (expected === "none") {
    assert(entry.lives === 0, "Expected eliminated entry (lives=0)");
    return;
  }
  assert(entry.lives > 0, `Expected lives > 0 for label "${expected}"`);
  if (expected === "Continuing...") {
    assert(
      entry.choice === LifeLostChoice.CONTINUE,
      `Expected CONTINUE choice, got ${entry.choice}`,
    );
  } else {
    assert(
      entry.choice === LifeLostChoice.ABANDON,
      `Expected ABANDON choice, got ${entry.choice}`,
    );
  }
}
