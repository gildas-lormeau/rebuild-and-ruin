/**
 * Verifies the late-joiner path for combos: a watcher that joins (or is
 * promoted to host) mid-battle must inherit the host's `comboTracker.players`
 * counters from the FullStateMessage. Without serialization (the pre-fix
 * behavior), the watcher's tracker stays null/zero, and any subsequent
 * `comboDemolitionBonus` call on that peer would miscalculate.
 *
 * Test shape: build a host scenario in modern mode, run it deep enough that
 * the host's comboTracker has at least one non-zero counter, snapshot via
 * `createFullStateMessage`, deliver to a freshly-built watcher, assert the
 * watcher's comboTracker mirrors the host's per-player counters.
 *
 * The cosmetic `events` array (floating-text queue) is intentionally not
 * wired through the checkpoint; the test asserts on the counters only.
 *
 * Run with: deno test --no-check test/online-combos-late-join.test.ts
 */

import { assert, assertEquals } from "@std/assert";
import {
  createFullStateMessage,
  restoreFullStateSnapshot,
} from "../src/online/online-serialize.ts";
import { createScenario } from "./scenario.ts";

Deno.test("combos: watcher restores comboTracker.players from mid-battle FullStateMessage", async () => {
  using host = await createScenario({
    seed: 42,
    mode: "modern",
    rounds: 2,
    online: "host",
  });

  // Drive the host until comboTracker has at least one non-zero counter.
  // Wall destructions are the most common combo trigger — AI cannons in
  // modern mode produce them within the first battle. Timeout is generous
  // (sim-ms on headless) so this doesn't depend on a tight battle pace.
  await host.runUntil(
    () => {
      const tracker = host.state.modern?.comboTracker;
      if (!tracker) return false;
      return tracker.players.some(
        (player) =>
          player.wallsDestroyedThisRound > 0 ||
          player.wallStreak > 0 ||
          player.gruntStreak > 0,
      );
    },
    { timeoutMs: 120_000 },
  );

  const hostTracker = host.state.modern!.comboTracker;
  assert(hostTracker !== null, "host should have a comboTracker mid-battle");
  const hostCounters = hostTracker.players.map((player) => ({ ...player }));

  // Sanity: at least one player has a non-zero counter (otherwise the
  // round-trip is vacuous — we'd be comparing two zero arrays).
  assert(
    hostCounters.some(
      (player) =>
        player.wallsDestroyedThisRound > 0 ||
        player.wallStreak > 0 ||
        player.gruntStreak > 0,
    ),
    "expected at least one non-zero counter on the host before snapshotting",
  );

  // Fresh watcher — same mode/seed so player counts and feature gates match.
  // No `runUntil` here: the watcher stays at match-start, so its
  // comboTracker is null until the FullStateMessage arrives.
  using watcher = await createScenario({
    seed: 42,
    mode: "modern",
    rounds: 2,
  });

  // Apply via the same code path the production lifecycle handler uses
  // (deps.migration.restoreFullState → restoreFullStateSnapshot). Bypasses
  // the session-level isHost / migrationSeq gates — those are exercised by
  // network-vs-local.test.ts; here we're verifying the deserialize block
  // for `comboTracker` specifically.
  const msg = createFullStateMessage(host.state, 0);
  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result !== null, "FullStateMessage should pass validation");

  const watcherTracker = watcher.state.modern?.comboTracker;
  assert(
    watcherTracker !== null && watcherTracker !== undefined,
    "watcher should have a comboTracker after applying the host's FullStateMessage",
  );
  assertEquals(
    watcherTracker.players.length,
    hostCounters.length,
    "watcher tracker should have the same per-player slot count",
  );

  for (let pid = 0; pid < hostCounters.length; pid++) {
    const host = hostCounters[pid]!;
    const watcher = watcherTracker.players[pid]!;
    assertEquals(
      watcher.wallsDestroyedThisRound,
      host.wallsDestroyedThisRound,
      `player ${pid} wallsDestroyedThisRound`,
    );
    assertEquals(watcher.wallStreak, host.wallStreak, `player ${pid} wallStreak`);
    assertEquals(
      watcher.lastWallHitTime,
      host.lastWallHitTime,
      `player ${pid} lastWallHitTime`,
    );
    assertEquals(
      watcher.gruntStreak,
      host.gruntStreak,
      `player ${pid} gruntStreak`,
    );
    assertEquals(
      watcher.lastGruntKillTime,
      host.lastGruntKillTime,
      `player ${pid} lastGruntKillTime`,
    );
  }

  // Cosmetic events are intentionally not wired through the checkpoint —
  // the watcher starts with an empty events array regardless of host state.
  assertEquals(
    watcherTracker.events,
    [],
    "watcher events array should be empty (cosmetic queue not serialized)",
  );
});
