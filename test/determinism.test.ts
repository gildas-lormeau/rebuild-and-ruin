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
    totalRounds: 20,
    winner: 0,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 3, score: 7760, walls: 116, cannons: 14, interior: 126, eliminated: false },
          { lives: 3, score: 6446, walls: 95, cannons: 10, interior: 90, eliminated: false },
          { lives: 3, score: 5730, walls: 71, cannons: 9, interior: 58, eliminated: false },
        ],
      },
      {
        round: 20,
        players: [
          { lives: 2, score: 36916, walls: 101, cannons: 13, interior: 91, eliminated: false },
          { lives: 0, score: 28242, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 0, score: 15810, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 66,
    totalRounds: 10,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 1, score: 2512, walls: 32, cannons: 0, interior: 33, eliminated: false },
          { lives: 3, score: 6748, walls: 89, cannons: 11, interior: 97, eliminated: false },
          { lives: 3, score: 4954, walls: 91, cannons: 6, interior: 36, eliminated: false },
        ],
      },
      {
        round: 10,
        players: [
          { lives: 0, score: 2516, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 14142, walls: 126, cannons: 18, interior: 73, eliminated: false },
          { lives: 0, score: 7716, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 65,
    totalRounds: 17,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3742, walls: 65, cannons: 6, interior: 34, eliminated: false },
          { lives: 3, score: 5644, walls: 76, cannons: 10, interior: 38, eliminated: false },
          { lives: 3, score: 6056, walls: 81, cannons: 10, interior: 63, eliminated: false },
        ],
      },
      {
        round: 17,
        players: [
          { lives: 0, score: 6176, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 3, score: 27384, walls: 158, cannons: 21, interior: 111, eliminated: false },
          { lives: 0, score: 21184, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 56,
    totalRounds: 24,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3542, walls: 49, cannons: 4, interior: 24, eliminated: false },
          { lives: 3, score: 5974, walls: 91, cannons: 9, interior: 97, eliminated: false },
          { lives: 2, score: 3544, walls: 58, cannons: 3, interior: 23, eliminated: false },
        ],
      },
      {
        round: 24,
        players: [
          { lives: 0, score: 13668, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 37884, walls: 164, cannons: 18, interior: 112, eliminated: false },
          { lives: 0, score: 29826, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
  {
    seed: 2,
    totalRounds: 15,
    winner: 1,
    checkpoints: [
      {
        round: 5,
        players: [
          { lives: 2, score: 3612, walls: 32, cannons: 0, interior: 32, eliminated: false },
          { lives: 3, score: 5770, walls: 90, cannons: 7, interior: 81, eliminated: false },
          { lives: 3, score: 6956, walls: 101, cannons: 11, interior: 101, eliminated: false },
        ],
      },
      {
        round: 15,
        players: [
          { lives: 0, score: 8636, walls: 0, cannons: 0, interior: 0, eliminated: true },
          { lives: 2, score: 24560, walls: 29, cannons: 0, interior: 35, eliminated: false },
          { lives: 0, score: 20622, walls: 0, cannons: 0, interior: 0, eliminated: true },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

function snapshotPlayers(s: Awaited<ReturnType<typeof createScenario>>): PlayerSnapshot[] {
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
  Deno.test(`seed ${expected.seed}: deterministic outcome`, async () => {
    const s = await createScenario(expected.seed);
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

