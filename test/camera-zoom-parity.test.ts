/**
 * Cross-peer parity with one peer on mobile auto-zoom.
 *
 * Pins `runTransition`'s LOCKSTEP INVARIANT (phase-machine.ts): the
 * transition mutate runs synchronously at the dispatch tick on every
 * peer, regardless of each peer's displayed camera. The historic bug
 * parked `executeTransition` behind `awaitCameraFlat`, which on a
 * zoomed touch peer waited ~40-90 sim ticks for the rendered viewport
 * to lerp back to fullmap while `simTick` and the lockstep action
 * drain kept running. That ran every transition mutate at a later
 * simTick on the zoomed peer than on a fullmap (desktop) peer, opening
 * (a) scheduled actions that drained pre-mutate on one peer and
 * post-mutate on the other, and (b) a persistent phase-clock offset
 * that made every subsequent wire-carried human action meet
 * differently-aged boards. Either way: player-state divergence — all
 * three seeds below desynced within 3 rounds.
 *
 * The other parity gates (network-vs-local, network-bidirectional) run
 * with the camera at fullmap on every peer and are structurally blind
 * to camera-coupled timing; the zoomed watcher here is what makes this
 * suite different.
 */

// scenario.ts MUST evaluate before network-setup.ts (see
// network-bidirectional.test.ts header for why).

import { createScenario } from "./scenario.ts";
import { assertEquals } from "@std/assert";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  createBidirectionalNetworkedPair,
  snapshotPlayers,
} from "./network-setup.ts";

const WIRE_DELAY_FRAMES = 5;
const SWEEP = [
  { seed: 1, mode: "classic" as const, rounds: 3 },
  { seed: 7, mode: "classic" as const, rounds: 3 },
  { seed: 42, mode: "classic" as const, rounds: 3 },
];

void createScenario;

for (const trial of SWEEP) {
  Deno.test(
    `zoomed-watcher parity (seed=${trial.seed} ${trial.mode} r${trial.rounds})`,
    async () => {
      const pair = await createBidirectionalNetworkedPair({
        seed: trial.seed,
        mode: trial.mode,
        rounds: trial.rounds,
        assistedSlotsHost: [0 as ValidPlayerId],
        assistedSlotsWatcher: [1 as ValidPlayerId],
        wireDelayFrames: WIRE_DELAY_FRAMES,
      });

      // The asymmetry under test: watcher is a touch-device peer whose
      // camera auto-zooms to its home zone each phase; host stays at
      // fullmap (desktop). Game state must not care.
      pair.watcher.camera.enableMobileZoom();

      let watcherZoomedFrames = 0;
      for (let step = 0; step < 60_000; step++) {
        pair.host.tick(1);
        pair.watcher.tick(1);
        await pair.pump();
        if (pair.watcher.camera.getViewport() !== undefined) {
          watcherZoomedFrames++;
        }
        if (
          pair.host.mode() === Mode.STOPPED &&
          pair.watcher.mode() === Mode.STOPPED
        ) {
          break;
        }
      }

      // Sanity: the watcher's camera must actually have been zoomed for a
      // meaningful stretch, otherwise this test isn't exercising anything.
      if (watcherZoomedFrames < 100) {
        throw new Error(
          `watcher camera never zoomed (zoomedFrames=${watcherZoomedFrames}) — repro precondition failed`,
        );
      }

      assertEquals(
        pair.host.mode(),
        Mode.STOPPED,
        `host did not finish (mode=${pair.host.mode()})`,
      );
      assertEquals(
        pair.watcher.mode(),
        Mode.STOPPED,
        `watcher did not finish (mode=${pair.watcher.mode()})`,
      );

      assertEquals(
        snapshotPlayers(pair.watcher),
        snapshotPlayers(pair.host),
        `zoomed-watcher parity seed=${trial.seed}: player state diverged`,
      );
    },
  );
}
