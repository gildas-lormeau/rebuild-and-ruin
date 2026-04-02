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
import { recheckTerritory, placePiece } from "../src/build-system.ts";
import { placeCannon, resetCannonFacings } from "../src/cannon-system.ts";
import { GRID_COLS, GRID_ROWS } from "../src/grid.ts";
import type { PlayerController } from "../src/controller-interfaces.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../src/game-constants.ts";
import { nextPhase } from "../src/game-engine.ts";
import {
  computeCannonLimitsForPhase,
  eliminatePlayer,
  finalizeBuildPhase,
} from "../src/phase-setup.ts";
import { tickGrunts } from "../src/grunt-movement.ts";
import { gruntAttackTowers } from "../src/grunt-system.ts";
import {
  createLifeLostDialogState,
  tickLifeLostDialog,
} from "../src/life-lost.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
} from "../src/checkpoint-data.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "../src/online-checkpoints.ts";
import type { TransitionContext } from "../src/online-phase-transitions.ts";
import { applyPlayersCheckpoint } from "../src/online-serialize.ts";
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
import type { PieceShape } from "../src/pieces.ts";
import {
  type CameraSystem,
  computeFrameContext,
  type FrameContext,
  type FrameContextInputs,
} from "../src/runtime-types.ts";
import {
  type BattleAnimState,
  CannonMode,
  emptyFreshInterior,
  type GameState,
  type LifeLostDialogState,
  LifeLostChoice,
  Mode,
  Phase,
} from "../src/types.ts";
import { isGrass, packTile } from "../src/spatial.ts";
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
  playRounds(n: number): void;

  // State inspection
  describe(): string;

  // State manipulation
  setLives(playerId: number, lives: number): void;
  clearWalls(playerId: number): void;
  eliminatePlayer(playerId: number): void;
  destroyWalls(playerId: number, count: number): number;
  destroyCannon(playerId: number, cannonIdx: number): void;

  // Tile finders
  findGrassTile(playerId: number): { row: number; col: number } | null;
  findInteriorTile(playerId: number): { row: number; col: number } | null;
  findEnemyWallTile(playerId: number): { row: number; col: number; owner: number } | null;

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
  onlinePlayerId: number;
}

export interface CameraTestDeps {
  mode: Mode;
  phase: Phase;
  onlinePlayerId: number;
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
      ctrl.finalizeCannonPhase(state, state.cannonLimits[i]!);
    }
  }

  function runBattle(durationSec = BATTLE_TIMER): void {
    resolveBalloons(state);
    nextPhase(state);
    for (const ctrl of controllers) ctrl.initBattleState(state);

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
    for (const ctrl of controllers) ctrl.endBattle();
    nextPhase(state);
  }

  function runBuild(durationSec = BUILD_TIMER + 1): void {
    for (let i = 0; i < playerCount; i++) {
      if (state.players[i]!.eliminated) continue;
      controllers[i]!.startBuildPhase(state);
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
    for (const ctrl of controllers) ctrl.finalizeBuildPhase(state);
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

  function doPlayRounds(n: number): void {
    for (let i = 0; i < n; i++) {
      const { needsReselect } = playRound();
      if (needsReselect.length > 0) {
        doProcessReselection(needsReselect);
      }
      if (state.players.every((p) => p.eliminated)) break;
      // Advance back to CANNON_PLACE for the next round
      if (i < n - 1) advanceTo(Phase.CANNON_PLACE);
    }
  }

  function setLives(playerId: number, lives: number) {
    state.players[playerId]!.lives = lives;
  }

  function clearWalls(playerId: number) {
    state.players[playerId]!.walls.clear();
    state.players[playerId]!.interior = emptyFreshInterior();
  }

  function doEliminatePlayer(playerId: number) {
    eliminatePlayer(state.players[playerId]!);
  }

  function describe(): string {
    const phaseName = Object.entries(Phase).find(
      ([, v]) => v === state.phase,
    )?.[0] ?? state.phase;
    const parts = [`Phase:${phaseName}`];
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i]!;
      if (p.eliminated) {
        parts.push(`P${i}:elim`);
        continue;
      }
      const alive = p.cannons.filter((c) => c.hp > 0).length;
      parts.push(
        `P${i}: ${p.lives}\u2665 ${p.walls.size}w ${alive}c ${p.interior.size}t ${p.score}pts`,
      );
    }
    parts.push(`round:${state.round}`);
    return parts.join(" | ");
  }

  function doDestroyWalls(playerId: number, count: number): number {
    const player = state.players[playerId]!;
    let removed = 0;
    for (const key of player.walls) {
      if (removed >= count) break;
      player.walls.delete(key);
      removed++;
    }
    recheckTerritory(state);
    return removed;
  }

  function doDestroyCannon(playerId: number, cannonIdx: number): void {
    const cannon = state.players[playerId]?.cannons[cannonIdx];
    if (cannon) cannon.hp = 0;
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

  /** Tiles blocked by entities (towers, cannons, houses, burning pits). */
  function buildEntityBlockedSet(): Set<number> {
    const blocked = new Set<number>();
    for (const t of state.map.towers)
      for (let dr = 0; dr < 2; dr++)
        for (let dc = 0; dc < 2; dc++)
          blocked.add(packTile(t.row + dr, t.col + dc));
    for (const p of state.players)
      for (const cn of p.cannons) blocked.add(packTile(cn.row, cn.col));
    for (const h of state.map.houses) blocked.add(packTile(h.row, h.col));
    for (const pit of state.burningPits)
      blocked.add(packTile(pit.row, pit.col));
    return blocked;
  }

  function doFindGrassTile(
    playerId: number,
  ): { row: number; col: number } | null {
    const zone = state.playerZones[playerId];
    const blocked = buildEntityBlockedSet();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (state.map.zones[r]![c] !== zone) continue;
        if (!isGrass(state.map.tiles, r, c)) continue;
        const key = packTile(r, c);
        if (blocked.has(key)) continue;
        // Also skip tiles claimed by any player (walls or interior)
        let claimed = false;
        for (const p of state.players) {
          if (p.walls.has(key) || p.interior.has(key)) {
            claimed = true;
            break;
          }
        }
        if (!claimed) return { row: r, col: c };
      }
    }
    return null;
  }

  function doFindInteriorTile(
    playerId: number,
  ): { row: number; col: number } | null {
    const player = state.players[playerId]!;
    const blocked = buildEntityBlockedSet();
    for (const key of player.interior) {
      if (!blocked.has(key)) {
        return { row: Math.floor(key / GRID_COLS), col: key % GRID_COLS };
      }
    }
    return null;
  }

  function doFindEnemyWallTile(
    playerId: number,
  ): { row: number; col: number; owner: number } | null {
    for (let i = 0; i < state.players.length; i++) {
      if (i === playerId) continue;
      const enemy = state.players[i]!;
      if (enemy.eliminated) continue;
      for (const key of enemy.walls) {
        const row = Math.floor(key / GRID_COLS);
        const col = key % GRID_COLS;
        return { row, col, owner: i };
      }
    }
    return null;
  }

  function createCamera(
    overrides: Partial<CameraTestDeps> = {},
  ): CameraTestHandle {
    const defaults: CameraTestDeps = {
      mode: Mode.GAME,
      phase: state.phase,
      onlinePlayerId: 0,
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
        onlinePlayerId: deps.onlinePlayerId,
        hostAtFrameStart: true,
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
      hostAtFrameStart: true,
      onlinePlayerId: 0,
      remoteHumanSlots: new Set(),
      isHumanController: () => false,
    });
  }

  function doTickLifeLostDialog(
    dialog: LifeLostDialogState,
    dt: number,
  ): LifeLostDialogState | null {
    const allResolved = tickLifeLostDialog(
      dialog,
      dt,
      LIFE_LOST_AUTO_DELAY,
      LIFE_LOST_MAX_TIMER,
    );
    return allResolved ? null : dialog;
  }

  function doCreateTransitionContext(
    overrides: Partial<TransitionTestDeps> = {},
  ): TransitionContext {
    const onlinePlayerId = overrides.onlinePlayerId ?? 0;
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
      watcherOrbitPhases: new Map(),
      snapshotTerritory: () =>
        state.players.map((p) => new Set(p.interior)),
    };

    return {
      getState: () => state,
      session: { onlinePlayerId },
      getControllers: () => controllers,
      setMode: () => {},
      now: () => performance.now(),
      ui: {
        showBanner: (text: string, onDone: () => void, preserveOldScene?: boolean, newBattle?: { territory: Set<number>[]; walls: Set<number>[] }, subtitle?: string) => {
          showBannerTransition({
            banner,
            state,
            battleAnim,
            text,
            subtitle,
            onDone,
            preserveOldScene,
            newBattle,
            setModeBanner: () => {},
          });
        },
        banner,
        render: () => {},
        watcherTiming,
        bannerDuration: 3,
      },
      checkpoint: {
        applyCannonStart: (data: CannonStartData) =>
          applyCannonStartCheckpoint(data, checkpointDeps),
        applyBattleStart: (data: BattleStartData) =>
          applyBattleStartCheckpoint(data, checkpointDeps),
        applyBuildStart: (data: BuildStartData) =>
          applyBuildStartCheckpoint(data, checkpointDeps),
        applyPlayersCheckpoint,
      },
      selection: {
        clearSelectionOverlay: () => {},
        getStates: () => new Map(),
        setCastleBuildFromPlans: () => {},
        setCastleBuildViewport: () => {},
      },
      battle: {
        setFlights: () => {},
        snapshotTerritory: () =>
          state.players.map((p) => new Set(p.interior)),
        beginBattle: () => {},
      },
      endPhase: {
        showLifeLostDialog: () => {},
        showScoreDeltas: (_pre: readonly number[], onDone: () => void) => onDone(),
        setGameOverFrame: () => {},
        playerColors: PLAYER_COLORS,
      },
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
    playRounds: doPlayRounds,
    setLives,
    clearWalls,
    describe,
    eliminatePlayer: doEliminatePlayer,
    destroyWalls: doDestroyWalls,
    destroyCannon: doDestroyCannon,
    findGrassTile: doFindGrassTile,
    findInteriorTile: doFindInteriorTile,
    findEnemyWallTile: doFindEnemyWallTile,
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
