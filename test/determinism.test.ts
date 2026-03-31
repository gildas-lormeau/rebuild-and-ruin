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
          { lives: 3, score: 7308, walls: 112, cannons: 12, interior: 118, eliminated: false },
          { lives: 3, score: 5608, walls: 67, cannons: 8, interior: 56, eliminated: false },
          { lives: 1, score: 2464, walls: 29, cannons: 0, interior: 36, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 3, score: 18360, walls: 160, cannons: 23, interior: 116, eliminated: false },
          { lives: 0, score: 9186, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 3788, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 12,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 4958, walls: 53, cannons: 6, interior: 33, eliminated: false },
          { lives: 3, score: 6108, walls: 76, cannons: 10, interior: 36, eliminated: false },
          { lives: 2, score: 4278, walls: 63, cannons: 3, interior: 63, eliminated: false },
        ],
      },
      {
        round: 12,
        players: [
          { lives: 0, score: 10654, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 21084, walls: 153, cannons: 23, interior: 155, eliminated: false },
          { lives: 0, score: 5736, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 13,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 4868, walls: 55, cannons: 5, interior: 35, eliminated: false },
          { lives: 3, score: 5394, walls: 71, cannons: 7, interior: 33, eliminated: false },
          { lives: 2, score: 4256, walls: 73, cannons: 4, interior: 60, eliminated: false },
        ],
      },
      {
        round: 13,
        players: [
          { lives: 0, score: 8526, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 12152, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 17472, walls: 135, cannons: 16, interior: 46, eliminated: false },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 14,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 5446, walls: 81, cannons: 3, interior: 25, eliminated: false },
          { lives: 2, score: 4674, walls: 30, cannons: 0, interior: 35, eliminated: false },
          { lives: 3, score: 6904, walls: 111, cannons: 12, interior: 92, eliminated: false },
        ],
      },
      {
        round: 14,
        players: [
          { lives: 3, score: 22124, walls: 160, cannons: 19, interior: 126, eliminated: false },
          { lives: 0, score: 9438, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 17876, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 16,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3676, walls: 30, cannons: 0, interior: 35, eliminated: false },
          { lives: 3, score: 6722, walls: 97, cannons: 10, interior: 81, eliminated: false },
          { lives: 3, score: 7258, walls: 90, cannons: 11, interior: 101, eliminated: false },
        ],
      },
      {
        round: 16,
        players: [
          { lives: 0, score: 6266, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 29752, walls: 163, cannons: 11, interior: 106, eliminated: false },
          { lives: 0, score: 20490, walls: 0, cannons: 0, interior: 0, eliminated: true },
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
