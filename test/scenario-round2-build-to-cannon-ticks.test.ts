import { createScenario } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

/** Per-tick ASCII snapshots covering the round-2 window between
 *  SCORE_OVERLAY_START and PHASE_END CANNON_PLACE. Captures every tick
 *  (including the score-overlay animation, the inter-phase transition, the
 *  cannons banner sweep, and the full cannon-placement window). */
Deno.test("ascii: per-tick maps SCORE_OVERLAY_START → PHASE_END CANNON_PLACE (round 2)", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2, renderer: "ascii" });
  const ascii = sc.renderer!;

  const snapshots: { label: string; ascii: string }[] = [];
  let capturing = false;
  let done = false;
  let tickIdx = 0;

  sc.bus.on(GAME_EVENT.SCORE_OVERLAY_START, (ev) => {
    if (ev.round !== 2) return;
    capturing = true;
    tickIdx = 0;
    snapshots.push({
      label: `SCORE_OVERLAY_START (round ${ev.round})`,
      ascii: ascii.snapshot("walls"),
    });
  });
  sc.bus.on(GAME_EVENT.SCORE_OVERLAY_END, (ev) => {
    snapshots.push({
      label: `SCORE_OVERLAY_END (round ${ev.round})`,
      ascii: ascii.snapshot("walls"),
    });
  });
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    snapshots.push({
      label: `PHASE_START ${Phase[ev.phase]} (round ${ev.round})`,
      ascii: ascii.snapshot("walls"),
    });
  });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    snapshots.push({
      label: `BANNER_START "${ev.text}" (round ${ev.round})`,
      ascii: ascii.snapshot("walls"),
    });
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    snapshots.push({
      label: `BANNER_END "${ev.text}" (round ${ev.round})`,
      ascii: ascii.snapshot("walls"),
    });
  });

  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    if (ev.phase === Phase.CANNON_PLACE && capturing) {
      snapshots.push({
        label: `PHASE_END CANNON_PLACE (round ${ev.round})`,
        ascii: ascii.snapshot("walls"),
      });
      capturing = false;
      done = true;
    } else {
      snapshots.push({
        label: `PHASE_END ${Phase[ev.phase]} (round ${ev.round})`,
        ascii: ascii.snapshot("walls"),
      });
    }
  });

  // Per-tick sampler — runUntil's predicate runs after every tick.
  sc.runUntil(
    () => {
      if (capturing) {
        snapshots.push({
          label: `tick #${++tickIdx}`,
          ascii: ascii.snapshot("walls"),
        });
      }
      return done;
    },
    { timeoutMs: 120_000 },
  );

  for (const snap of snapshots) {
    console.log(`\n=== ${snap.label} ===\n${snap.ascii}`);
  }
});
