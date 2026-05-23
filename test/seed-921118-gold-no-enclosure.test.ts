/**
 * Regression: seed 921118 modern — AI build placement falls into a no-progress
 * loop when every gap-filling candidate for a chosen target is hard-rejected
 * by scoring rules (rejectIsolatedGapTiles / rejectFatWalls / rejectTinyPockets).
 *
 * Pre-fix observation: at r18 WALL_BUILD, Gold's `trySecondaryTower` accepts
 * a dead tower as repair target (its 2 ring gaps can be reached by the current
 * piece), but both gap-fillers have isolated non-gap offsets that the
 * `rejectIsolatedGapTiles` rule hard-rejects. `scoreTopCandidates` returns
 * `evaluated: false`, and the code falls to `pickFallbackPlacement` which
 * scans the FULL candidate pool (non-gap-fillers included) and places walls
 * scattered across the map. The same situation recurs for 7+ ticks; the
 * target's gap count stays at 2 while walls grow ~17 tiles. Net effect: Gold
 * places ~35 wall tiles across r18 WALL_BUILD without closing any ring,
 * scores nothing, and eventually drops to lives=0.
 *
 * Fix: when `restrictedToGapFillers` is true and `scoreTopCandidates` returns
 * `evaluated: false`, force-accept the highest-pre-score gap-filler instead
 * of the scattered fallback. Closing the ring outweighs the isolated-tile
 * penalty.
 *
 * Verification: this test plays seed 921118 modern through round 20 and
 * asserts Gold never spends >=20 wall tiles in a single round without
 * enclosing anything (the failure-mode fingerprint). Pre-fix r18 hit
 * 35 walls / 0 enclosures; post-fix every round Gold builds in has at
 * least one enclosure event when its volume is non-trivial.
 */

import { assert, assertEquals } from "@std/assert";
import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

const GOLD = 2 as ValidPlayerId;
/** Long sim-ms budget to reach round 20 from a fresh game (~20 × ~70s/round). */
const REACH_ROUND_BUDGET_MS = 3_000_000;

Deno.test("seed 921118 modern: Gold AI does not stall when gap-fillers are hard-rejected", async () => {
  const sc = await createScenario({
    seed: 921118,
    mode: "modern",
    rounds: 99,
  });

  type RoundStats = {
    wallTiles: number;
    wallEvents: number;
    enclosures: number;
  };
  const stats = new Map<number, RoundStats>();
  const get = (round: number): RoundStats => {
    let s = stats.get(round);
    if (!s) {
      s = { wallTiles: 0, wallEvents: 0, enclosures: 0 };
      stats.set(round, s);
    }
    return s;
  };

  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    if (ev.playerId !== GOLD) return;
    const s = get(sc.state.round);
    s.wallEvents++;
    s.wallTiles += ev.tileKeys.length;
  });
  sc.bus.on(GAME_EVENT.TOWER_ENCLOSED, (ev) => {
    if (ev.playerId !== GOLD) return;
    const s = get(sc.state.round);
    s.enclosures++;
  });

  // Run to start of r20 WALL_BUILD — covers the pre-fix failure window
  // (r17–r18) plus margin for the fix to demonstrate sustained play.
  waitForEvent(
    sc,
    GAME_EVENT.PHASE_START,
    (ev) => ev.phase === Phase.WALL_BUILD && sc.state.round === 20,
    { timeoutMs: REACH_ROUND_BUDGET_MS, label: "r20 WALL_BUILD start" },
  );

  // Per-round triage dump.
  const rounds = [...stats.keys()].sort((a, b) => a - b);
  console.log("round | wallEvents | wallTiles | enclosures");
  for (const round of rounds) {
    const s = stats.get(round)!;
    console.log(
      `r${String(round).padStart(2, "0")}    |     ${String(s.wallEvents).padStart(3)}    |    ${String(s.wallTiles).padStart(3)}    |     ${s.enclosures}`,
    );
  }
  const gold = sc.state.players[GOLD];
  console.log(
    `Gold at r20 start: lives=${gold?.lives} score=${gold?.score} walls=${gold?.walls.size} ownedTowers=${gold?.ownedTowers.length}`,
  );

  // Bug fingerprint: a round where Gold spent >=20 wall tiles (the AI is
  // genuinely building) but zero enclosure events fired — i.e. every wall
  // landed somewhere that doesn't close any ring. Pre-fix this is r18 (35
  // wall tiles, 0 enclosures). Post-fix never triggers.
  const stalledRounds = rounds.filter((round) => {
    const s = stats.get(round)!;
    return s.wallTiles >= 20 && s.enclosures === 0;
  });
  assertEquals(
    stalledRounds,
    [],
    `Gold built without enclosing in these rounds: ${stalledRounds
      .map(
        (round) =>
          `r${round}=${stats.get(round)!.wallTiles}walls/${stats.get(round)!.enclosures}encl`,
      )
      .join(", ")}. ` +
      `Pre-fix signature: every gap-filler gets hard-rejected by scoring rules and the AI falls to the scattered-fallback no-progress loop.`,
  );

  // Aggregate sanity check.
  const totalEnclosures = rounds.reduce(
    (sum, round) => sum + stats.get(round)!.enclosures,
    0,
  );
  assert(
    totalEnclosures >= 3,
    `Gold enclosed only ${totalEnclosures} towers across r1–r19 — far below baseline.`,
  );

  // Gold survives the window — pre-fix the stall compounded into elimination.
  assert(
    gold && gold.lives >= 1,
    `Gold was eliminated by r20 (lives=${gold?.lives}). Downstream symptom of the no-enclosure stall.`,
  );
});
