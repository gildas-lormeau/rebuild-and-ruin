/**
 * Determinism regression test — asserts exact game outcomes for fixed seeds.
 *
 * Because every RNG source is seeded (Mulberry32), AI-only games are fully
 * deterministic. This test records expected outcomes at key checkpoints and
 * will break whenever game logic changes — intentionally.
 *
 * Run with: bun test/determinism.test.ts
 */

import { createScenario } from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";

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
    totalRounds: 10,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 7392, walls: 120, cannons: 13, interior: 131, eliminated: false },
          { lives: 2, score: 4888, walls: 83, cannons: 6, interior: 96, eliminated: false },
          { lives: 1, score: 2682, walls: 29, cannons: 0, interior: 35, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 19216, walls: 147, cannons: 24, interior: 112, eliminated: false },
          { lives: 0, score: 10020, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 4038, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 15,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 1, score: 2658, walls: 32, cannons: 0, interior: 34, eliminated: false },
          { lives: 3, score: 6630, walls: 75, cannons: 9, interior: 69, eliminated: false },
          { lives: 3, score: 5294, walls: 79, cannons: 3, interior: 41, eliminated: false },
        ],
      },
      {
        round: 15,
        players: [
          { lives: 0, score: 3978, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 22310, walls: 98, cannons: 7, interior: 55, eliminated: false },
          { lives: 0, score: 17582, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 16,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5700, walls: 89, cannons: 9, interior: 64, eliminated: false },
          { lives: 3, score: 6586, walls: 90, cannons: 10, interior: 68, eliminated: false },
          { lives: 1, score: 2470, walls: 30, cannons: 0, interior: 34, eliminated: false },
        ],
      },
      {
        round: 16,
        players: [
          { lives: 0, score: 19468, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 24800, walls: 139, cannons: 23, interior: 47, eliminated: false },
          { lives: 0, score: 2480, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 25,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6606, walls: 105, cannons: 10, interior: 91, eliminated: false },
          { lives: 2, score: 4190, walls: 37, cannons: 4, interior: 32, eliminated: false },
          { lives: 3, score: 6310, walls: 82, cannons: 10, interior: 57, eliminated: false },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 0, score: 18058, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 35060, walls: 168, cannons: 18, interior: 89, eliminated: false },
          { lives: 0, score: 33840, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 18,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3660, walls: 29, cannons: 0, interior: 35, eliminated: false },
          { lives: 3, score: 5390, walls: 77, cannons: 4, interior: 56, eliminated: false },
          { lives: 3, score: 6692, walls: 91, cannons: 11, interior: 67, eliminated: false },
        ],
      },
      {
        round: 18,
        players: [
          { lives: 0, score: 7688, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 23724, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 27422, walls: 79, cannons: 6, interior: 33, eliminated: false },
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
  test(`seed ${expected.seed}: deterministic outcome`, () => {
    const s = createScenario(expected.seed);
    const checkpointsByRound = new Map(expected.checkpoints.map((cp) => [cp.round, cp]));
    let finalRound = 0;
    let winner: number | null = null;

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
        winner = alive[0]?.id ?? null;
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

await runTests("Determinism regression tests");
