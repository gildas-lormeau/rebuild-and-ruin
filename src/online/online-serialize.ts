/**
 * Serialization and deserialization helpers for online multiplayer checkpoints.
 * Pure functions that read/write GameState — no module-level state.
 *
 * Null vs undefined convention for optional fields:
 *   - `null`  — key is always present in the JSON object; receivers can rely on
 *     it existing (e.g., homeTowerIdx, activeModifier, frozenTiles,
 *     pendingUpgradeOffers). Use for fields where "absent" is a meaningful state.
 *   - `undefined` — key is omitted from JSON when empty/default, saving bandwidth
 *     (e.g., incendiary, upgrades, damagedWalls, balloonFlights). Receivers must
 *     use `?? defaultValue`.
 */

import { type FullStateMessage, MESSAGE } from "../../server/protocol.ts";
import { recomputeTerritoryFromWalls } from "../game/build-system.ts";
import { createCastle } from "../game/castle-generation.ts";
import { setPhase } from "../game/phase-setup.ts";
import type { BalloonFlight, Cannonball } from "../shared/battle-types.ts";
import type {
  BattleStartData,
  SerializedGrunt,
  SerializedHouse,
  SerializedPlayer,
} from "../shared/checkpoint-data.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import { GRID_COLS, GRID_ROWS, TILE_COUNT } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { Rng } from "../shared/rng.ts";
import {
  type GameState,
  setGameMode,
  type UpgradeOfferTuple,
} from "../shared/types.ts";
import type { UpgradeId } from "../shared/upgrade-defs.ts";
import { toCannonMode } from "./online-types.ts";

interface FullStateResult {
  balloonFlights?: {
    flight: { startX: number; startY: number; endX: number; endY: number };
    progress: number;
  }[];
}

/** Returned when validation fails — no state was mutated. */
type FullStateApplyResult = FullStateResult | null;

export function createBuildStartMessage(state: GameState) {
  return {
    type: MESSAGE.BUILD_START,
    round: state.round,
    timer: state.timer,
    players: serializePlayers(state),
    houses: state.map.houses.map((h) => ({
      row: h.row,
      col: h.col,
      zone: h.zone,
      alive: h.alive,
    })),
    grunts: serializeGrunts(state),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    rngSeed: state.rng.seed,
    pendingUpgradeOffers: state.modern?.pendingUpgradeOffers
      ? [...state.modern.pendingUpgradeOffers.entries()]
      : null,
    frozenTiles: state.modern?.frozenTiles
      ? [...state.modern.frozenTiles]
      : null,
  };
}

export function createCannonStartMessage(state: GameState) {
  return {
    type: MESSAGE.CANNON_START,
    timer: state.timer,
    limits: [...state.cannonLimits],
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    houses: state.map.houses.map((h) => ({
      row: h.row,
      col: h.col,
      zone: h.zone,
      alive: h.alive,
    })),
  };
}

export function createBattleStartMessage(
  state: GameState,
  flights?: readonly BalloonFlight[],
  modifierDiff?: BattleStartData["modifierDiff"],
) {
  return {
    type: MESSAGE.BATTLE_START,
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    capturedCannons: state.capturedCannons.map((cc) => ({
      victimId: cc.victimId,
      capturerId: cc.capturerId,
      cannonIdx: cc.cannonIdx,
    })),
    burningPits: serializeBurningPits(state),
    towerAlive: [...state.towerAlive],
    flights:
      flights && flights.length > 0
        ? flights.map((flight) => ({
            startX: flight.startX,
            startY: flight.startY,
            endX: flight.endX,
            endY: flight.endY,
          }))
        : null,
    frozenTiles: state.modern?.frozenTiles
      ? [...state.modern.frozenTiles]
      : null,
    modifierDiff: modifierDiff
      ? {
          id: modifierDiff.id,
          label: modifierDiff.label,
          changedTiles: [...modifierDiff.changedTiles],
          gruntsSpawned: modifierDiff.gruntsSpawned,
        }
      : null,
  };
}

export function createFullStateMessage(
  state: GameState,
  migrationSeq: number,
  flights?: readonly {
    flight: { startX: number; startY: number; endX: number; endY: number };
    progress: number;
  }[],
): FullStateMessage {
  return {
    type: MESSAGE.FULL_STATE,
    migrationSeq,
    phase: Phase[state.phase],
    round: state.round,
    timer: state.timer,
    battleCountdown: state.battleCountdown,
    maxRounds: state.maxRounds,
    shotsFired: state.shotsFired,
    rngState: state.rng.getState(),
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    houses: state.map.houses.map((h) => ({
      row: h.row,
      col: h.col,
      zone: h.zone,
      alive: h.alive,
    })),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    cannonLimits: [...state.cannonLimits],
    playerZones: [...state.playerZones],
    gameMode: state.gameMode,
    activeModifier: state.modern?.activeModifier ?? null,
    lastModifierId: state.modern?.lastModifierId ?? null,
    pendingUpgradeOffers: state.modern?.pendingUpgradeOffers
      ? [...state.modern.pendingUpgradeOffers.entries()]
      : null,
    frozenTiles: state.modern?.frozenTiles
      ? [...state.modern.frozenTiles]
      : null,
    towerPendingRevive: [...state.towerPendingRevive],
    capturedCannons: state.capturedCannons.map((cc) => ({
      victimId: cc.victimId,
      capturerId: cc.capturerId,
      cannonIdx: cc.cannonIdx,
    })),
    balloonHits: (() => {
      const hits: {
        playerId: ValidPlayerSlot;
        cannonIdx: number;
        count: number;
        capturerIds: number[];
      }[] = [];
      for (const [cannon, hit] of state.balloonHits) {
        // Find which player owns this cannon
        for (const player of state.players) {
          const idx = player.cannons.indexOf(cannon);
          if (idx >= 0) {
            hits.push({
              playerId: player.id,
              cannonIdx: idx,
              count: hit.count,
              capturerIds: hit.capturerIds,
            });
            break;
          }
        }
      }
      return hits;
    })(),
    cannonballs: state.cannonballs.map((b) => ({
      ...copyCannonballCore(b),
      incendiary: b.incendiary ? true : undefined,
    })),
    balloonFlights:
      flights && flights.length > 0
        ? flights.map((balloonFlight) => ({
            ...balloonFlight.flight,
            progress: balloonFlight.progress,
          }))
        : undefined,
  };
}

export function serializePlayers(state: GameState) {
  return state.players.map((player) => ({
    id: player.id,
    walls: [...player.walls],
    cannons: player.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      mode: c.mode,
      facing: c.facing ?? 0,
    })),
    homeTowerIdx: player.homeTower?.index ?? null,
    castleWallTiles: [...player.castleWallTiles],
    lives: player.lives,
    eliminated: player.eliminated,
    score: player.score,
    upgrades:
      player.upgrades.size > 0 ? [...player.upgrades.entries()] : undefined,
    damagedWalls:
      player.damagedWalls.size > 0 ? [...player.damagedWalls] : undefined,
  }));
}

export function restoreFullStateSnapshot(
  state: GameState,
  msg: FullStateMessage,
): FullStateApplyResult {
  const error = validateFullState(state, msg);
  if (error) {
    console.error(`[checkpoint] validation failed: ${error}`);
    return null;
  }

  const nextPhase = Phase[msg.phase as keyof typeof Phase]!;
  setPhase(state, nextPhase);
  state.round = msg.round;
  state.timer = msg.timer;
  state.battleCountdown = msg.battleCountdown;
  state.maxRounds = msg.maxRounds;
  state.shotsFired = msg.shotsFired;
  state.cannonLimits = msg.cannonLimits;
  state.playerZones = msg.playerZones;
  state.towerPendingRevive = new Set(msg.towerPendingRevive);
  state.towerAlive = msg.towerAlive;
  setGameMode(
    state,
    msg.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
  );
  if (state.modern) {
    state.modern.activeModifier =
      (msg.activeModifier as NonNullable<
        GameState["modern"]
      >["activeModifier"]) ?? null;
    state.modern.lastModifierId =
      (msg.lastModifierId as NonNullable<
        GameState["modern"]
      >["lastModifierId"]) ?? null;
    state.modern.pendingUpgradeOffers = msg.pendingUpgradeOffers
      ? new Map(
          msg.pendingUpgradeOffers.map(([pid, offers]) => [
            pid as ValidPlayerSlot,
            offers as UpgradeOfferTuple,
          ]),
        )
      : null;
    state.modern.frozenTiles = msg.frozenTiles
      ? new Set(msg.frozenTiles)
      : null;
  }
  state.burningPits = msg.burningPits.map((pit) => ({
    row: pit.row,
    col: pit.col,
    roundsLeft: pit.roundsLeft,
  }));
  state.bonusSquares = msg.bonusSquares.map((bonus) => ({
    row: bonus.row,
    col: bonus.col,
    zone: bonus.zone,
  }));

  // Restore RNG internal state
  const rng = new Rng(0);
  rng.setState(msg.rngState);
  state.rng = rng;

  // Reuse existing checkpoint helpers
  applyPlayersCheckpoint(state, msg.players);
  applyGruntsCheckpoint(state, msg.grunts);

  applyHousesCheckpoint(state, msg.houses);

  restoreCannonballs(state, msg);
  applyCapturedCannons(state, msg.capturedCannons);
  restoreBalloonHits(state, msg);

  return {
    balloonFlights: msg.balloonFlights?.map((flight) => ({
      flight: {
        startX: flight.startX,
        startY: flight.startY,
        endX: flight.endX,
        endY: flight.endY,
      },
      progress: flight.progress,
    })),
  };
}

/** Replace the full houses array from checkpoint data. */
export function applyHousesCheckpoint(
  state: GameState,
  houses: readonly SerializedHouse[],
): void {
  state.map.houses = houses.map((h) => ({
    row: h.row,
    col: h.col,
    zone: h.zone,
    alive: h.alive,
  }));
}

export function applyPlayersCheckpoint(
  state: GameState,
  serialized: readonly SerializedPlayer[],
): void {
  for (const sp of serialized) {
    const player = state.players[sp.id];
    if (!player) continue;

    player.walls = new Set(sp.walls);
    player.cannons = sp.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      mode: toCannonMode(c.mode),
      facing: c.facing ?? 0,
    }));
    player.homeTower =
      sp.homeTowerIdx !== null &&
      sp.homeTowerIdx >= 0 &&
      sp.homeTowerIdx < state.map.towers.length
        ? state.map.towers[sp.homeTowerIdx]!
        : null;
    player.castleWallTiles = new Set(sp.castleWallTiles ?? []);
    player.lives = sp.lives;
    player.eliminated = sp.eliminated;
    player.score = sp.score;
    player.upgrades = new Map((sp.upgrades ?? []) as [UpgradeId, number][]);
    player.damagedWalls = new Set(sp.damagedWalls ?? []);
    // Rebuild castle geometry from home tower (deterministic from map)
    player.castle = player.homeTower
      ? createCastle(player.homeTower, state.map.tiles, state.map.towers)
      : null;
    // Recompute interior + ownedTowers from walls (deterministic)
    recomputeTerritoryFromWalls(state, player);
  }
}

export function applyGruntsCheckpoint(
  state: GameState,
  serialized: readonly SerializedGrunt[],
): void {
  state.grunts = serialized.map(deserializeGrunt);
}

export function createGameOverPayload(
  winner: { id: number },
  state: GameState,
  playerNames: ReadonlyArray<string>,
) {
  const winnerName = playerNames[winner.id] ?? `Player ${winner.id + 1}`;
  return {
    winnerName,
    serverPayload: {
      type: MESSAGE.GAME_OVER,
      winner: winnerName,
      scores: state.players.map((player) => ({
        name: playerNames[player.id] ?? `P${player.id + 1}`,
        score: player.score,
        eliminated: player.eliminated,
      })),
    },
  };
}

/** Restore captured cannon object references from serialized indices.
 *  Shared by both full-state recovery and battle-start checkpoint apply.
 *  Validates victimId bounds and cannonIdx before resolving object references. */
export function applyCapturedCannons(
  state: GameState,
  entries: readonly {
    victimId: number;
    capturerId: number;
    cannonIdx: number;
  }[],
): void {
  state.capturedCannons = [];
  for (const cc of entries) {
    if (cc.victimId < 0 || cc.victimId >= state.players.length) continue;
    const victim = state.players[cc.victimId]!;
    if (cc.cannonIdx < 0 || cc.cannonIdx >= victim.cannons.length) continue;
    state.capturedCannons.push({
      cannon: victim.cannons[cc.cannonIdx]!,
      cannonIdx: cc.cannonIdx,
      victimId: cc.victimId as ValidPlayerSlot,
      capturerId: cc.capturerId as ValidPlayerSlot,
    });
  }
}

/**
 * Structural validation — rejects the message before any state mutation
 * if it contains out-of-bounds indices or mismatched array lengths.
 */
function validateFullState(
  state: GameState,
  msg: FullStateMessage,
): string | null {
  if (Phase[msg.phase as keyof typeof Phase] === undefined)
    return `invalid phase "${msg.phase}"`;
  if (!Number.isFinite(msg.rngState)) return "non-finite rngState";

  const pc = state.players.length;
  const tc = state.map.towers.length;

  if (msg.players.length !== pc)
    return `players length ${msg.players.length} != ${pc}`;
  if (msg.cannonLimits.length !== pc)
    return `cannonLimits length ${msg.cannonLimits.length} != ${pc}`;
  if (msg.playerZones.length !== pc)
    return `playerZones length ${msg.playerZones.length} != ${pc}`;
  if (msg.towerAlive.length !== tc)
    return `towerAlive length ${msg.towerAlive.length} != ${tc}`;

  for (const sp of msg.players) {
    if (sp.id < 0 || sp.id >= pc) return `player id ${sp.id} out of bounds`;
    if (sp.walls.some((tile) => tile < 0 || tile >= TILE_COUNT))
      return `player ${sp.id} wall tile out of bounds`;
    for (const c of sp.cannons) {
      if (c.row < 0 || c.row >= GRID_ROWS || c.col < 0 || c.col >= GRID_COLS)
        return `player ${sp.id} cannon at ${c.row},${c.col} out of bounds`;
    }
    if (
      sp.homeTowerIdx !== null &&
      (sp.homeTowerIdx < 0 || sp.homeTowerIdx >= tc)
    ) {
      return `player ${sp.id} homeTowerIdx ${sp.homeTowerIdx} out of bounds`;
    }
  }

  for (const grunt of msg.grunts) {
    if (
      grunt.row < 0 ||
      grunt.row >= GRID_ROWS ||
      grunt.col < 0 ||
      grunt.col >= GRID_COLS
    )
      return `grunt at ${grunt.row},${grunt.col} out of bounds`;
  }

  for (const ti of msg.towerPendingRevive) {
    if (ti < 0 || ti >= tc)
      return `towerPendingRevive index ${ti} out of bounds`;
  }

  return null;
}

function serializeGrunts(state: GameState) {
  return state.grunts.map(gruntWireFields);
}

function deserializeGrunt(grunt: SerializedGrunt): GameState["grunts"][number] {
  return {
    ...gruntWireFields(grunt),
    blockedRounds: grunt.blockedRounds ?? 0,
  };
}

/** Pick the wire-format fields from a grunt. Accepts both runtime Grunt
 *  (required fields) and SerializedGrunt (optional fields) since runtime
 *  Grunt satisfies the wire format's optional shape. */
function gruntWireFields(grunt: SerializedGrunt): SerializedGrunt {
  return {
    row: grunt.row,
    col: grunt.col,
    victimPlayerId: grunt.victimPlayerId,
    targetTowerIdx: grunt.targetTowerIdx,
    attackCountdown: grunt.attackCountdown,
    blockedRounds: grunt.blockedRounds,
    attackingWall: grunt.attackingWall,
    facing: grunt.facing,
  };
}

function serializeBurningPits(state: GameState) {
  return state.burningPits.map((pit) => ({
    row: pit.row,
    col: pit.col,
    roundsLeft: pit.roundsLeft,
  }));
}

function serializeBonusSquares(state: GameState) {
  return state.bonusSquares.map((b) => ({
    row: b.row,
    col: b.col,
    zone: b.zone,
  }));
}

/** Restore cannonballs from a full-state message, dropping any with stale cannon references. */
function restoreCannonballs(state: GameState, msg: FullStateMessage): void {
  const validBalls = msg.cannonballs.filter(
    (b) => state.players[b.playerId]?.cannons[b.cannonIdx],
  );
  if (validBalls.length < msg.cannonballs.length) {
    console.warn(
      `[checkpoint] dropped ${msg.cannonballs.length - validBalls.length} cannonballs with stale refs`,
    );
  }
  state.cannonballs = validBalls.map((b) => ({
    ...copyCannonballCore(b),
    incendiary: b.incendiary ?? false,
  }));
}

/** Copy the positional/kinematic fields shared by all cannonball representations. */
function copyCannonballCore(b: Cannonball): Omit<Cannonball, "incendiary"> {
  return {
    cannonIdx: b.cannonIdx,
    startX: b.startX,
    startY: b.startY,
    x: b.x,
    y: b.y,
    targetX: b.targetX,
    targetY: b.targetY,
    speed: b.speed,
    playerId: b.playerId,
    scoringPlayerId: b.scoringPlayerId,
  };
}

/** Restore balloon hit map, reconstructing Cannon object references as Map keys. */
function restoreBalloonHits(state: GameState, msg: FullStateMessage): void {
  state.balloonHits = new Map();
  for (const bh of msg.balloonHits) {
    const cannon = state.players[bh.playerId]?.cannons[bh.cannonIdx];
    if (cannon)
      state.balloonHits.set(cannon, {
        count: bh.count,
        capturerIds: bh.capturerIds,
      });
  }
}
