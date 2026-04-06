import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  runBuildEndSequence,
} from "../src/game/phase-transition-steps.ts";
import { assert } from "jsr:@std/assert";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";

// ---------------------------------------------------------------------------
// executeTransition step ordering
// ---------------------------------------------------------------------------

Deno.test("CANNON_START_STEPS executes in order: banner, checkpoint, controllers", () => {
  const order: string[] = [];
  executeTransition(CANNON_START_STEPS, {
    showBanner: () => order.push("banner"),
    applyCheckpoint: () => order.push("checkpoint"),
    initControllers: () => order.push("controllers"),
  });
  assert(order.length === 3, `expected 3 steps, got ${order.length}`);
  assert(order[0] === "banner", `step 0: expected banner, got ${order[0]}`);
  assert(order[1] === "checkpoint", `step 1: expected checkpoint, got ${order[1]}`);
  assert(order[2] === "controllers", `step 2: expected controllers, got ${order[2]}`);
});

Deno.test("BATTLE_START_STEPS executes in order: banner, checkpoint, snapshot", () => {
  const order: string[] = [];
  executeTransition(BATTLE_START_STEPS, {
    showBanner: () => order.push("banner"),
    applyCheckpoint: () => order.push("checkpoint"),
    snapshotForBanner: () => order.push("snapshot"),
  });
  assert(order.length === 3, `expected 3 steps, got ${order.length}`);
  assert(order[0] === "banner", `step 0: expected banner, got ${order[0]}`);
  assert(order[1] === "checkpoint", `step 1: expected checkpoint, got ${order[1]}`);
  assert(order[2] === "snapshot", `step 2: expected snapshot, got ${order[2]}`);
});

Deno.test("BUILD_START_STEPS executes in order: banner, checkpoint, controllers", () => {
  const order: string[] = [];
  executeTransition(BUILD_START_STEPS, {
    showBanner: () => order.push("banner"),
    applyCheckpoint: () => order.push("checkpoint"),
    initControllers: () => order.push("controllers"),
  });
  assert(order.length === 3, `expected 3 steps, got ${order.length}`);
  assert(order[0] === "banner", `step 0: expected banner, got ${order[0]}`);
  assert(order[1] === "checkpoint", `step 1: expected checkpoint, got ${order[1]}`);
  assert(order[2] === "controllers", `step 2: expected controllers, got ${order[2]}`);
});

// ---------------------------------------------------------------------------
// runBuildEndSequence
// ---------------------------------------------------------------------------

Deno.test("runBuildEndSequence calls onLifeLostResolved when no players need action", () => {
  let resolved = false;
  let scoresDone = false;

  runBuildEndSequence({
    needsReselect: [],
    eliminated: [],
    showScoreDeltas: (onDone) => {
      scoresDone = true;
      onDone();
    },
    notifyLifeLost: () => {
      throw new Error("should not notify when no players need action");
    },
    showLifeLostDialog: () => {
      throw new Error("should not show dialog when no players need action");
    },
    onLifeLostResolved: () => {
      resolved = true;
    },
  });

  assert(scoresDone, "showScoreDeltas should have been called");
  assert(resolved, "onLifeLostResolved should have been called");
});

Deno.test("runBuildEndSequence notifies life-lost for each affected player", () => {
  const notified: number[] = [];
  let dialogShown = false;

  runBuildEndSequence({
    needsReselect: [0 as ValidPlayerSlot, 2 as ValidPlayerSlot],
    eliminated: [1 as ValidPlayerSlot],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: (pid) => notified.push(pid),
    showLifeLostDialog: () => {
      dialogShown = true;
    },
  });

  assert(notified.length === 3, `expected 3 notifications, got ${notified.length}`);
  assert(notified[0] === 0, `first notify: expected 0, got ${notified[0]}`);
  assert(notified[1] === 2, `second notify: expected 2, got ${notified[1]}`);
  assert(notified[2] === 1, `third notify: expected 1, got ${notified[2]}`);
  assert(dialogShown, "life-lost dialog should have been shown");
});

Deno.test("runBuildEndSequence does not call onLifeLostResolved when dialog is shown", () => {
  let resolved = false;

  runBuildEndSequence({
    needsReselect: [0 as ValidPlayerSlot],
    eliminated: [],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: () => {},
    showLifeLostDialog: () => {},
    onLifeLostResolved: () => {
      resolved = true;
    },
  });

  assert(!resolved, "onLifeLostResolved should NOT be called when dialog is shown");
});

Deno.test("runBuildEndSequence shows dialog for eliminated-only (no reselect)", () => {
  let dialogShown = false;
  const notified: ValidPlayerSlot[] = [];

  runBuildEndSequence({
    needsReselect: [],
    eliminated: [2 as ValidPlayerSlot],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: (pid) => notified.push(pid),
    showLifeLostDialog: (reselect, elim) => {
      dialogShown = true;
      assert(reselect.length === 0, "reselect should be empty");
      assert(elim.length === 1, "eliminated should have 1 entry");
    },
  });

  assert(notified.length === 1, "should notify the eliminated player");
  assert(notified[0] === 2, `notified wrong player: expected 2, got ${notified[0]}`);
  assert(dialogShown, "dialog should be shown for elimination");
});

Deno.test("runBuildEndSequence works without onLifeLostResolved (watcher mode)", () => {
  // Watchers omit onLifeLostResolved — should not throw
  runBuildEndSequence({
    needsReselect: [],
    eliminated: [],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: () => {},
    showLifeLostDialog: () => {},
    // no onLifeLostResolved
  });
  // If we reach here without error, the test passes
});

