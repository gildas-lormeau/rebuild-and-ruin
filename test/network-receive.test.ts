/**
 * Receive-side network seam smoke tests.
 *
 * Verifies that `sc.deliverMessage(...)` actually drives the production
 * `handleServerMessage` dispatcher (in `src/online/online-runtime-deps.ts`)
 * end-to-end. The wrapper lives in `test/online-headless.ts`; if the
 * dispatcher gets unwired or the seam regresses, these tests fail at the
 * first assertion.
 *
 * The two tests cover the easiest non-trivial dispatch path:
 *   1. AIM_UPDATE — pure watcher write, no game-state mutation, no AI race.
 *   2. OPPONENT_TOWER_SELECTED — selection mutation. The configured
 *      `remotePlayerSlots` keeps local AI off the slot so the dispatcher's
 *      write isn't immediately overwritten.
 */

import { assert, assertEquals } from "@std/assert";

import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { MESSAGE } from "../src/protocol/protocol.ts";
import { createOnlineHarness, createOnlineScenario } from "./online-headless.ts";

// Branded slot for the "remote" player driven by the dispatched messages.
// `as ValidPlayerSlot` is acceptable here because the value is locally
// constructed for the test (case 3 in the player-slot.ts brand notes:
// "value just checked locally").
const REMOTE_SLOT = 1 as ValidPlayerSlot;

Deno.test("aimUpdate delivery writes to remote crosshairs via dispatcher", async () => {
  // Use `createOnlineHarness` so the test can read the watcher state
  // directly — verifying the dispatcher *actually* wrote to the configured
  // client, not just that the call didn't throw.
  const harness = await createOnlineHarness({ seed: 42 });
  using sc = harness.scenario;
  // The game starts in CASTLE_SELECT immediately after createOnlineScenario
  // (autoStartGame = true). The PHASE_START event fired during startGame()
  // before we got the bus reference, so we can't waitForPhase — we just
  // verify the phase directly.
  assertEquals(sc.state.phase, Phase.CASTLE_SELECT);

  await sc.deliverMessage({
    type: MESSAGE.AIM_UPDATE,
    playerId: REMOTE_SLOT,
    x: 123,
    y: 456,
  });

  // The dispatcher routes AIM_UPDATE → handleAimUpdate → writes to
  // `watcher.remoteCrosshairs`. Read back from the test client to confirm.
  const crosshair = harness.client.ctx.watcher.remoteCrosshairs.get(REMOTE_SLOT);
  assert(crosshair !== undefined, "remote crosshair for player 1 should be set");
  assertEquals(crosshair.x, 123);
  assertEquals(crosshair.y, 456);
});

Deno.test("opponentTowerSelected delivery highlights tower for remote player", async () => {
  using sc = await createOnlineScenario({
    seed: 42,
    remotePlayerSlots: new Set([REMOTE_SLOT]),
  });
  assertEquals(sc.state.phase, Phase.CASTLE_SELECT);

  // Pick the first tower in the remote player's zone — guaranteed to exist
  // because the map generator places one tower per player zone before any
  // others.
  const remoteZone = sc.state.playerZones[REMOTE_SLOT];
  assert(remoteZone !== undefined, "remote player should have a zone assigned");
  const towerIdx = sc.state.map.towers.findIndex(
    (tower) => tower.zone === remoteZone,
  );
  assert(towerIdx >= 0, "remote player's zone should contain at least one tower");

  await sc.deliverMessage({
    type: MESSAGE.OPPONENT_TOWER_SELECTED,
    playerId: REMOTE_SLOT,
    towerIdx,
    confirmed: false,
  });

  // The dispatcher's handleTowerSelected calls highlightTowerSelection
  // → selectPlayerTower, which sets `player.homeTower`. With
  // `remotePlayerSlots` including the remote slot, the runtime's local AI
  // is suppressed for that slot, so the home tower assignment isn't
  // immediately overwritten by an AI selection on the next tick.
  const player = sc.state.players[REMOTE_SLOT];
  assert(player !== undefined, "player 1 should exist");
  const expectedTower = sc.state.map.towers[towerIdx];
  assert(expectedTower !== undefined, "tower at idx should exist");
  assertEquals(
    player.homeTower?.row,
    expectedTower.row,
    "dispatcher should have set player 1's home tower row",
  );
  assertEquals(
    player.homeTower?.col,
    expectedTower.col,
    "dispatcher should have set player 1's home tower col",
  );
});
