/**
 * Banner + phase-transition timeline instrumentation.
 *
 * Purpose: diagnose why the 3D camera-tilt animation appears to be "lost"
 * across phase transitions in the hybrid 2D/3D renderer. The hypothesis:
 * the tilt tween (TILT_TWEEN_MS = 500ms in src/render/3d/camera.ts) runs
 * in parallel with the banner sweep (BANNER_DURATION = 3s), so the tween
 * completes entirely under the banner — by the time the sweep exits the
 * map, the tilt is already at its target and the user never sees it
 * animate.
 *
 * This test records wall-clock timestamps (sim-ms) for PHASE_START,
 * BANNER_START, BANNER_END around the CASTLE_SELECT → WALL_BUILD and
 * CANNON_PLACE → BATTLE boundaries, then prints the timeline so we can
 * read off the gap between phase mutation and banner end.
 *
 * It's a diagnostic, not a behavioural assertion — just makes the timing
 * visible without having to instrument the browser.
 */

import { assert, assertGreater } from "@std/assert";
import { createScenario, waitForPhase } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

interface TimelineEntry {
  t: number;
  kind: "PHASE_START" | "PHASE_END" | "BANNER_START" | "BANNER_END";
  phase: Phase;
  detail?: string;
}

Deno.test("timeline: phase transitions vs banner lifecycle (diagnostic)", async () => {
  using sc = await createScenario({ seed: 42 });
  const timeline: TimelineEntry[] = [];

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    timeline.push({ t: sc.now(), kind: "PHASE_START", phase: ev.phase });
  });
  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    timeline.push({ t: sc.now(), kind: "PHASE_END", phase: ev.phase });
  });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    timeline.push({
      t: sc.now(),
      kind: "BANNER_START",
      phase: ev.phase,
      detail: ev.text,
    });
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    timeline.push({
      t: sc.now(),
      kind: "BANNER_END",
      phase: ev.phase,
      detail: ev.text,
    });
  });

  // Run past the first battle so we capture: initial select → cannons,
  // cannons → battle, and battle → build (next round's build banner).
  waitForPhase(sc, Phase.WALL_BUILD);
  sc.runUntil(
    () => timeline.filter((e) => e.kind === "BANNER_END").length >= 5,
    { timeoutMs: 120_000 },
  );

  // Print an aligned table so the diagnostic is readable.
  const t0 = timeline[0]?.t ?? 0;
  console.log("\n=== timeline (ms relative to first event) ===");
  for (const entry of timeline) {
    const rel = String(entry.t - t0).padStart(6);
    const kind = entry.kind.padEnd(13);
    const phase = String(entry.phase).padEnd(15);
    const detail = entry.detail ?? "";
    console.log(`  ${rel}  ${kind}  ${phase}  ${detail}`);
  }

  // Print the gaps that matter for the tilt question.
  console.log("\n=== phase-start → next-banner-end gaps ===");
  for (let idx = 0; idx < timeline.length; idx++) {
    const entry = timeline[idx]!;
    if (entry.kind !== "PHASE_START") continue;
    // Find the next BANNER_END after this phase start.
    for (let jdx = idx + 1; jdx < timeline.length; jdx++) {
      const next = timeline[jdx]!;
      if (next.kind === "BANNER_END") {
        console.log(
          `  PHASE_START ${entry.phase} → BANNER_END ${next.detail}: ${next.t - entry.t}ms`,
        );
        break;
      }
    }
  }

  assertGreater(timeline.length, 0);
  assert(
    timeline.some((entry) => entry.kind === "BANNER_START"),
    "expected at least one BANNER_START",
  );
});
