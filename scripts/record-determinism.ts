/**
 * Re-record determinism test expectations after a game logic change.
 * Run with: bun scripts/record-determinism.ts
 *
 * Outputs the EXPECTED array to paste into test/determinism.test.ts.
 */

import { createScenario } from "../test/scenario-helpers.ts";

const SEEDS = [52, 66, 65, 56, 2];
const MAX_ROUNDS = 50;
const CHECKPOINT_ROUNDS = new Map([
  [52, [5]],
  [66, [5]],
  [65, [5]],
  [56, [5]],
  [2, [5]],
]);

console.log("const EXPECTED: readonly GameExpectation[] = [");

for (const seed of SEEDS) {
  const s = createScenario(seed);
  const cpRounds = CHECKPOINT_ROUNDS.get(seed) ?? [];
  const checkpoints: {
    round: number;
    players: {
      lives: number;
      score: number;
      walls: number;
      cannons: number;
      interior: number;
      eliminated: boolean;
    }[];
  }[] = [];
  let finalRound = 0;
  let winner: number | undefined;

  while (s.state.round <= MAX_ROUNDS) {
    const { needsReselect } = s.playRound();
    s.processReselection(needsReselect);
    const round = s.state.round;
    finalRound = round;

    const snap = () =>
      s.state.players.map((p) => ({
        lives: p.lives,
        score: p.score,
        walls: p.walls.size,
        cannons: p.cannons.filter((c) => c.hp > 0).length,
        interior: p.interior.size,
        eliminated: p.eliminated,
      }));

    if (cpRounds.includes(round)) {
      checkpoints.push({ round, players: snap() });
    }

    const alive = s.state.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) {
      winner = alive[0]?.id;
      checkpoints.push({ round, players: snap() });
      break;
    }
  }

  console.log(`  {`);
  console.log(`    seed: ${seed},`);
  console.log(`    totalRounds: ${finalRound},`);
  console.log(`    winner: ${winner === undefined ? "null" : winner},`);
  console.log(`    checkpoints: [`);
  for (const cp of checkpoints) {
    console.log(`      {`);
    console.log(`        round: ${cp.round},`);
    console.log(`        players: [`);
    for (const p of cp.players) {
      console.log(
        `          { lives: ${p.lives}, score: ${p.score}, walls: ${p.walls}, cannons: ${p.cannons}, interior: ${p.interior}, eliminated: ${p.eliminated} },`,
      );
    }
    console.log(`        ],`);
    console.log(`      },`);
  }
  console.log(`    ],`);
  console.log(`  },`);
}

console.log("];");
