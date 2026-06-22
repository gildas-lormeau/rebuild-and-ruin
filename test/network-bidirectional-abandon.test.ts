/**
 * Bidirectional parity for the human ABANDON / elimination path.
 *
 * The AI always picks CONTINUE on a life-lost dialog, so no AI-played
 * scenario ever reaches the human ABANDON → elimination path — it's
 * structurally unreachable from a seed alone. `testHooks.lifeLostChoices`
 * forces a slot's decision, letting us drive it deterministically and assert
 * the two peers stay in lockstep when a human abandons mid-match (the choice
 * crosses the wire as `lifeLostChoice`; the elimination must land on the same
 * logical tick on both peers).
 *
 * Companion to network-bidirectional.test.ts. Seeds were chosen (via
 * tmp probing) so that a forced-abandon slot actually reaches a life-loss
 * within the round budget — otherwise the hook never fires and the test
 * would pass vacuously. `assertAbandonFired` guards against that.
 *
 * scenario.ts MUST evaluate before network-setup.ts (DOM-shim order) — see
 * the note in network-bidirectional.test.ts.
 */

import { createScenario as _forceScenarioFirst } from "./scenario.ts";
import { assert, assertEquals } from "@std/assert";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { LifeLostChoice } from "../src/shared/core/dialog-state.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  createBidirectionalNetworkedPair,
  type PlayerParitySnapshot,
  snapshotPlayers,
} from "./network-setup.ts";

const WIRE_DELAY_FRAMES = 5;
// Seeds where slot 0 or 1 reaches a life-loss within the round budget, so the
// forced ABANDON actually fires (verified empirically via tmp probing against
// THIS bidirectional harness — an all-AI probe diverges and gives false hits).
// These are dynamics-tuned fixtures: any change to battle/grunt dynamics shifts
// which towers die and drifts the seeds. Last re-probed after the grunt
// movement model changed (directional inertia + the stick-vs-switch rule: a
// grunt whose heading is grunt-blocked piles rather than routing around),
// which shifted grunt paths → tower-kill outcomes; prior seeds stopped firing.
const TRIALS: {
  readonly seed: number;
  readonly mode: "classic" | "modern";
  readonly rounds: number;
}[] = [
  { seed: 9, mode: "classic", rounds: 5 },
  { seed: 11, mode: "classic", rounds: 8 },
  { seed: 1, mode: "modern", rounds: 8 },
];

void _forceScenarioFirst;

for (const trial of TRIALS) {
  Deno.test(
    `bidirectional 2H+1AI ABANDON parity (seed=${trial.seed} ${trial.mode} r${trial.rounds})`,
    async () => {
      const pair = await createBidirectionalNetworkedPair({
        seed: trial.seed,
        mode: trial.mode,
        rounds: trial.rounds,
        assistedSlotsHost: [0 as ValidPlayerId],
        assistedSlotsWatcher: [1 as ValidPlayerId],
        wireDelayFrames: WIRE_DELAY_FRAMES,
        testHooks: {
          lifeLostChoices: [
            { playerId: 0 as ValidPlayerId, choice: LifeLostChoice.ABANDON },
            { playerId: 1 as ValidPlayerId, choice: LifeLostChoice.ABANDON },
          ],
        },
      });
      const { host, watcher, pump } = pair;

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
      assert(stopped, "bidirectional run reached game-over");

      // The forced-abandon path must have actually been exercised (a human
      // slot was eliminated), and identically on both peers.
      assert(
        hostElims > 0,
        `forced ABANDON never produced an elimination (seed=${trial.seed})`,
      );
      assertEquals(
        hostElims,
        watcherElims,
        "elimination count diverged between peers",
      );

      // Keystone parity: identical RNG cursor ⇒ identical draw sequence.
      assertEquals(
        host.state.rng.getState(),
        watcher.state.rng.getState(),
        `RNG cursor diverged (seed=${trial.seed} ${trial.mode})`,
      );

      assertPlayersConverge(
        snapshotPlayers(watcher),
        snapshotPlayers(host),
        `2H+1AI ABANDON seed=${trial.seed} ${trial.mode}`,
      );
    },
  );
}

function assertPlayersConverge(
  watcher: readonly PlayerParitySnapshot[],
  host: readonly PlayerParitySnapshot[],
  label: string,
): void {
  assertEquals(watcher.length, host.length, `${label}: player count diverged`);
  for (let i = 0; i < host.length; i++) {
    assertEquals(watcher[i], host[i], `${label}: player ${i} state diverged`);
  }
}
