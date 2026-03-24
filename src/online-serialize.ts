/**
 * Serialization and deserialization helpers for online multiplayer checkpoints.
 * Pure functions that read/write GameState — no module-level state.
 */

import type { FullStateMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import type { BalloonFlight } from "./battle-system.ts";
import { Rng } from "./rng.ts";
import type { GameState } from "./types.ts";
import { CannonMode, Phase } from "./types.ts";

export type SerializedPlayer = {
  id: number;
  walls: number[];
  interior: number[];
  cannons: {
    row: number;
    col: number;
    hp: number;
    kind: string;
    facing?: number;
  }[];
  ownedTowerIndices: number[];
  homeTowerIdx: number | null;
  lives: number;
  eliminated: boolean;
  score: number;
};

export function applyHousesCheckpoint(
  state: GameState,
  serialized: { row: number; col: number; zone: number; alive: boolean }[],
): void {
  state.map.houses.length = 0;
  for (const h of serialized) {
    state.map.houses.push({
      row: h.row,
      col: h.col,
      zone: h.zone,
      alive: h.alive,
    });
  }
}

export function buildBuildStartMessage(state: GameState) {
  return {
    type: MSG.BUILD_START,
    round: state.round,
    timer: state.timer,
    players: serializePlayers(state),
    houses: serializeHouses(state),
    grunts: serializeGrunts(state),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    rngSeed: state.rng.seed,
  };
}

export function buildCannonStartMessage(state: GameState) {
  return {
    type: MSG.CANNON_START,
    timer: state.timer,
    limits: [...state.cannonLimits],
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    houses: serializeHouses(state),
  };
}

export function buildBattleStartMessage(
  state: GameState,
  flights?: BalloonFlight[],
) {
  return {
    type: MSG.BATTLE_START,
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    capturedCannons: state.capturedCannons.map((cc) => ({
      victimId: cc.victimId, capturerId: cc.capturerId, cannonIdx: cc.cannonIdx,
    })),
    burningPits: serializeBurningPits(state),
    towerAlive: [...state.towerAlive],
    flights:
      flights && flights.length > 0
        ? flights.map((f) => ({
            startX: f.startX,
            startY: f.startY,
            endX: f.endX,
            endY: f.endY,
          }))
        : undefined,
  };
}

export function buildFullStateMessage(state: GameState): FullStateMessage {
  return {
    type: MSG.FULL_STATE,
    phase: Phase[state.phase],
    round: state.round,
    timer: state.timer,
    battleCountdown: state.battleCountdown,
    battleLength: state.battleLength,
    shotsFired: state.shotsFired,
    rngState: state.rng.getState(),
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    housesAlive: state.map.houses.map((h) => h.alive),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    cannonLimits: [...state.cannonLimits],
    playerZones: [...state.playerZones],
    activePlayer: state.activePlayer,
    towerPendingRevive: [...state.towerPendingRevive],
    capturedCannons: state.capturedCannons.map((cc) => ({
      victimId: cc.victimId, capturerId: cc.capturerId, cannonIdx: cc.cannonIdx,
    })),
    balloonHits: (() => {
      const hits: { playerId: number; cannonIdx: number; count: number; capturerIds: number[] }[] = [];
      for (const [cannon, hit] of state.balloonHits) {
        // Find which player owns this cannon
        for (const p of state.players) {
          const idx = p.cannons.indexOf(cannon);
          if (idx >= 0) { hits.push({ playerId: p.id, cannonIdx: idx, count: hit.count, capturerIds: hit.capturerIds }); break; }
        }
      }
      return hits;
    })(),
    cannonballs: state.cannonballs.map((b) => ({
      cannonIdx: b.cannonIdx,
      startX: b.startX, startY: b.startY,
      x: b.x, y: b.y,
      targetX: b.targetX, targetY: b.targetY,
      speed: b.speed,
      playerId: b.playerId,
      scoringPlayerId: b.scoringPlayerId,
      incendiary: b.incendiary || undefined,
    })),
  };
}

export function serializePlayers(state: GameState) {
  return state.players.map((p) => ({
    id: p.id,
    walls: [...p.walls],
    interior: [...p.interior],
    cannons: p.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      kind: c.kind,
      facing: c.facing,
    })),
    ownedTowerIndices: p.ownedTowers.map((t) => t.index),
    homeTowerIdx: p.homeTower?.index ?? null,
    lives: p.lives,
    eliminated: p.eliminated,
    score: p.score,
  }));
}

export function applyFullStateSnapshot(state: GameState, msg: FullStateMessage): void {
  state.phase = Phase[msg.phase as keyof typeof Phase];
  state.round = msg.round;
  state.timer = msg.timer;
  state.battleCountdown = msg.battleCountdown;
  state.battleLength = msg.battleLength;
  state.shotsFired = msg.shotsFired;
  state.cannonLimits = msg.cannonLimits;
  state.playerZones = msg.playerZones;
  state.activePlayer = msg.activePlayer;
  state.towerPendingRevive = new Set(msg.towerPendingRevive);
  state.towerAlive = msg.towerAlive;
  state.burningPits = msg.burningPits.map((p) => ({ row: p.row, col: p.col, roundsLeft: p.roundsLeft }));
  state.bonusSquares = msg.bonusSquares.map((b) => ({ row: b.row, col: b.col, zone: b.zone }));

  // Restore RNG internal state
  const rng = new Rng(0);
  rng.setState(msg.rngState);
  state.rng = rng;

  // Reuse existing checkpoint helpers
  applyPlayersCheckpoint(state, msg.players);
  applyGruntsCheckpoint(state, msg.grunts);

  // Houses are map data — only alive status changes
  for (let i = 0; i < msg.housesAlive.length && i < state.map.houses.length; i++) {
    state.map.houses[i]!.alive = msg.housesAlive[i]!;
  }

  // Restore cannonballs (skip any with stale cannon references)
  state.cannonballs = msg.cannonballs
    .filter((b) => state.players[b.playerId]?.cannons[b.cannonIdx])
    .map((b) => ({
      cannonIdx: b.cannonIdx,
      startX: b.startX, startY: b.startY,
      x: b.x, y: b.y,
      targetX: b.targetX, targetY: b.targetY,
      speed: b.speed,
      playerId: b.playerId,
      scoringPlayerId: b.scoringPlayerId,
      incendiary: b.incendiary ?? false,
    }));

  // Restore captured cannons (reconstruct object references from indices)
  state.capturedCannons = msg.capturedCannons.map((cc) => {
    const victim = state.players[cc.victimId]!;
    return { cannon: victim.cannons[cc.cannonIdx]!, cannonIdx: cc.cannonIdx, victimId: cc.victimId, capturerId: cc.capturerId };
  }).filter((cc) => cc.cannon); // skip if cannon index is stale

  // Restore balloonHits (reconstruct Cannon object references as Map keys)
  state.balloonHits = new Map();
  for (const bh of msg.balloonHits) {
    const cannon = state.players[bh.playerId]?.cannons[bh.cannonIdx];
    if (cannon) state.balloonHits.set(cannon, { count: bh.count, capturerIds: bh.capturerIds });
  }
}

export function applyPlayersCheckpoint(
  state: GameState,
  serialized: SerializedPlayer[],
): void {
  for (const sp of serialized) {
    const player = state.players[sp.id]!;
    player.walls = new Set(sp.walls);
    player.interior = new Set(sp.interior);
    player.cannons = sp.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      kind: (c.kind ?? CannonMode.NORMAL) as CannonMode,
      facing: c.facing ?? 0,
    }));
    player.ownedTowers = sp.ownedTowerIndices.map((i) => state.map.towers[i]!);
    player.homeTower =
      sp.homeTowerIdx !== null ? state.map.towers[sp.homeTowerIdx]! : null;
    player.lives = sp.lives;
    player.eliminated = sp.eliminated;
    player.score = sp.score;
  }
}

export function applyGruntsCheckpoint(
  state: GameState,
  serialized: { row: number; col: number }[],
): void {
  state.grunts = serialized.map((g) => ({
    row: g.row,
    col: g.col,
    targetPlayerId: 0,
  }));
}

function serializeGrunts(state: GameState) {
  return state.grunts.map((g) => ({
    row: g.row,
    col: g.col,
  }));
}

function serializeHouses(state: GameState) {
  return state.map.houses.map((h) => ({
    row: h.row,
    col: h.col,
    zone: h.zone,
    alive: h.alive,
  }));
}

function serializeBurningPits(state: GameState) {
  return state.burningPits.map((p) => ({
    row: p.row,
    col: p.col,
    roundsLeft: p.roundsLeft,
  }));
}

function serializeBonusSquares(state: GameState) {
  return state.bonusSquares.map((b) => ({
    row: b.row,
    col: b.col,
    zone: b.zone,
  }));
}
