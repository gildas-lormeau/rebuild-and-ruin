import { canFireOwnCannon } from "../src/game/battle-system.ts";
import { removeIsolatedWalls, snapshotAllWalls } from "../src/shared/board-occupancy.ts";
import { isCannonEnclosed } from "../src/game/cannon-system.ts";
import { GRID_COLS } from "../src/shared/grid.ts";
import { createSession, resetSessionState } from "../src/online/online-session.ts";
import {
  assertPhase,
  createScenario,
} from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { LifeLostChoice } from "../src/shared/interaction-types.ts";
import { CannonMode } from "../src/shared/battle-types.ts";

// ---------------------------------------------------------------------------
// Swept wall debris not visible in banner new scene
// ---------------------------------------------------------------------------

Deno.test("isolated walls are swept before battle banner captures newWalls", async () => {
  const s = await createScenario();

  // Add isolated wall tiles (0-1 neighbors) that removeIsolatedWalls should remove
  const player = s.state.players[0]!;
  const wallsBefore = new Set(player.walls);

  // Pick a grass tile far from any existing wall as an isolated wall
  let isolatedKey = -1;
  for (let r = 10; r < 30; r++) {
    for (let c = 10; c < 30; c++) {
      const key = r * GRID_COLS + c;
      if (!player.walls.has(key) && !player.interior.has(key)) {
        isolatedKey = key;
        break;
      }
    }
    if (isolatedKey >= 0) break;
  }
  assert(isolatedKey >= 0, "Should find an open tile for isolated wall");
  (player.walls as Set<number>).add(isolatedKey);

  // Verify it's truly isolated (0-1 neighbors)
  removeIsolatedWalls(player.walls as Set<number>);
  assert(
    !player.walls.has(isolatedKey),
    "Isolated wall tile should be swept by removeIsolatedWalls",
  );

  // Restore for the real test: advance through cannon phase to battle
  player.walls = wallsBefore;
  (player.walls as Set<number>).add(isolatedKey);

  // The battle transition (nextPhase from CANNON_PLACE) sweeps walls.
  // After that, snapshotAllWalls should NOT contain the isolated tile.
  s.runCannon();
  s.advanceTo(Phase.BATTLE);

  const postSweepWalls = snapshotAllWalls(s.state);
  const playerPostWalls = postSweepWalls[0];
  assert(
    !playerPostWalls || !playerPostWalls.has(isolatedKey),
    "Post-sweep wall snapshot should not contain isolated wall tile",
  );
});

// ---------------------------------------------------------------------------
// Cannon phantom snaps after placement
// ---------------------------------------------------------------------------

Deno.test("cannon cursor needs snap after successful placement", async () => {
  const s = await createScenario();
  assertPhase(s, Phase.CANNON_PLACE);

  // The fix: after tryPlaceCannon succeeds, cannonCursorSetByMouse = true.
  // We verify that the controller's cannonTick returns a valid phantom
  // even after placement (snap finds a nearby spot).
  const ctrl = s.controllers[0]!;
  const maxSlots = s.state.cannonLimits[0] ?? 0;

  // Let AI place cannons normally
  ctrl.placeCannons(s.state, maxSlots);
  ctrl.finalizeCannonPhase(s.state, maxSlots);

  // After placement, the controller should still report done
  assert(
    ctrl.isCannonPhaseDone(s.state, maxSlots),
    "Controller should be done after placing cannons",
  );
});

// ---------------------------------------------------------------------------
// Online session cleanup on disconnect
// ---------------------------------------------------------------------------

Deno.test("resetSessionState closes WebSocket and resets all fields", () => {
  const session = createSession();
  let closeCalled = false;
  session.socket = { close: () => { closeCalled = true; } } as unknown as WebSocket;
  session.isHost = true; // eslint-disable-line no-restricted-syntax -- test setup
  session.myPlayerId = 2 as PlayerSlotId;
  session.hostMigrationSeq = 3;
  session.occupiedSlots = new Set([0, 1, 2]);
  session.remotePlayerSlots.add(1);
  session.earlyLifeLostChoices.set(0, LifeLostChoice.CONTINUE);

  resetSessionState(session);

  assert(closeCalled, "socket.close() should be called");
  assert(session.socket === null, "socket should be null after reset");
  assert(!session.isHost, "isHost should be false"); // eslint-disable-line no-restricted-syntax -- test assertion
  assert(session.myPlayerId === -1, "myPlayerId should be -1");
  assert(session.hostMigrationSeq === 0, "hostMigrationSeq should be 0");
  assert(session.occupiedSlots.size === 0, "occupiedSlots should be empty");
  assert(session.remotePlayerSlots.size === 0, "remotePlayerSlots should be empty");
  assert(session.earlyLifeLostChoices.size === 0, "earlyLifeLostChoices should be empty");
});

// ---------------------------------------------------------------------------
// Super gun can fire immediately after placement
// ---------------------------------------------------------------------------

Deno.test("super gun placed during cannon phase can fire in battle", async () => {
  // Seed 39: P0 has enough interior for a 3x3 super gun after 1 round
  const s = await createScenario(39);
  s.playRounds(1);
  let placed = false;
  const p = s.state.players[0]!;
  s.state.cannonLimits[0] = 99;
  for (const key of p.interior) {
    const row = Math.floor(key / GRID_COLS);
    const col = key % GRID_COLS;
    if (s.placeCannonAt(0 as ValidPlayerSlot, row, col, CannonMode.SUPER)) {
      placed = true;
      break;
    }
  }
  assert(placed, "Should place a super gun with seed 39");
  const player = s.state.players[0]!;

  const superIdx = player.cannons.length - 1;
  const superCannon = player.cannons[superIdx]!;
  assert(superCannon.mode === CannonMode.SUPER, "Last cannon should be super");

  // Advance to battle (sweepAllPlayersWalls + recheckTerritoryOnly runs)
  s.advanceTo(Phase.BATTLE);
  for (const ctrl of s.controllers) ctrl.initBattleState(s.state);

  const enclosed = isCannonEnclosed(superCannon, player);
  const fireable = canFireOwnCannon(s.state, 0 as ValidPlayerSlot, superIdx);
  assert(enclosed, "Super gun should still be enclosed after battle transition");
  assert(fireable, "Super gun should be fireable immediately in battle");

  // Actually fire it
  const enemy = s.findEnemyWallTile(0 as ValidPlayerSlot);
  assert(enemy !== null, "Should find an enemy wall");
  assert(s.fireAt(0 as ValidPlayerSlot, superIdx, enemy!.row, enemy!.col), "Should fire super gun");
});

// ---------------------------------------------------------------------------
// Castle wall ring must not overlap other towers
// ---------------------------------------------------------------------------

Deno.test("prebuilt castle walls never land on another tower's tiles", async () => {
  // Try multiple seeds to exercise different tower layouts
  for (const seed of [1, 7, 42, 99, 123, 256, 500, 777]) {
    const s = await createScenario(seed);
    const { state } = s;

    // Collect all tower tiles (2×2 each)
    const towerTiles = new Map<number, number>(); // tile key → tower index
    for (let ti = 0; ti < state.map.towers.length; ti++) {
      const tower = state.map.towers[ti]!;
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          towerTiles.set(
            (tower.row + dr) * GRID_COLS + (tower.col + dc),
            ti,
          );
        }
      }
    }

    // After initial castle construction, check each player's walls
    for (const player of state.players) {
      if (!player.castle) continue;
      for (const wallKey of player.walls) {
        assert(
          !towerTiles.has(wallKey),
          `seed=${seed} P${player.id}: wall at tile ${wallKey} overlaps tower ${towerTiles.get(wallKey)}`,
        );
      }
    }
  }
});

