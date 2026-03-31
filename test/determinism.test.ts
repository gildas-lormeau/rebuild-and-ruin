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
          { lives: 3, score: 5458, walls: 69, cannons: 4, interior: 58, eliminated: false },
          { lives: 3, score: 7708, walls: 112, cannons: 12, interior: 129, eliminated: false },
          { lives: 3, score: 6304, walls: 70, cannons: 7, interior: 64, eliminated: false },
        ],
      },
      {
        round: 15,
        players: [
          { lives: 2, score: 23210, walls: 165, cannons: 22, interior: 77, eliminated: false },
          { lives: 3, score: 24568, walls: 127, cannons: 16, interior: 41, eliminated: false },
          { lives: 1, score: 19650, walls: 50, cannons: 3, interior: 36, eliminated: false },
        ],
      },
      {
        round: 30,
        players: [
          { lives: 2, score: 47084, walls: 181, cannons: 17, interior: 88, eliminated: false },
          { lives: 3, score: 41592, walls: 114, cannons: 11, interior: 43, eliminated: false },
          { lives: 0, score: 19776, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 51,
        players: [
          { lives: 2, score: 72982, walls: 133, cannons: 12, interior: 34, eliminated: false },
          { lives: 2, score: 75310, walls: 153, cannons: 17, interior: 98, eliminated: false },
          { lives: 0, score: 19776, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 8919,
    totalRounds: 51,
    winner: null,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5040, walls: 57, cannons: 2, interior: 34, eliminated: false },
          { lives: 2, score: 3720, walls: 50, cannons: 3, interior: 35, eliminated: false },
          { lives: 3, score: 5954, walls: 85, cannons: 7, interior: 68, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 1, score: 9486, walls: 31, cannons: 0, interior: 34, eliminated: false },
          { lives: 2, score: 12944, walls: 126, cannons: 13, interior: 130, eliminated: false },
          { lives: 3, score: 15880, walls: 131, cannons: 18, interior: 99, eliminated: false },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 0, score: 9530, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 39922, walls: 171, cannons: 20, interior: 76, eliminated: false },
          { lives: 2, score: 35770, walls: 94, cannons: 9, interior: 78, eliminated: false },
        ],
      },
      {
        round: 51,
        players: [
          { lives: 0, score: 9530, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 87854, walls: 161, cannons: 20, interior: 114, eliminated: false },
          { lives: 2, score: 86846, walls: 120, cannons: 10, interior: 108, eliminated: false },
        ],
      },
    ],
  },
  {
    seed: 16838,
    totalRounds: 41,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6990, walls: 107, cannons: 11, interior: 133, eliminated: false },
          { lives: 3, score: 5064, walls: 51, cannons: 4, interior: 33, eliminated: false },
          { lives: 1, score: 2540, walls: 30, cannons: 0, interior: 33, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 17706, walls: 153, cannons: 24, interior: 91, eliminated: false },
          { lives: 2, score: 10850, walls: 85, cannons: 5, interior: 60, eliminated: false },
          { lives: 0, score: 4888, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 2, score: 42408, walls: 186, cannons: 18, interior: 61, eliminated: false },
          { lives: 2, score: 38656, walls: 178, cannons: 11, interior: 67, eliminated: false },
          { lives: 0, score: 4888, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
      {
        round: 41,
        players: [
          { lives: 0, score: 70326, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 68324, walls: 166, cannons: 12, interior: 65, eliminated: false },
          { lives: 0, score: 4888, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 24757,
    totalRounds: 47,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 1, score: 2428, walls: 30, cannons: 0, interior: 35, eliminated: false },
          { lives: 3, score: 7068, walls: 112, cannons: 11, interior: 131, eliminated: false },
          { lives: 3, score: 5268, walls: 66, cannons: 5, interior: 36, eliminated: false },
        ],
      },
      {
        round: 15,
        players: [
          { lives: 1, score: 18334, walls: 139, cannons: 16, interior: 123, eliminated: false },
          { lives: 3, score: 26866, walls: 163, cannons: 21, interior: 121, eliminated: false },
          { lives: 2, score: 18238, walls: 121, cannons: 4, interior: 43, eliminated: false },
        ],
      },
      {
        round: 30,
        players: [
          { lives: 1, score: 47144, walls: 125, cannons: 22, interior: 69, eliminated: false },
          { lives: 0, score: 39216, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 38956, walls: 145, cannons: 7, interior: 68, eliminated: false },
        ],
      },
      {
        round: 47,
        players: [
          { lives: 0, score: 63902, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 39216, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 64642, walls: 159, cannons: 9, interior: 130, eliminated: false },
        ],
      },
    ],
  },
  {
    seed: 32676,
    totalRounds: 17,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6760, walls: 79, cannons: 5, interior: 85, eliminated: false },
          { lives: 2, score: 3636, walls: 38, cannons: 4, interior: 33, eliminated: false },
          { lives: 3, score: 4894, walls: 49, cannons: 5, interior: 35, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 17390, walls: 113, cannons: 17, interior: 126, eliminated: false },
          { lives: 2, score: 11014, walls: 81, cannons: 3, interior: 49, eliminated: false },
          { lives: 2, score: 10170, walls: 78, cannons: 5, interior: 57, eliminated: false },
        ],
      },
      {
        round: 17,
        players: [
          { lives: 3, score: 33002, walls: 150, cannons: 18, interior: 151, eliminated: false },
          { lives: 0, score: 18728, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 11320, walls: 0, cannons: 0, interior: 0, eliminated: true },
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
