/**
 * Re-probe seeds for the bidirectional ABANDON parity test
 * (test/network-bidirectional-abandon.test.ts). A qualifying seed is one where
 * a forced-ABANDON slot actually reaches a life-loss AND the two peers stay in
 * full lockstep — fires (≥1 elimination) + equal elim count + identical RNG
 * cursor + identical player snapshots. Dynamics changes (grunt/house/battle)
 * shift which seeds qualify; run this and paste the results into TRIALS.
 *
 * Usage:
 *   deno run -A scripts/probe-abandon-seeds.ts --mode classic --rounds 8 --count 4 --max 50
 */

import { LifeLostChoice } from "../src/shared/core/dialog-state.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

if (import.meta.main) await main();

async function main(): Promise<void> {
  // Install the headless DOM/canvas shim BEFORE the runtime/render graph loads.
  // These are dynamic imports (not top-level) precisely so biome's import sort
  // can't reorder scenario.ts after network-setup.ts — the latter evaluates the
  // 3D sprite modules at import time and needs the shim already in place.
  await import("../test/scenario.ts");
  const { createBidirectionalNetworkedPair, snapshotPlayers } = await import(
    "../test/network-setup.ts"
  );

  const args = Deno.args;
  const flag = (name: string, def: number): number => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
  };
  const mode: "classic" | "modern" =
    args[args.indexOf("--mode") + 1] === "modern" ? "modern" : "classic";
  const rounds = flag("--rounds", 8);
  const count = flag("--count", 4);
  const max = flag("--max", 50);

  console.log(
    `Probing ${mode} r${rounds} for ${count} full-parity ABANDON seeds (scan 0..${max - 1})…`,
  );
  const good: number[] = [];
  for (let seed = 0; seed < max && good.length < count; seed++) {
    try {
      const { host, watcher, pump } = await createBidirectionalNetworkedPair({
        seed,
        mode,
        rounds,
        assistedSlotsHost: [0 as ValidPlayerId],
        assistedSlotsWatcher: [1 as ValidPlayerId],
        wireDelayFrames: 5,
        testHooks: {
          lifeLostChoices: [
            { playerId: 0 as ValidPlayerId, choice: LifeLostChoice.ABANDON },
            { playerId: 1 as ValidPlayerId, choice: LifeLostChoice.ABANDON },
          ],
        },
      });
      let hostElims = 0;
      let watcherElims = 0;
      host.bus.on(GAME_EVENT.PLAYER_ELIMINATED, () => hostElims++);
      watcher.bus.on(GAME_EVENT.PLAYER_ELIMINATED, () => watcherElims++);
      let stopped = false;
      for (let step = 0; step < 60_000; step++) {
        host.tick(1);
        watcher.tick(1);
        await pump();
        if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) {
          stopped = true;
          break;
        }
      }
      const rngOk = host.state.rng.getState() === watcher.state.rng.getState();
      const playersOk =
        JSON.stringify(snapshotPlayers(host)) ===
        JSON.stringify(snapshotPlayers(watcher));
      if (
        stopped &&
        hostElims > 0 &&
        hostElims === watcherElims &&
        rngOk &&
        playersOk
      ) {
        good.push(seed);
        console.log(`  ✓ seed=${seed} (elims=${hostElims})`);
      }
    } catch {
      // unrunnable seed — skip
    }
  }
  console.log(
    `\n${mode} r${rounds} full-parity seeds: [${good.join(", ")}]\n` +
      `Paste into TRIALS: { seed: ${good[0] ?? "?"}, mode: "${mode}", rounds: ${rounds} }`,
  );
}
