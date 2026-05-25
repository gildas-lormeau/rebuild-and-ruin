/**
 * Smoke test for the narrative observer: run one round of a real
 * scenario and verify the play-by-play covers each phase + at least
 * one event of each major category (cannon placement, wall placement,
 * battle event, round end).
 */

import { assert, assertEquals } from "@std/assert";
import { createNarrativeObserver } from "./narrative-observer.ts";
import { createScenario, waitForEvent } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";

Deno.test(
  "narrative observer: captures phase headers and key events for round 1",
  async () => {
    const sc = await createScenario({ seed: 42, mode: "modern", rounds: 2 });
    const narrative = createNarrativeObserver();
    narrative.attach(sc);
    try {
      waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === 1, {
        timeoutMs: 120_000,
        label: "round-1-end",
      });
    } finally {
      narrative.detach();
    }

    const lines = narrative.lines;
    assert(lines.length > 0, "narrative should not be empty");

    // Phase headers — emitted as `── r1 PHASE ──` dividers, not per-event.
    const hasHeader = (phase: string): boolean =>
      lines.some((line) => line === `── r1 ${phase} ──`);
    assert(hasHeader("CANNON_PLACE"), "missing CANNON_PLACE header");
    assert(hasHeader("BATTLE"), "missing BATTLE header");
    assert(hasHeader("WALL_BUILD"), "missing WALL_BUILD header");

    // Per-event narration — at least one of each major category.
    assert(
      lines.some((line) => /cannon@\d+ \(\d+,\d+\)/.test(line)),
      "missing cannon placements",
    );
    assert(
      lines.some((line) => /placed \d+w in \d+ pieces/.test(line)),
      "missing wall-placement summary",
    );
    assert(
      lines.some((line) => / → .* (wall|cannon)@/.test(line)),
      "missing battle hit/damage events",
    );
    assert(
      lines.some((line) => line.startsWith("r1 END:")),
      "missing round-end summary",
    );
  },
);

Deno.test(
  "narrative observer: detach unsubscribes (no further lines after detach)",
  async () => {
    const sc = await createScenario({ seed: 42, mode: "classic", rounds: 2 });
    const narrative = createNarrativeObserver();
    narrative.attach(sc);
    waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === 1, {
      timeoutMs: 120_000,
      label: "round-1-end",
    });
    const linesAtDetach = narrative.lines.length;
    narrative.detach();

    // Drive another round — observer should be silent.
    try {
      waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === 2, {
        timeoutMs: 120_000,
        label: "round-2-end",
      });
    } catch {
      // Game may end early; either way, no more lines should be added.
    }

    assertEquals(
      narrative.lines.length,
      linesAtDetach,
      "no lines should be appended after detach",
    );
  },
);
