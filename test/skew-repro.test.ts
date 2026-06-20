// R5b regression guard. Deterministic in-process reproduction of the parity
// fork: two networked peers driven with a constant wire delay that breaches the
// 8-tick SAFETY buffer (the flake-free equivalent of a real-world jitter / CPU
// stall spike). R5b's contract: a buffer breach may leave a small *localized*
// board diff, but it must NEVER fork the shared `state.rng` cursor (which would
// cascade into a total, silent, permanent desync). This test asserts exactly
// that — `rngH === rngW` for every (delay, seed, mode) across the sweep, up to
// delay 20 (12 ticks past the buffer). The residual board diffs are expected
// and only logged. See docs/runtime-invariants.md › R5b.
//
// Run: deno test -A --no-check test/skew-repro.test.ts

// scenario.ts MUST evaluate before network-setup.ts so the 3D-sprite
// module-load code (elevation.ts → boundsYOf → procedural-texture) takes its
// SSR-safe early return while `document` is still undefined — BEFORE
// network-setup installs online-dom-shim's canvas-less `document`. Imported as
// a value (not type-only) to force evaluation order. See
// docs/headless-3d-import-order-footgun.md.

import { createScenario, type Scenario } from "./scenario.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  createBidirectionalNetworkedPair,
  type PlayerParitySnapshot,
  snapshotPlayers,
} from "./network-setup.ts";

const DELAYS = [4, 8, 9, 10, 12, 16, 20];
const TRIALS = [
  { seed: 1, mode: "classic" as const, rounds: 3 },
  { seed: 42, mode: "classic" as const, rounds: 3 },
  { seed: 99, mode: "classic" as const, rounds: 3 },
  { seed: 7, mode: "modern" as const, rounds: 5 },
];

void createScenario;

Deno.test("skew-repro: shared rng cursor never forks across the SAFETY-buffer sweep (R5b)", async () => {
  const rngForks: string[] = [];
  console.log("\ndelay  seed   mode      rngFork  stateFork");
  for (const delay of DELAYS) {
    for (const trial of TRIALS) {
      let line = `${String(delay).padEnd(6)} ${String(trial.seed).padEnd(6)} ${trial.mode.padEnd(8)}`;
      const pair = await createBidirectionalNetworkedPair({
        seed: trial.seed,
        mode: trial.mode,
        rounds: trial.rounds,
        assistedSlotsHost: [0 as ValidPlayerId, 2 as ValidPlayerId],
        assistedSlotsWatcher: [1 as ValidPlayerId],
        wireDelayFrames: delay,
      });
      await runToEnd(pair.host, pair.watcher, pair.pump);
      const rngH = pair.host.state.rng.getState();
      const rngW = pair.watcher.state.rng.getState();
      const rngForked = rngH !== rngW;
      const stateDiff = playersDiff(
        snapshotPlayers(pair.host),
        snapshotPlayers(pair.watcher),
      );
      if (rngForked) {
        rngForks.push(
          `delay=${delay} seed=${trial.seed} ${trial.mode}: rngH=${rngH} rngW=${rngW}`,
        );
      }
      line += `  ${rngForked ? "FORK " : "  -  "}    ${stateDiff ? "diff: " + stateDiff : "-"}`;
      console.log(line);
    }
  }
  if (rngForks.length > 0) {
    throw new Error(
      `R5b violated — shared rng cursor forked in ${rngForks.length} run(s):\n` +
        rngForks.join("\n"),
    );
  }
});

async function runToEnd(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  maxSteps = 60_000,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    host.tick(1);
    watcher.tick(1);
    await pump();
    if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) return;
  }
  throw new Error(
    `did not reach STOPPED in ${maxSteps} (host=${host.mode()} watcher=${watcher.mode()})`,
  );
}

function playersDiff(
  a: readonly PlayerParitySnapshot[],
  b: readonly PlayerParitySnapshot[],
): string {
  if (a.length !== b.length) return `count ${a.length}vs${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return `slot${i} ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
    }
  }
  return "";
}
