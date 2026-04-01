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
    totalRounds: 13,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 7416, walls: 110, cannons: 13, interior: 131, eliminated: false },
          { lives: 2, score: 5350, walls: 86, cannons: 6, interior: 104, eliminated: false },
          { lives: 1, score: 2676, walls: 28, cannons: 0, interior: 36, eliminated: false },
        ],
      },
      {
        round: 13,
        players: [
          { lives: 3, score: 24712, walls: 165, cannons: 19, interior: 122, eliminated: false },
          { lives: 0, score: 13340, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 2692, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 25,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3990, walls: 43, cannons: 4, interior: 43, eliminated: false },
          { lives: 3, score: 6604, walls: 81, cannons: 9, interior: 69, eliminated: false },
          { lives: 3, score: 5292, walls: 88, cannons: 3, interior: 44, eliminated: false },
        ],
      },
      {
        round: 25,
        players: [
          { lives: 0, score: 10968, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 37038, walls: 155, cannons: 17, interior: 58, eliminated: false },
          { lives: 0, score: 36974, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 37,
    winner: null,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6070, walls: 98, cannons: 9, interior: 107, eliminated: false },
          { lives: 3, score: 6374, walls: 93, cannons: 10, interior: 73, eliminated: false },
          { lives: 2, score: 3966, walls: 34, cannons: 4, interior: 36, eliminated: false },
        ],
      },
      {
        round: 37,
        players: [
          { lives: 0, score: 60538, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 56500, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 43294, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 21,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 6782, walls: 86, cannons: 11, interior: 87, eliminated: false },
          { lives: 2, score: 4002, walls: 30, cannons: 0, interior: 34, eliminated: false },
          { lives: 3, score: 6728, walls: 87, cannons: 9, interior: 90, eliminated: false },
        ],
      },
      {
        round: 21,
        players: [
          { lives: 0, score: 25628, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 21864, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 34518, walls: 139, cannons: 15, interior: 80, eliminated: false },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 10,
    winner: 2,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3648, walls: 41, cannons: 4, interior: 29, eliminated: false },
          { lives: 3, score: 5704, walls: 73, cannons: 7, interior: 61, eliminated: false },
          { lives: 3, score: 7118, walls: 96, cannons: 11, interior: 102, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 0, score: 3694, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 9240, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 17246, walls: 137, cannons: 28, interior: 55, eliminated: false },
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
