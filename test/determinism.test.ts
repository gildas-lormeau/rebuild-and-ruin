/**
 * Determinism regression test — asserts exact game outcomes for fixed seeds.
 *
 * Because every RNG source is seeded (Mulberry32), AI-only games are fully
 * deterministic. This test records expected outcomes at key checkpoints and
 * will break whenever game logic changes — intentionally.
 *
 * Run with: deno test --no-check test/determinism.test.ts
 */

import { createScenario } from "./scenario-helpers.ts";
import { assert } from "@std/assert";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerSnapshot {
  readonly lives: number;
  readonly score: number;
  readonly walls: number;
  readonly cannons: number;
  readonly interior: number;
  readonly eliminated: boolean;
}

interface RoundCheckpoint {
  readonly round: number;
  readonly players: readonly PlayerSnapshot[];
}

interface GameExpectation {
  readonly seed: number;
  readonly totalRounds: number;
  readonly winner: number | null; // null = draw
  readonly checkpoints: readonly RoundCheckpoint[];
}

// ---------------------------------------------------------------------------
// Expected outcomes — captured from current build
// ---------------------------------------------------------------------------

const EXPECTED: readonly GameExpectation[] = [
  {
    seed: 52,
    totalRounds: 9,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 7424, walls: 117, cannons: 13, interior: 131, eliminated: false },
          { lives: 2, score: 4888, walls: 86, cannons: 6, interior: 96, eliminated: false },
          { lives: 1, score: 2682, walls: 29, cannons: 0, interior: 35, eliminated: false },
        ],
      },
      {
        round: 9,
        players: [
          { lives: 3, score: 16770, walls: 139, cannons: 28, interior: 144, eliminated: false },
          { lives: 0, score: 9600, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 4008, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 23,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3874, walls: 40, cannons: 4, interior: 34, eliminated: false },
          { lives: 3, score: 6630, walls: 75, cannons: 9, interior: 69, eliminated: false },
          { lives: 3, score: 5294, walls: 79, cannons: 3, interior: 41, eliminated: false },
        ],
      },
      {
        round: 23,
        players: [
          { lives: 0, score: 13946, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 34852, walls: 110, cannons: 7, interior: 77, eliminated: false },
          { lives: 0, score: 30438, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 9,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5672, walls: 96, cannons: 8, interior: 64, eliminated: false },
          { lives: 3, score: 6512, walls: 77, cannons: 8, interior: 71, eliminated: false },
          { lives: 3, score: 5096, walls: 74, cannons: 3, interior: 57, eliminated: false },
        ],
      },
      {
        round: 9,
        players: [
          { lives: 3, score: 13232, walls: 153, cannons: 14, interior: 134, eliminated: false },
          { lives: 0, score: 8590, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 6876, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 25,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6602, walls: 77, cannons: 9, interior: 84, eliminated: false },
          { lives: 3, score: 5754, walls: 75, cannons: 8, interior: 65, eliminated: false },
          { lives: 3, score: 6706, walls: 88, cannons: 10, interior: 86, eliminated: false },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 1, score: 35048, walls: 52, cannons: 5, interior: 39, eliminated: false },
          { lives: 0, score: 13768, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 37402, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 10,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3646, walls: 46, cannons: 4, interior: 34, eliminated: false },
          { lives: 3, score: 5690, walls: 74, cannons: 7, interior: 58, eliminated: false },
          { lives: 3, score: 6482, walls: 95, cannons: 11, interior: 70, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 0, score: 7822, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 15396, walls: 146, cannons: 17, interior: 77, eliminated: false },
          { lives: 0, score: 8276, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

function snapshotPlayers(s: ReturnType<typeof createScenario>): PlayerSnapshot[] {
  return s.state.players.map((p) => ({
    lives: p.lives,
    score: p.score,
    walls: p.walls.size,
    cannons: p.cannons.filter((c) => c.hp > 0).length,
    interior: p.interior.size,
    eliminated: p.eliminated,
  }));
}

function snapshotEqual(actual: PlayerSnapshot[], expected: readonly PlayerSnapshot[]): string | null {
  if (actual.length !== expected.length) return `player count ${actual.length} !== ${expected.length}`;
  const fields = ["lives", "score", "walls", "cannons", "interior", "eliminated"] as const;
  for (let i = 0; i < actual.length; i++) {
    for (const f of fields) {
      if (actual[i]![f] !== expected[i]![f]) {
        return `P${i}.${f}: ${actual[i]![f]} !== ${expected[i]![f]}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 50;

for (const expected of EXPECTED) {
  Deno.test(`seed ${expected.seed}: deterministic outcome`, () => {
    const s = createScenario(expected.seed);
    const checkpointsByRound = new Map(expected.checkpoints.map((cp) => [cp.round, cp]));
    let finalRound = 0;
    let winner: number | undefined;

    while (s.state.round <= MAX_ROUNDS) {
      const { needsReselect } = s.playRound();
      s.processReselection(needsReselect);

      const round = s.state.round;
      finalRound = round;

      // Check checkpoint if present
      const cp = checkpointsByRound.get(round);
      if (cp) {
        const actual = snapshotPlayers(s);
        const diff = snapshotEqual(actual, cp.players);
        assert(diff === null, `Round ${round} mismatch: ${diff}`);
      }

      const alive = s.state.players.filter((p) => !p.eliminated);
      if (alive.length <= 1) {
        winner = alive[0]?.id;
        break;
      }
    }

    assert(
      finalRound === expected.totalRounds,
      `Expected ${expected.totalRounds} rounds, got ${finalRound}`,
    );
    assert(
      winner === expected.winner,
      `Expected winner=${expected.winner}, got winner=${winner}`,
    );
  });
}

