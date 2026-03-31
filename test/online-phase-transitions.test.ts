/**
 * Phase transition recipe tests: executeTransition ordering, runBuildEndSequence.
 *
 * Verifies that the shared transition recipes run steps in the correct order
 * and that the build-end sequence correctly dispatches life-lost notifications.
 *
 * Run with: bun test/online-phase-transitions.test.ts
 */

import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  runBuildEndSequence,
} from "../src/phase-transition-shared.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// executeTransition step ordering
// ---------------------------------------------------------------------------

test("CANNON_START_STEPS executes in order: banner, checkpoint, controllers", () => {
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

test("BATTLE_START_STEPS executes in order: banner, checkpoint, snapshot", () => {
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

test("BUILD_START_STEPS executes in order: banner, checkpoint, controllers", () => {
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

test("runBuildEndSequence calls afterLifeLostResolved when no players need action", () => {
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
    afterLifeLostResolved: () => {
      resolved = true;
    },
  });

  assert(scoresDone, "showScoreDeltas should have been called");
  assert(resolved, "afterLifeLostResolved should have been called");
});

test("runBuildEndSequence notifies life-lost for each affected player", () => {
  const notified: number[] = [];
  let dialogShown = false;

  runBuildEndSequence({
    needsReselect: [0, 2],
    eliminated: [1],
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

test("runBuildEndSequence does not call afterLifeLostResolved when dialog is shown", () => {
  let resolved = false;

  runBuildEndSequence({
    needsReselect: [0],
    eliminated: [],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: () => {},
    showLifeLostDialog: () => {},
    afterLifeLostResolved: () => {
      resolved = true;
    },
  });

  assert(!resolved, "afterLifeLostResolved should NOT be called when dialog is shown");
});

test("runBuildEndSequence shows dialog for eliminated-only (no reselect)", () => {
  let dialogShown = false;
  const notified: number[] = [];

  runBuildEndSequence({
    needsReselect: [],
    eliminated: [2],
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

test("runBuildEndSequence works without afterLifeLostResolved (watcher mode)", () => {
  // Watchers omit afterLifeLostResolved — should not throw
  runBuildEndSequence({
    needsReselect: [],
    eliminated: [],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: () => {},
    showLifeLostDialog: () => {},
    // no afterLifeLostResolved
  });
  // If we reach here without error, the test passes
});

await runTests("Online phase transition recipes");
