/**
 * Serialization and deserialization helpers for online multiplayer checkpoints.
 * Pure functions that read/write GameState — no module-level state.
 */

import type { GameState } from "./types.ts";
import type { BalloonFlight } from "./battle-system.ts";

// ---------------------------------------------------------------------------
// Serialize (state → JSON-safe objects for sending)
// ---------------------------------------------------------------------------

export function serializePlayers(state: GameState) {
  return state.players.map((p) => ({
    id: p.id,
    walls: [...p.walls],
    interior: [...p.interior],
    cannons: p.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      super: c.super || undefined,
      balloon: c.balloon || undefined,
      facing: c.facing,
    })),
    ownedTowerIndices: p.ownedTowers.map((t) => t.index),
    homeTowerIdx: p.homeTower?.index ?? null,
    lives: p.lives,
    eliminated: p.eliminated,
    score: p.score,
  }));
}

function serializeGrunts(state: GameState) {
  return state.grunts.map((g) => ({
    row: g.row,
    col: g.col,
    facing: g.facing,
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

// ---------------------------------------------------------------------------
// Deserialize (JSON → GameState mutations)
// ---------------------------------------------------------------------------

export type SerializedPlayer = {
  id: number;
  walls: number[];
  interior: number[];
  cannons: {
    row: number;
    col: number;
    hp: number;
    super?: boolean;
    balloon?: boolean;
    facing?: number;
  }[];
  ownedTowerIndices: number[];
  homeTowerIdx: number | null;
  lives: number;
  eliminated: boolean;
  score: number;
};

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
      super: c.super || undefined,
      balloon: c.balloon || undefined,
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
  serialized: { row: number; col: number; facing?: number }[],
): void {
  state.grunts = serialized.map((g) => ({
    row: g.row,
    col: g.col,
    facing: g.facing ?? 0,
    targetPlayerId: 0,
  }));
}

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

// ---------------------------------------------------------------------------
// Build checkpoint messages (state → send-ready message objects)
// ---------------------------------------------------------------------------

export function buildBuildStartMessage(state: GameState) {
  return {
    type: "build_start" as const,
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
    type: "cannon_start" as const,
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
    type: "battle_start" as const,
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    capturedCannons: state.capturedCannons.map((cc) => {
      const victim = state.players[cc.victimId]!;
      const cannonIdx = victim.cannons.indexOf(cc.cannon);
      return { victimId: cc.victimId, capturerId: cc.capturerId, cannonIdx };
    }),
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
