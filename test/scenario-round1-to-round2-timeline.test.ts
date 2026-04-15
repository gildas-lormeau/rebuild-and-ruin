import { createScenario } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

/** Prints the ASCII map at every phase boundary, banner boundary, and
 *  score-overlay boundary from game start up to the first frame of the
 *  round-2 BATTLE phase. Snapshots are recorded in the order they happen. */
Deno.test("ascii: game-start → round-2 battle timeline", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2, renderer: "ascii" });
  const ascii = sc.renderer!;

  const snapshots: { label: string; ascii: string }[] = [];
  const push = (label: string) =>
    snapshots.push({ label, ascii: ascii.snapshot("walls") });

  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    push(`PHASE_END ${Phase[ev.phase]} (round ${ev.round})`);
  });
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    push(`PHASE_START ${Phase[ev.phase]} (round ${ev.round})`);
  });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    push(`BANNER_START "${ev.text}" (round ${ev.round})`);
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    push(`BANNER_END "${ev.text}" (round ${ev.round})`);
  });

  sc.bus.on(GAME_EVENT.SCORE_OVERLAY_START, (ev) => {
    push(`SCORE_OVERLAY_START (round ${ev.round})`);
  });
  sc.bus.on(GAME_EVENT.SCORE_OVERLAY_END, (ev) => {
    push(`SCORE_OVERLAY_END (round ${ev.round})`);
  });

  sc.runUntil(
    () => sc.state.round === 2 && sc.state.phase === Phase.BATTLE,
    { timeoutMs: 120_000 },
  );

  for (const snap of snapshots) {
    console.log(`\n=== ${snap.label} ===\n${snap.ascii}`);
  }
});
