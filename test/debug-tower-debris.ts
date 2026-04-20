// Throwaway debug test: does state.towerAlive get flipped during battle?

import { Phase } from "../src/shared/core/game-phase.ts";
import { createScenario } from "./scenario.ts";

Deno.test("debug: tower-alive flows to state on grunt kill", async () => {
  const sc = await createScenario({ seed: 7, mode: "modern", rounds: 3 });

  let deadIdx: number | undefined;
  sc.runUntil(
    () => {
      for (let i = 0; i < sc.state.towerAlive.length; i++) {
        if (sc.state.towerAlive[i] === false) {
          deadIdx = i;
          return true;
        }
      }
      return false;
    },
    { timeoutMs: 600_000 },
  );

  console.log(
    `[DBG-state] FIRST dead tower idx=${deadIdx} phase=${Phase[sc.state.phase]} round=${sc.state.round}`,
  );
});
