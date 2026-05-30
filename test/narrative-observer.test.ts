/**
 * Format reference + smoke test for the narrative observer. Beyond checking
 * that a real game gets narrated, this file pins the log's machine-readable
 * contract: every per-event line leads with an UPPERCASE `[TYPE]` tag from a
 * declared set, the tag set is prefix-free (so a bracket-less grep can't
 * conflate two types), and the only untagged lines are the structural anchors
 * (phase headers, round-end, game-end). It is the single place that contract
 * is enforced — keep `EVENT_TAGS` in sync with narrative-observer.ts.
 */

import { assert, assertEquals } from "@std/assert";
import { createNarrativeObserver } from "./narrative-observer.ts";
import { createScenario, waitForEvent } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";

/** Canonical event-tag vocabulary. Every indented per-event line must lead
 *  with one of these (`  [TAG] …`); nothing else may. A renamed, typo'd, or
 *  new tag fails the structural conformance check below. */
const EVENT_TAGS = [
  // build / meta
  "CASTLE",
  "PLACE",
  "BUILD",
  "ENCLOSE",
  "TRAP",
  "CRUSH",
  "LIFE",
  "ELIM",
  "MODIFIER",
  "UPGRADE",
  // battle
  "FIRE",
  "POWER",
  "WALL",
  "CANNON",
  "HOUSE",
  "TOWER",
  "GRUNT",
  "PIT",
] as const;
/** Lines that are intentionally NOT `[TYPE]`-tagged — they are their own
 *  greppable anchors (and `rN END:` / `GAME END` are parsed by watch-game). */
const STRUCTURAL_PATTERNS = [
  /^── r\d+ .+ ──$/, // phase / modifier / skip headers
  /^r\d+ END: /, // round-end summary
  /^GAME END r\d+: /, // game-end summary
];

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

    // Coverage — each major category narrated at least once. Keyed on the
    // stable `[TAG]` prefix, not brittle prose, so verb/wording tweaks don't
    // break it (they did before, silently — this file is in no fast lane).
    const hasTag = (tag: string): boolean =>
      lines.some((line) => line.startsWith(`  [${tag}] `));
    assert(hasTag("PLACE"), "missing cannon placements");
    assert(hasTag("BUILD"), "missing wall-placement summary");
    assert(
      hasTag("WALL") || hasTag("CANNON"),
      "missing battle hit/damage events",
    );
    assert(
      lines.some((line) => line.startsWith("r1 END:")),
      "missing round-end summary",
    );

    // Structural conformance — every line is either a known structural anchor
    // or a tagged event line whose tag is in the canonical set. Catches a
    // stray/renamed tag or a new untagged line type (the drift class that
    // silently broke this test's old prose regexes).
    const tagSet = new Set<string>(EVENT_TAGS);
    for (const line of lines) {
      if (STRUCTURAL_PATTERNS.some((re) => re.test(line))) continue;
      const match = line.match(/^ {2}\[([A-Z-]+)\] /);
      assert(match, `untagged non-structural line: ${JSON.stringify(line)}`);
      assert(
        tagSet.has(match[1]!),
        `unknown event tag [${match[1]}] in: ${JSON.stringify(line)}`,
      );
    }
  },
);

Deno.test("narrative observer: event tags are prefix-free", () => {
  // No tag may be a prefix of another, so a bracket-less grep (`\[FIRE`)
  // returns exactly one event type rather than conflating `[FIRE]` with a
  // hypothetical `[FIREPOWER]`. This is the invariant that motivated the
  // `[CANNON-PLACE]`→`[PLACE]` / `[FIREPOWER]`→`[POWER]` renames.
  for (const a of EVENT_TAGS) {
    for (const b of EVENT_TAGS) {
      if (a === b) continue;
      assert(
        !b.startsWith(a),
        `tag [${a}] is a prefix of [${b}] — a bracket-less grep would conflate them`,
      );
    }
  }
});

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
