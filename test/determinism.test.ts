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
    totalRounds: 23,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 7708, walls: 113, cannons: 13, interior: 124, eliminated: false },
          { lives: 3, score: 6812, walls: 101, cannons: 10, interior: 88, eliminated: false },
          { lives: 2, score: 3678, walls: 37, cannons: 4, interior: 35, eliminated: false },
        ],
      },
      {
        round: 23,
        players: [
          { lives: 3, score: 40134, walls: 93, cannons: 18, interior: 40, eliminated: false },
          { lives: 0, score: 35864, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 3712, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 24,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5848, walls: 74, cannons: 8, interior: 71, eliminated: false },
          { lives: 3, score: 6280, walls: 88, cannons: 9, interior: 60, eliminated: false },
          { lives: 2, score: 3802, walls: 29, cannons: 0, interior: 36, eliminated: false },
        ],
      },
      {
        round: 24,
        players: [
          { lives: 0, score: 27362, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 45304, walls: 156, cannons: 21, interior: 109, eliminated: false },
          { lives: 0, score: 8116, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 21,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6228, walls: 77, cannons: 8, interior: 104, eliminated: false },
          { lives: 3, score: 6508, walls: 92, cannons: 10, interior: 86, eliminated: false },
          { lives: 2, score: 4568, walls: 41, cannons: 4, interior: 36, eliminated: false },
        ],
      },
      {
        round: 21,
        players: [
          { lives: 0, score: 25452, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 8942, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 1, score: 34486, walls: 138, cannons: 16, interior: 123, eliminated: false },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 27,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6068, walls: 79, cannons: 5, interior: 55, eliminated: false },
          { lives: 2, score: 4256, walls: 69, cannons: 5, interior: 71, eliminated: false },
          { lives: 3, score: 7012, walls: 104, cannons: 12, interior: 93, eliminated: false },
        ],
      },
      {
        round: 27,
        players: [
          { lives: 2, score: 44936, walls: 166, cannons: 19, interior: 52, eliminated: false },
          { lives: 0, score: 5732, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 34678, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 23,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3676, walls: 36, cannons: 5, interior: 35, eliminated: false },
          { lives: 3, score: 6492, walls: 103, cannons: 10, interior: 78, eliminated: false },
          { lives: 3, score: 5998, walls: 86, cannons: 10, interior: 40, eliminated: false },
        ],
      },
      {
        round: 23,
        players: [
          { lives: 0, score: 6336, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 38186, walls: 114, cannons: 13, interior: 60, eliminated: false },
          { lives: 0, score: 32732, walls: 0, cannons: 0, interior: 0, eliminated: true },
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
