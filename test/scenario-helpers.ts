/**
 * Scenario test DSL — headless scripted game scenarios.
 *
 * Wraps createHeadlessRuntime with high-level helpers for advancing phases,
 * manipulating state, and asserting game/camera/UI conditions. Designed for
 * agents to quickly reproduce bugs described in plain language.
 *
 * Run with: deno test --no-check test/scenario.test.ts
 */

import { fireCannon, resolveBalloons, tickCannonballs } from "../src/game/battle-system.ts";
import { placePiece } from "../src/game/build-system.ts";
import { placeCannon, resetCannonFacings, computeCannonLimitsForPhase } from "../src/game/cannon-system.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import type { PlayerController } from "../src/shared/system-interfaces.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
} from "../src/shared/game-constants.ts";
import { nextPhase } from "../src/game/game-engine.ts";
import {
  enterBattleFromCannon,
  finalizeBuildPhase,
} from "../src/game/phase-setup.ts";
import { tickGrunts } from "../src/game/grunt-movement.ts";
import { gruntAttackTowers } from "../src/game/grunt-system.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  processHeadlessReselection,
} from "./runtime-headless.ts";
import type { PieceShape } from "../src/shared/pieces.ts";
import type { GameState } from "../src/shared/types.ts";
import { GAME_EVENT, emitGameEvent, type GameEventBus } from "../src/shared/game-event-bus.ts";
import { isGrass, packTile } from "../src/shared/spatial.ts";
import { assert } from "@std/assert";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { applyBattleStartCheckpoint, applyBuildEndCheckpoint, applyBuildStartCheckpoint, applyCannonStartCheckpoint, type CheckpointDeps } from "../src/online/online-checkpoints.ts";
import { createBattleStartMessage, createBuildStartMessage, createCannonStartMessage, serializePlayersCheckpoint } from "../src/online/online-serialize.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { CannonMode, type BattleAnimState } from "../src/shared/battle-types.ts";

// ---------------------------------------------------------------------------
// Scenario factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tick callback (scenario-internal, not part of the bus)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  readonly state: GameState;
  readonly bus: GameEventBus;
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
  runGame(maxRounds?: number): void;

  // State inspection
  describe(): string;

  // Tile finders
  findGrassTile(playerId: ValidPlayerSlot): { row: number; col: number } | null;
  findInteriorTile(playerId: ValidPlayerSlot): { row: number; col: number } | null;
  findEnemyWallTile(playerId: ValidPlayerSlot): { row: number; col: number; owner: ValidPlayerSlot } | null;

  // Scripted player actions
  placeCannonAt(playerId: ValidPlayerSlot, row: number, col: number, mode?: CannonMode): boolean;
  placePieceAt(playerId: ValidPlayerSlot, piece: PieceShape, row: number, col: number): boolean;
  fireAt(playerId: ValidPlayerSlot, cannonIdx: number, row: number, col: number): boolean;

  /** Enable checkpoint relay: phase boundaries go through
   *  serialize → JSON string → parse → apply, same as a real WebSocket. */
  enableCheckpointRelay(): void;

  /** Hook: called before each relay apply to capture pre-state. */
  onRelayCapture: (() => { grid: string; state: string }) | null;
  /** Hook: called after each relay apply with pre-state for self-check. */
  onRelayVerify: ((label: string, before: { grid: string; state: string }) => void) | null;
  /** Access battleAnim from relay deps (null if relay not enabled or not yet initialized). */
  getRelayBattleAnim(): BattleAnimState | null;
}

export async function createScenario(seed = 42): Promise<Scenario> {
  const runtime = await createHeadlessRuntime(seed);
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

  // gameEnd has no production emission in the headless flow — emit on bus from here.
  function emitGameEnd(): void {
    emitGameEvent(state.bus, GAME_EVENT.GAME_END, { round: state.round });
  }

  let relayEnabled = false;
  let relayDeps: CheckpointDeps | null = null;
  let onRelayCapture: (() => { grid: string; state: string }) | null = null;
  let onRelayVerify: ((label: string, before: { grid: string; state: string }) => void) | null = null;

  /** Simulate JSON wire roundtrip: serialize → string → parse → apply.
   *  Fires onRelayCapture/onRelayVerify hooks for self-check. */
  function relay<T>(label: string, data: T, apply: (parsed: T, deps: CheckpointDeps) => void): void {
    if (!relayEnabled) return;
    if (!relayDeps) {
      relayDeps = {
        state,
        battleAnim: { impacts: [], territory: [], walls: [], flights: [] },
        accum: { battle: 0, cannon: 0, select: 0, build: 0, grunt: 0 },
        remoteCrosshairs: new Map(),
        watcherCrosshairPos: new Map(),
        watcherOrbitParams: new Map(),
        watcherOrbitAngles: new Map(),
        snapshotTerritory: () => state.players.map((p) => new Set(p.interior)),
      };
    }
    const before = onRelayCapture ? onRelayCapture() : null;
    apply(JSON.parse(JSON.stringify(data)), relayDeps);
    if (before && onRelayVerify) onRelayVerify(label, before);
  }

  function runCannon(): void {
    relay("cannon-start", createCannonStartMessage(state), applyCannonStartCheckpoint);
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
    const diff = enterBattleFromCannon(state);
    const flights = resolveBalloons(state);
    relay("battle-start", createBattleStartMessage(state, flights, diff ?? undefined), applyBattleStartCheckpoint);
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
    relay("build-start", createBuildStartMessage(state), applyBuildStartCheckpoint);
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
    relay(
      "build-end",
      { players: serializePlayersCheckpoint(state), scores: state.players.map((p) => p.score) },
      applyBuildEndCheckpoint,
    );
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
      if (i < n - 1) advanceTo(Phase.CANNON_PLACE);
    }
  }

  function runGame(maxRounds = 12): void {
    while (
      state.players.filter((player) => !player.eliminated).length > 1 &&
      state.round <= maxRounds
    ) {
      const { needsReselect } = playRound();
      if (needsReselect.length > 0) doProcessReselection(needsReselect);
    }
    emitGameEnd();
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

  return {
    state,
    bus: state.bus,
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
    runGame,
    describe,
    findGrassTile: doFindGrassTile,
    findInteriorTile: doFindInteriorTile,
    findEnemyWallTile: doFindEnemyWallTile,
    placeCannonAt: doPlaceCannonAt,
    placePieceAt: doPlacePieceAt,
    fireAt: doFireAt,
    enableCheckpointRelay: () => { relayEnabled = true; },
    get onRelayCapture() { return onRelayCapture; },
    set onRelayCapture(fn) { onRelayCapture = fn; },
    get onRelayVerify() { return onRelayVerify; },
    set onRelayVerify(fn) { onRelayVerify = fn; },
    getRelayBattleAnim: () => relayDeps?.battleAnim ?? null,
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


