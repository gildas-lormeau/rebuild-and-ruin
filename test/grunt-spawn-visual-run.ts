import { createScenario } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

const FIRST_OBSERVED_ROUND = 2;
const LAST_OBSERVED_ROUND = 4;
const SAMPLE_EVERY_MS = 5_000;
const sc = await createScenario({
  seed: 42,
  rounds: LAST_OBSERVED_ROUND + 1,
  renderer: "ascii",
});
const ascii = sc.renderer!;

for (let round = FIRST_OBSERVED_ROUND; round <= LAST_OBSERVED_ROUND; round++) {
  // Drive forward until we enter this round's WALL_BUILD (or overshoot).
  sc.runUntil(
    () =>
      sc.state.round > round ||
      (sc.state.round === round && sc.state.phase === Phase.WALL_BUILD),
    { timeoutMs: 480_000 },
  );
  if (sc.state.round !== round || sc.state.phase !== Phase.WALL_BUILD) {
    console.log(
      `(skipped round ${round}: round=${sc.state.round} phase=${Phase[sc.state.phase]})`,
    );
    continue;
  }

  console.log(`===== ROUND ${round} WALL_BUILD =====`);
  let sampleIdx = 0;
  const buildStart = sc.now();
  while (
    sc.state.phase === Phase.WALL_BUILD &&
    sc.state.round === round
  ) {
    const elapsed = sc.now() - buildStart;
    console.log(
      `--- round ${round} elapsed ${(elapsed / 1000).toFixed(1)}s grunts=${sc.state.grunts.length} ---`,
    );
    console.log(ascii.snapshot({ layer: "all", coords: true }));
    sampleIdx++;
    const targetMs = sampleIdx * SAMPLE_EVERY_MS;
    try {
      sc.runUntil(
        () =>
          sc.now() - buildStart >= targetMs ||
          sc.state.phase !== Phase.WALL_BUILD ||
          sc.state.round !== round,
        { timeoutMs: SAMPLE_EVERY_MS + 5_000 },
      );
    } catch {
      break;
    }
  }
}
