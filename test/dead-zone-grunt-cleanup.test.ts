/**
 * Regression: grunts stranded in an eliminated player's zone must be
 * swept at the RIGHT time — not magically mid-battle, not magically
 * mid-build, and not never. The sweep must happen exactly once per
 * round, at the BUILD → CANNON_PLACE transition (under the cannons
 * banner sweep).
 *
 * Lifecycle contract per round (after Blue is eliminated):
 *   - BATTLE: stranded grunts remain (they walked there during frozen)
 *   - WALL_BUILD: stranded grunts remain throughout the entire phase
 *   - CANNON_PLACE start: stranded grunts are GONE (swept in transition)
 *
 * Method: continuous per-tick sampling. For each round with stranding,
 * we identify every tick and the dead-zone grunt count. We then extract
 * the first drop-to-zero event and assert its phase is CANNON_PLACE.
 *
 * Reproduction: seed 604090 modern. frozen_river round 21, Blue elim
 * round 22, grunts drift into Blue's zone on subsequent frozen rolls.
 */

import { assert } from "@std/assert";
import { createScenario, waitForModifier } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { isPlayerEliminated } from "../src/shared/core/player-types.ts";
import type { GameState } from "../src/shared/core/types.ts";

type Sample = {
  tickIdx: number;
  round: number;
  phase: Phase;
  timer: number;
  inDead: number;
};

const FROZEN_RIVER = "frozen_river" as const;

Deno.test("dead-zone grunt sweep timing: present through battle+build, removed at CANNON_PLACE transition", async () => {
  const sc = await createScenario({
    seed: 604090,
    mode: "modern",
    rounds: 100,
  });

  const samples: Sample[] = [];

  waitForModifier(sc, FROZEN_RIVER, { timeoutMs: 1_500_000 });
  const frozenRound = sc.state.round;
  console.log(`frozen_river round ${frozenRound}`);

  // Manual tick loop for dense sampling (TICK event isn't emitted by
  // the headless gameloop — only the E2E bridge emits it).
  const MAX_TICKS = 60_000;
  for (let t = 0; t < MAX_TICKS; t++) {
    sc.tick(1);
    samples.push({
      tickIdx: t,
      round: sc.state.round,
      phase: sc.state.phase,
      timer: sc.state.timer,
      inDead: gruntsInDeadZones(sc.state),
    });
    if (sc.state.round >= frozenRound + 5) break;
    if (sc.state.players.filter((p) => p.homeTower !== null).length < 2) break;
  }

  console.log(`total samples: ${samples.length}`);

  // Group by round and find the tick range where inDead > 0 per round.
  type RoundReport = {
    round: number;
    firstNonZeroTick?: number;
    firstNonZeroPhase?: Phase;
    peak: number;
    lastNonZeroTick?: number;
    lastNonZeroPhase?: Phase;
    firstZeroAfterNonZeroTick?: number;
    firstZeroAfterNonZeroPhase?: Phase;
    // Per-phase peaks (inside this round)
    battlePeak: number;
    buildPeak: number;
    cannonPeak: number;
  };
  const reports = new Map<number, RoundReport>();

  for (const s of samples) {
    let report = reports.get(s.round);
    if (!report) {
      report = {
        round: s.round,
        peak: 0,
        battlePeak: 0,
        buildPeak: 0,
        cannonPeak: 0,
      };
      reports.set(s.round, report);
    }
    if (s.inDead > 0) {
      if (report.firstNonZeroTick === undefined) {
        report.firstNonZeroTick = s.tickIdx;
        report.firstNonZeroPhase = s.phase;
      }
      report.lastNonZeroTick = s.tickIdx;
      report.lastNonZeroPhase = s.phase;
      if (s.inDead > report.peak) report.peak = s.inDead;
    }
    if (s.phase === Phase.BATTLE && s.inDead > report.battlePeak) report.battlePeak = s.inDead;
    if (s.phase === Phase.WALL_BUILD && s.inDead > report.buildPeak) report.buildPeak = s.inDead;
    if (s.phase === Phase.CANNON_PLACE && s.inDead > report.cannonPeak) report.cannonPeak = s.inDead;
  }

  // For each report with nonzero peak, find the first sample AFTER
  // lastNonZeroTick (i.e. the tick when the sweep landed).
  // Also compute: after the sweep, how many WALL_BUILD ticks remained
  // before phase changed? If ≤ 2, the sweep was at end-of-build (good).
  // If many, it was mid-build (bad).
  const buildTicksAfterSweepByRound = new Map<number, number>();
  for (const r of reports.values()) {
    if (r.lastNonZeroTick === undefined) continue;
    for (const s of samples) {
      if (s.tickIdx > r.lastNonZeroTick && s.inDead === 0) {
        r.firstZeroAfterNonZeroTick = s.tickIdx;
        r.firstZeroAfterNonZeroPhase = s.phase;
        break;
      }
    }
    // Count WALL_BUILD ticks in this round that occurred AFTER the
    // sweep — if many, sweep was mid-build.
    let remainingBuildTicks = 0;
    for (const s of samples) {
      if (s.round !== r.round) continue;
      if (s.tickIdx <= (r.firstZeroAfterNonZeroTick ?? -1)) continue;
      if (s.phase !== Phase.WALL_BUILD) break;
      remainingBuildTicks++;
    }
    buildTicksAfterSweepByRound.set(r.round, remainingBuildTicks);
  }

  const strandedRounds = [...reports.values()].filter((r) => r.peak > 0);

  console.log("\n=== PER-ROUND REPORTS ===");
  for (const r of [...reports.values()].sort((a, b) => a.round - b.round)) {
    console.log(
      `round ${r.round}: peak=${r.peak}  battlePeak=${r.battlePeak}  buildPeak=${r.buildPeak}  cannonPeak=${r.cannonPeak}  ` +
        `firstNonZero@${r.firstNonZeroTick}(${r.firstNonZeroPhase})  ` +
        `lastNonZero@${r.lastNonZeroTick}(${r.lastNonZeroPhase})  ` +
        `firstZeroAfter@${r.firstZeroAfterNonZeroTick}(${r.firstZeroAfterNonZeroPhase})`,
    );
  }

  assert(
    strandedRounds.length > 0,
    "Test premise broken: no round showed any grunt in a dead zone. Pick a different seed.",
  );

  const errors: string[] = [];

  // For each stranded round, find the sweep tick's and the prior tick's
  // state.timer.
  //   prev.timer <= 0  → build timer JUST expired at this tick, finalize
  //     ran, banner timer was then set → sweep is at end-of-build (good).
  //   prev.timer > 0   → build timer was still active → sweep happened
  //     mid-build (bad).
  const sweepPrevTimerByRound = new Map<number, number>();
  const sweepCurTimerByRound = new Map<number, number>();
  for (const r of strandedRounds) {
    if (r.firstZeroAfterNonZeroTick === undefined) continue;
    const idx = samples.findIndex(
      (s) => s.tickIdx === r.firstZeroAfterNonZeroTick,
    );
    if (idx <= 0) continue;
    sweepCurTimerByRound.set(r.round, samples[idx]!.timer);
    sweepPrevTimerByRound.set(r.round, samples[idx - 1]!.timer);
  }

  for (const r of strandedRounds) {
    // (1) Grunts must be visible during BATTLE or BUILD for this round
    // (not magically absent the moment they cross in).
    if (r.battlePeak === 0 && r.buildPeak === 0) {
      errors.push(
        `round ${r.round}: stranded only during CANNON_PLACE (battlePeak=0, buildPeak=0, cannonPeak=${r.cannonPeak}) — this would mean grunts are invisible during the phases they actually occupy the zone`,
      );
    }
    // (2) Sweep MUST NOT happen mid-battle: if battlePeak > 0 but the
    // last non-zero tick is in BATTLE phase and the next zero sample is
    // also still in BATTLE, the grunts vanished mid-battle.
    if (
      r.battlePeak > 0 &&
      r.lastNonZeroPhase === Phase.BATTLE &&
      r.firstZeroAfterNonZeroPhase === Phase.BATTLE
    ) {
      errors.push(
        `round ${r.round}: grunts removed MID-BATTLE (last nonzero + first zero both in BATTLE) — magical early sweep`,
      );
    }
    // (3) Sweep MUST NOT happen mid-build. Timer-based detection: if
    // state.timer > 0 at the sweep tick, we're still in active build
    // (the timer would reach 0 before finalizeRound can run). A
    // correct sweep happens when timer is 0 (finalizeRound has
    // fired at end of active build; phase stays WALL_BUILD while the
    // post-build banner/UI plays before transition to CANNON_PLACE).
    const prevTimer = sweepPrevTimerByRound.get(r.round);
    const curTimer = sweepCurTimerByRound.get(r.round);
    // Epsilon accounts for floating-point drift at timer=0 boundary.
    // Per-frame dt is ~0.017s; anything below ~0.02s is "expired".
    const EXPIRED_EPSILON = 0.02;
    if (
      r.buildPeak > 0 &&
      r.firstZeroAfterNonZeroPhase === Phase.WALL_BUILD &&
      prevTimer !== undefined &&
      prevTimer > EXPIRED_EPSILON
    ) {
      errors.push(
        `round ${r.round}: grunts removed MID-BUILD — prev-tick state.timer=${prevTimer}s at sweep (expected <=${EXPIRED_EPSILON}s, i.e. build timer had just expired). curTimer=${curTimer}`,
      );
    }
    // (4) At CANNON_PLACE start, grunts must be gone (cannonPeak == 0).
    if (r.cannonPeak > 0) {
      errors.push(
        `round ${r.round}: ${r.cannonPeak} grunt(s) still stranded during CANNON_PLACE — sweep didn't happen at build→cannon transition`,
      );
    }
    // (5) Sweep must land on the build→cannon boundary. Allowed phases
    // for firstZero: WALL_BUILD (timer<=0 means finalize ran, banner
    // about to play) or CANNON_PLACE (phase already flipped). Anything
    // else (BATTLE, CASTLE_SELECT, UPGRADE_PICK…) is wrong.
    const allowedSweepPhase =
      r.firstZeroAfterNonZeroPhase === Phase.CANNON_PLACE ||
      r.firstZeroAfterNonZeroPhase === Phase.WALL_BUILD;
    if (r.firstZeroAfterNonZeroPhase !== undefined && !allowedSweepPhase) {
      errors.push(
        `round ${r.round}: sweep landed in phase=${r.firstZeroAfterNonZeroPhase} (expected WALL_BUILD end-of-phase or CANNON_PLACE start)`,
      );
    }
    // (6) Buildpeak must hold until end of build. If lastNonZero is in
    // BUILD phase, that's proof the grunts stayed through build.
    // If buildPeak > 0 and lastNonZero is BATTLE (not BUILD), they got
    // cleaned pre-build.
    if (
      r.buildPeak > 0 &&
      r.lastNonZeroPhase !== Phase.WALL_BUILD &&
      r.lastNonZeroPhase !== Phase.CANNON_PLACE
    ) {
      errors.push(
        `round ${r.round}: had grunts in build (peak=${r.buildPeak}) but last-non-zero was in ${r.lastNonZeroPhase} — grunts disappeared before build ended`,
      );
    }
  }

  if (errors.length > 0) {
    console.log("\n=== TIMING VIOLATIONS ===");
    for (const err of errors) console.log(`  ${err}`);
  } else {
    console.log("\n=== ALL TIMING CHECKS PASSED ===");
    for (const r of strandedRounds) {
      console.log(
        `  round ${r.round}: grunts present battlePeak=${r.battlePeak}, buildPeak=${r.buildPeak}; swept at ${r.lastNonZeroPhase}→${r.firstZeroAfterNonZeroPhase} transition`,
      );
    }
  }

  assert(errors.length === 0, `${errors.length} timing violation(s) — see log`);

  sc[Symbol.dispose]();
});

function gruntsInDeadZones(state: GameState): number {
  const dead = deadZones(state);
  if (dead.size === 0) return 0;
  let count = 0;
  for (const grunt of state.grunts) {
    const zone = state.map.zones[grunt.row]?.[grunt.col] ?? -1;
    if (dead.has(zone)) count++;
  }
  return count;
}

function deadZones(state: GameState): Set<number> {
  const zones = new Set<number>();
  for (const player of state.players) {
    if (!isPlayerEliminated(player)) continue;
    const zone = state.playerZones[player.id];
    if (zone !== undefined) zones.add(zone);
  }
  return zones;
}
