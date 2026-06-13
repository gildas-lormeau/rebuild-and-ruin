/**
 * Settles the "Contradictory RNG-safety claims around the dialog window"
 * review item (2026-06-12 full-domain).
 *
 * upgrade-pick.ts argues the cross-peer skew in dialog resolution is safe
 * because "no shared-RNG consumer runs in the window". The action-schedule
 * drain DOES run in dialog modes (and a seat-takeover applies through it),
 * so that claim needs proof rather than assertion. This test proves the
 * consequence directly: `state.rng` must not advance for a single tick while
 * an auto-resolving dialog is open — the lockstep cursor is frozen, so the
 * per-peer resolution tick can skew without forking.
 *
 * Why this generalises to a mid-dialog LEAVE (the finding's worry): the only
 * thing the drain can carry that touches AI state in the dialog window is a
 * seat-takeover, and its `primeAiControllerForPhase` runs only rng-free
 * resets/build-init in the dialog phases (UPGRADE_PICK -> reset() only;
 * WALL_BUILD/life-lost -> reset() + initBuild, both rng-free). The dialog
 * tick itself is rng-neutral too (life-lost = constant CONTINUE; upgrade =
 * a PRIVATE derived Rng, never state.rng).
 */

import { assertEquals } from "@std/assert";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createScenario } from "./scenario.ts";

Deno.test("dialog window: state.rng is frozen while the upgrade-pick dialog is open", async () => {
  // Modern inserts UPGRADE_PICK between BATTLE and WALL_BUILD from round 3.
  const sc = await createScenario({ mode: "modern", rounds: 5 });
  sc.runUntil(() => sc.mode() === Mode.UPGRADE_PICK, { timeoutMs: 120_000 });

  const frozen = sc.state.rng.getState();
  let inWindowTicks = 0;
  // Tick through the entire dialog window. The resolution tick (the one that
  // leaves UPGRADE_PICK) dispatches the next phase and may draw, so assert
  // only on ticks that stay inside the window.
  while (sc.mode() === Mode.UPGRADE_PICK) {
    sc.tick(1);
    if (sc.mode() !== Mode.UPGRADE_PICK) break;
    assertEquals(
      sc.state.rng.getState(),
      frozen,
      `state.rng advanced inside the upgrade-pick window (in-window tick ${inWindowTicks})`,
    );
    inWindowTicks++;
  }

  // Guard against a vacuous pass: the window must actually span ticks (the
  // AI auto-pick dwells UPGRADE_PICK_AUTO_DELAY + stagger before resolving).
  assertEquals(
    inWindowTicks > 0,
    true,
    "expected to spend at least one tick inside the UPGRADE_PICK window",
  );
});
