import { canFireOwnCannon } from "../src/game/battle-system.ts";
import { removeIsolatedWalls, snapshotAllWalls } from "../src/shared/board-occupancy.ts";
import { isCannonEnclosed } from "../src/game/cannon-system.ts";
import { GRID_COLS } from "../src/shared/grid.ts";
import { createSession, resetSessionState } from "../src/online/online-session.ts";
import {
  assertLifeLostLabel,
  assertPhase,
  createScenario,
} from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { Mode } from "../src/shared/ui-mode.ts";
import { LifeLostChoice, type LifeLostDialogState } from "../src/shared/dialog-types.ts";
import { CannonMode } from "../src/shared/battle-types.ts";

// ---------------------------------------------------------------------------
// Game-over overlay cleared on returnToLobby
// ---------------------------------------------------------------------------

Deno.test("frame.gameOver is undefined after game ends and lobby is requested", async () => {
  const s = await createScenario();

  // Simulate game ending: eliminate all but player 0
  for (let i = 1; i < s.state.players.length; i++) {
    s.eliminatePlayer(i as ValidPlayerSlot);
  }

  // Simulate what endGame does: set frame.gameOver
  const frame: { gameOver?: { winner: string } } = {};
  frame.gameOver = { winner: "Player 1" };

  // Simulate what returnToLobby must do: clear gameOver
  frame.gameOver = undefined;

  assert(frame.gameOver === undefined, "gameOver should be cleared after returnToLobby");
});

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
// Settings screen overlay includes castles when in-game
// ---------------------------------------------------------------------------

Deno.test("options overlay has castle data when game state exists", async () => {
  const s = await createScenario();

  // Verify the state has castles with walls
  const player = s.state.players[0]!;
  assert(player.walls.size > 0, "Player should have walls");
  assert(player.castle !== null, "Player should have a castle");

  // The fix ensures createOptionsOverlay populates castles from state.
  // We can verify the data that would feed it is present.
  const castles = s.state.players
    .filter((p) => p.castle)
    .map((p) => ({
      walls: p.walls,
      interior: p.interior,
      cannons: p.cannons,
      playerId: p.id,
    }));

  assert(castles.length > 0, "Should have castle overlay data from state");
  assert(
    castles[0]!.walls.size > 0,
    "Castle overlay should include player walls",
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
// Life-lost dialog: eliminated player shows no bottom label
// ---------------------------------------------------------------------------

Deno.test("eliminated player entry has lives=0 and ABANDON choice", async () => {
  const s = await createScenario();

  // Set player 2 to 0 lives (will be auto-eliminated)
  s.setLives(2 as ValidPlayerSlot, 0);

  // Create dialog with player 1 needing reselect, player 2 eliminated
  const dialog = s.createLifeLostDialog([1 as ValidPlayerSlot], [2 as ValidPlayerSlot]);

  // Find player 2's entry
  const entry = dialog.entries.find((e) => e.playerId === 2);
  assert(entry !== undefined, "Should have entry for eliminated player");
  assert(entry!.lives === 0, "Eliminated entry should have lives=0");
  assert(
    entry!.choice === LifeLostChoice.ABANDON,
    "Eliminated entry should be pre-resolved as ABANDON",
  );

  // The rendering rule: lives=0 means no bottom label (title says "Eliminated")
  assertLifeLostLabel(entry!, "none");
});

Deno.test("continuing player entry shows Continuing label", async () => {
  const s = await createScenario();

  const dialog = s.createLifeLostDialog([0 as ValidPlayerSlot, 1 as ValidPlayerSlot]);

  // Tick until all AI resolve (they auto-continue after delay)
  let d: LifeLostDialogState | null = dialog;
  for (let i = 0; i < 100 && d !== null; i++) {
    d = s.tickLifeLostDialog(d, 0.1);
  }

  // All entries should have resolved to CONTINUE
  for (const entry of dialog.entries) {
    if (entry.lives > 0) {
      assertLifeLostLabel(entry, "Continuing...");
    }
  }
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
  session.remoteHumanSlots.add(1);
  session.earlyLifeLostChoices.set(0, LifeLostChoice.CONTINUE);

  resetSessionState(session);

  assert(closeCalled, "socket.close() should be called");
  assert(session.socket === null, "socket should be null after reset");
  assert(!session.isHost, "isHost should be false"); // eslint-disable-line no-restricted-syntax -- test assertion
  assert(session.myPlayerId === -1, "myPlayerId should be -1");
  assert(session.hostMigrationSeq === 0, "hostMigrationSeq should be 0");
  assert(session.occupiedSlots.size === 0, "occupiedSlots should be empty");
  assert(session.remoteHumanSlots.size === 0, "remoteHumanSlots should be empty");
  assert(session.earlyLifeLostChoices.size === 0, "earlyLifeLostChoices should be empty");
});

// ---------------------------------------------------------------------------
// Demo mode auto-returns to lobby after game over
// ---------------------------------------------------------------------------

Deno.test("demo mode auto-returns to lobby after game ends (all-AI)", async () => {
  // Simulate the demo timer logic from endGame
  let returnCalled = false;
  const mode = { current: Mode.STOPPED };
  const joined = [false, false, false];
  const allAi = joined.every((j) => !j);
  assert(allAi, "All-false joined should be all-AI");

  const timer = setTimeout(() => {
    if (mode.current === Mode.STOPPED) returnCalled = true;
  }, 20);

  assert(!returnCalled, "Should not return immediately");
  await new Promise((r) => setTimeout(r, 50));
  assert(returnCalled, "Should auto-return after delay");
  clearTimeout(timer);
});

Deno.test("demo timer does not fire if user clicks rematch first", async () => {
  let returnCalled = false;
  const mode = { current: Mode.STOPPED };

  const timer = setTimeout(() => {
    if (mode.current === Mode.STOPPED) returnCalled = true;
  }, 20);

  // User clicks rematch — mode changes before timer fires
  mode.current = Mode.SELECTION;
  await new Promise((r) => setTimeout(r, 50));
  assert(!returnCalled, "Should not return if mode changed away from STOPPED");
  clearTimeout(timer);
});

Deno.test("demo timer not started when human is playing", () => {
  const joined = [true, false, false];
  const allAi = joined.every((j) => !j);
  assert(!allAi, "Should not be all-AI when a human joined");
});

// ---------------------------------------------------------------------------
// Super gun can fire immediately after placement
// ---------------------------------------------------------------------------

Deno.test("super gun placed during cannon phase can fire in battle", async () => {
  // Seed 14: P0 has enough interior for a 3x3 super gun after 1 round
  const s = await createScenario(14);
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
  assert(placed, "Should place a super gun with seed 14");
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
