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
    seed: 1000,
    totalRounds: 51,
    winner: null,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6010, walls: 78, cannons: 8, interior: 64, eliminated: false },
          { lives: 3, score: 6942, walls: 88, cannons: 11, interior: 62, eliminated: false },
          { lives: 3, score: 6368, walls: 87, cannons: 7, interior: 82, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 15368, walls: 169, cannons: 19, interior: 124, eliminated: false },
          { lives: 3, score: 15398, walls: 151, cannons: 13, interior: 69, eliminated: false },
          { lives: 2, score: 13450, walls: 28, cannons: 0, interior: 36, eliminated: false },
        ],
      },
      {
        round: 20,
        players: [
          { lives: 3, score: 35990, walls: 166, cannons: 26, interior: 133, eliminated: false },
          { lives: 2, score: 30692, walls: 121, cannons: 14, interior: 85, eliminated: false },
          { lives: 0, score: 24346, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 35,
        players: [
          { lives: 3, score: 61858, walls: 188, cannons: 20, interior: 74, eliminated: false },
          { lives: 2, score: 59154, walls: 147, cannons: 12, interior: 101, eliminated: false },
          { lives: 0, score: 24346, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 51,
        players: [
          { lives: 2, score: 86478, walls: 107, cannons: 6, interior: 100, eliminated: false },
          { lives: 2, score: 86562, walls: 119, cannons: 13, interior: 99, eliminated: false },
          { lives: 0, score: 24346, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 8919,
    totalRounds: 40,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3924, walls: 45, cannons: 4, interior: 36, eliminated: false },
          { lives: 3, score: 5834, walls: 77, cannons: 5, interior: 68, eliminated: false },
          { lives: 3, score: 6054, walls: 85, cannons: 8, interior: 97, eliminated: false },
        ],
      },
      {
        round: 14,
        players: [
          { lives: 1, score: 17936, walls: 123, cannons: 15, interior: 76, eliminated: false },
          { lives: 3, score: 23954, walls: 154, cannons: 16, interior: 159, eliminated: false },
          { lives: 0, score: 15924, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 1, score: 41684, walls: 164, cannons: 18, interior: 102, eliminated: false },
          { lives: 1, score: 41932, walls: 59, cannons: 4, interior: 64, eliminated: false },
          { lives: 0, score: 15924, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 40,
        players: [
          { lives: 1, score: 70410, walls: 163, cannons: 16, interior: 98, eliminated: false },
          { lives: 0, score: 66712, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 15924, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 16838,
    totalRounds: 51,
    winner: null,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6880, walls: 108, cannons: 9, interior: 101, eliminated: false },
          { lives: 2, score: 4218, walls: 56, cannons: 4, interior: 60, eliminated: false },
          { lives: 3, score: 5478, walls: 73, cannons: 3, interior: 73, eliminated: false },
        ],
      },
      {
        round: 9,
        players: [
          { lives: 3, score: 15564, walls: 154, cannons: 22, interior: 162, eliminated: false },
          { lives: 2, score: 11322, walls: 102, cannons: 13, interior: 36, eliminated: false },
          { lives: 0, score: 7378, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 30,
        players: [
          { lives: 2, score: 48912, walls: 162, cannons: 20, interior: 81, eliminated: false },
          { lives: 2, score: 50842, walls: 146, cannons: 15, interior: 77, eliminated: false },
          { lives: 0, score: 7378, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 51,
        players: [
          { lives: 1, score: 81628, walls: 160, cannons: 21, interior: 48, eliminated: false },
          { lives: 1, score: 84650, walls: 114, cannons: 11, interior: 27, eliminated: false },
          { lives: 0, score: 7378, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 24757,
    totalRounds: 22,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6468, walls: 73, cannons: 8, interior: 74, eliminated: false },
          { lives: 3, score: 6574, walls: 92, cannons: 8, interior: 99, eliminated: false },
          { lives: 3, score: 5190, walls: 66, cannons: 5, interior: 36, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 0, score: 9410, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 17306, walls: 157, cannons: 24, interior: 99, eliminated: false },
          { lives: 3, score: 12774, walls: 98, cannons: 8, interior: 92, eliminated: false },
        ],
      },
      {
        round: 22,
        players: [
          { lives: 0, score: 9410, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 34718, walls: 165, cannons: 12, interior: 78, eliminated: false },
          { lives: 0, score: 26728, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 32676,
    totalRounds: 14,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5702, walls: 84, cannons: 8, interior: 59, eliminated: false },
          { lives: 3, score: 5858, walls: 63, cannons: 10, interior: 64, eliminated: false },
          { lives: 2, score: 4272, walls: 55, cannons: 5, interior: 65, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 15324, walls: 129, cannons: 18, interior: 124, eliminated: false },
          { lives: 3, score: 12294, walls: 74, cannons: 9, interior: 67, eliminated: false },
          { lives: 0, score: 9484, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 14,
        players: [
          { lives: 3, score: 23708, walls: 146, cannons: 19, interior: 109, eliminated: false },
          { lives: 0, score: 13734, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 9484, walls: 0, cannons: 0, interior: 0, eliminated: true },
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
