/**
 * Scenario test DSL — headless scripted game scenarios.
 *
 * Wraps createHeadlessRuntime with high-level helpers for advancing phases,
 * manipulating state, and asserting game/camera/UI conditions. Designed for
 * agents to quickly reproduce bugs described in plain language.
 *
 * Run with: deno run test/scenario.test.ts
 */

import { fireCannon, resolveBalloons, tickCannonballs } from "../src/game/battle-system.ts";
import { clearPlayerWalls, deletePlayerWallBattle } from "../src/shared/board-occupancy.ts";
import { recheckTerritoryOnly, placePiece } from "../src/game/build-system.ts";
import { placeCannon, resetCannonFacings } from "../src/game/cannon-system.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import type { PlayerController } from "../src/shared/system-interfaces.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER
} from "../src/shared/game-constants.ts";
import { nextPhase } from "../src/game/game-engine.ts";
import {
  computeCannonLimitsForPhase,
  eliminatePlayer,
  finalizeBuildPhase,
} from "../src/game/phase-setup.ts";
import { tickGrunts } from "../src/game/grunt-movement.ts";
import { gruntAttackTowers } from "../src/game/grunt-system.ts";
import {
  createLifeLostDialogState,
  tickLifeLostDialog,
} from "../src/game/life-lost.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
} from "../src/shared/checkpoint-data.ts";
import type { TransitionContext } from "../src/online/online-phase-transitions.ts";
import {
  type BannerState,
  createBannerState,
  showBannerTransition,
} from "../src/game/phase-banner.ts";
import { PLAYER_COLORS } from "../src/shared/player-config.ts";
import { createCameraSystem } from "../src/runtime/runtime-camera.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  processHeadlessReselection,
} from "../src/runtime/runtime-headless.ts";
import type { PieceShape } from "../src/shared/pieces.ts";
import {
  computeFrameContext,
  type FrameContextInputs,
} from "../src/runtime/runtime-state.ts";
import { type CameraSystem, type FrameContext } from "../src/runtime/runtime-types.ts";
import { emptyFreshInterior } from "../src/shared/player-types.ts";
import type { GameState } from "../src/shared/types.ts";
import { isGrass, packTile } from "../src/shared/spatial.ts";
import { assert } from "./test-helpers.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { applyBattleStartCheckpoint, applyBuildEndCheckpoint, applyBuildStartCheckpoint, applyCannonStartCheckpoint, type CheckpointDeps } from "../src/online/online-checkpoints.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { Mode } from "../src/shared/ui-mode.ts";
import { LifeLostChoice, type LifeLostDialogState } from "../src/shared/dialog-types.ts";
import { CannonMode, type BattleAnimState } from "../src/shared/battle-types.ts";
import type { WatcherTimingState } from "../src/shared/tick-context.ts";

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
  finalizeBuild(): { needsReselect: ValidPlayerSlot[]; eliminated: ValidPlayerSlot[] };
  processReselection(needsReselect: readonly ValidPlayerSlot[]): void;
  playRound(): { needsReselect: ValidPlayerSlot[]; eliminated: ValidPlayerSlot[] };
  playRounds(n: number): void;

  // State inspection
  describe(): string;

  // State manipulation
  setLives(playerId: ValidPlayerSlot, lives: number): void;
  clearWalls(playerId: ValidPlayerSlot): void;
  eliminatePlayer(playerId: ValidPlayerSlot): void;
  destroyWalls(playerId: ValidPlayerSlot, count: number): number;
  destroyCannon(playerId: ValidPlayerSlot, cannonIdx: number): void;

  // Tile finders
  findGrassTile(playerId: ValidPlayerSlot): { row: number; col: number } | null;
  findInteriorTile(playerId: ValidPlayerSlot): { row: number; col: number } | null;
  findEnemyWallTile(playerId: ValidPlayerSlot): { row: number; col: number; owner: ValidPlayerSlot } | null;

  // Scripted player actions
  placeCannonAt(playerId: ValidPlayerSlot, row: number, col: number, mode?: CannonMode): boolean;
  placePieceAt(playerId: ValidPlayerSlot, piece: PieceShape, row: number, col: number): boolean;
  fireAt(playerId: ValidPlayerSlot, cannonIdx: number, row: number, col: number): boolean;

  // Sub-system creation for isolated testing
  createCamera(overrides?: Partial<CameraTestDeps>): CameraTestHandle;
  createBanner(): BannerState;
  createBattleAnim(): BattleAnimState;
  createLifeLostDialog(
    needsReselect: ValidPlayerSlot[],
    eliminated?: ValidPlayerSlot[],
  ): LifeLostDialogState;
  tickLifeLostDialog(
    dialog: LifeLostDialogState,
    dt: number,
  ): LifeLostDialogState | null;

  // Online transition testing
  createTransitionContext(overrides?: Partial<TransitionTestDeps>): TransitionContext;
}

export interface TransitionTestDeps {
  myPlayerId: PlayerSlotId;
}

export interface CameraTestDeps {
  mode: Mode;
  phase: Phase;
  myPlayerId: PlayerSlotId;
  isSelectionReady: boolean;
  humanIsReselecting: boolean;
  mobileAutoZoom: boolean;
  hasPointerPlayer: boolean;
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
    nextPhase(state);
    resolveBalloons(state);
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

  function doProcessReselection(needsReselect: readonly ValidPlayerSlot[]) {
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

  function setLives(playerId: ValidPlayerSlot, lives: number) {
    state.players[playerId]!.lives = lives;
  }

  function clearWalls(playerId: ValidPlayerSlot) {
    clearPlayerWalls(state.players[playerId]!);
    state.players[playerId]!.interior = emptyFreshInterior();
  }

  function doEliminatePlayer(playerId: ValidPlayerSlot) {
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

  function doDestroyWalls(playerId: ValidPlayerSlot, count: number): number {
    const player = state.players[playerId]!;
    let removed = 0;
    for (const key of player.walls) {
      if (removed >= count) break;
      deletePlayerWallBattle(player, key);
      removed++;
    }
    recheckTerritoryOnly(state);
    return removed;
  }

  function doDestroyCannon(playerId: ValidPlayerSlot, cannonIdx: number): void {
    const cannon = state.players[playerId]?.cannons[cannonIdx];
    if (cannon) cannon.hp = 0;
  }

  function doPlaceCannonAt(
    playerId: ValidPlayerSlot,
    row: number,
    col: number,
    mode: CannonMode = CannonMode.NORMAL,
  ): boolean {
    const player = state.players[playerId]!;
    const max = state.cannonLimits[playerId] ?? 99;
    return placeCannon(player, row, col, max, mode, state);
  }

  function doPlacePieceAt(
    playerId: ValidPlayerSlot,
    piece: PieceShape,
    row: number,
    col: number,
  ): boolean {
    return placePiece(state, playerId, piece, row, col);
  }

  function doFireAt(
    playerId: ValidPlayerSlot,
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
    playerId: ValidPlayerSlot,
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
    playerId: ValidPlayerSlot,
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
    playerId: ValidPlayerSlot,
  ): { row: number; col: number; owner: ValidPlayerSlot } | null {
    for (let i = 0; i < state.players.length; i++) {
      if (i === playerId) continue;
      const enemy = state.players[i]!;
      if (enemy.eliminated) continue;
      for (const key of enemy.walls) {
        const row = Math.floor(key / GRID_COLS);
        const col = key % GRID_COLS;
        return { row, col, owner: i as ValidPlayerSlot };
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
      myPlayerId: 0 as PlayerSlotId,
      isSelectionReady: false,
      humanIsReselecting: false,
      mobileAutoZoom: true,
      hasPointerPlayer: true,
    };
    let merged = { ...defaults, ...overrides };
    let ctx: FrameContext = buildFrameCtx(merged);

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
        hasPointerPlayer: deps.hasPointerPlayer,
        myPlayerId: deps.myPlayerId,
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
        merged = { ...defaults, ...overrides, ...o };
        ctx = buildFrameCtx(merged);
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
    needsReselect: ValidPlayerSlot[],
    eliminated: ValidPlayerSlot[] = [],
  ): LifeLostDialogState {
    return createLifeLostDialogState({
      needsReselect,
      eliminated,
      state,
      hostAtFrameStart: true,
      myPlayerId: 0 as ValidPlayerSlot,
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
    const myPlayerId = overrides.myPlayerId ?? (0 as PlayerSlotId);
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
      watcherOrbitAngles: new Map(),
      snapshotTerritory: () =>
        state.players.map((p) => new Set(p.interior)),
    };

    return {
      getState: () => state,
      session: { myPlayerId },
      getControllers: () => controllers,
      setMode: () => {},
      ui: {
        showBanner: (text: string, onDone: () => void, preservePrevScene?: boolean, newBattle?: { territory: Set<number>[]; walls: Set<number>[] }, subtitle?: string) => {
          showBannerTransition({
            banner,
            state,
            battleAnim,
            text,
            subtitle,
            onDone,
            preservePrevScene,
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
        applyCannonStart: (data: CannonStartData, capturePreState?: () => void) =>
          applyCannonStartCheckpoint(data, checkpointDeps, capturePreState),
        applyBattleStart: (data: BattleStartData, capturePreState?: () => void) =>
          applyBattleStartCheckpoint(data, checkpointDeps, capturePreState),
        applyBuildStart: (data: BuildStartData) =>
          applyBuildStartCheckpoint(data, checkpointDeps),
        applyBuildEnd: applyBuildEndCheckpoint,
      },
      selection: {
        clearSelectionOverlay: () => {},
        getStates: () => new Map(),
        setCastleBuildFromPlans: () => {},
        setCastleBuildViewport: () => {},
      },
      battleLifecycle: {
        setFlights: () => {},
        snapshotTerritory: () =>
          state.players.map((p) => new Set(p.interior)),
        getTerritory: () => [],
        getWalls: () => [],
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
  playerId: ValidPlayerSlot,
  expected: number,
): void {
  const actual = s.state.players[playerId]!.lives;
  assert(
    actual === expected,
    `Expected player ${playerId} lives=${expected}, got ${actual}`,
  );
}

export function assertEliminated(s: Scenario, playerId: ValidPlayerSlot): void {
  assert(
    s.state.players[playerId]!.eliminated,
    `Expected player ${playerId} to be eliminated`,
  );
}

export function assertNotEliminated(s: Scenario, playerId: ValidPlayerSlot): void {
  assert(
    !s.state.players[playerId]!.eliminated,
    `Expected player ${playerId} to NOT be eliminated`,
  );
}

export function assertHasWalls(s: Scenario, playerId: ValidPlayerSlot): void {
  assert(
    s.state.players[playerId]!.walls.size > 0,
    `Expected player ${playerId} to have walls`,
  );
}

export function assertNoWalls(s: Scenario, playerId: ValidPlayerSlot): void {
  assert(
    s.state.players[playerId]!.walls.size === 0,
    `Expected player ${playerId} to have no walls`,
  );
}

export function assertCameraZone(
  handle: CameraTestHandle,
  expected: number | undefined,
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
