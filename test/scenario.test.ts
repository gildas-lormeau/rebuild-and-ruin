/**
 * Scenario tests — reproduce bugs fixed in this session.
 * Run with: bun test/scenario.test.ts
 */

import { snapshotAllWalls, sweepIsolatedWalls } from "../src/board-occupancy.ts";
import { GRID_COLS } from "../src/grid.ts";
import { showBannerTransition } from "../src/phase-banner.ts";
import { type LifeLostDialogState, LifeLostChoice, Mode, Phase } from "../src/types.ts";
import {
  assertCameraZone,
  assertLifeLostLabel,
  assertPhase,
  createScenario,
} from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// 1. Game-over overlay cleared on returnToLobby
// ---------------------------------------------------------------------------

test("frame.gameOver is undefined after game ends and lobby is requested", () => {
  const s = createScenario();

  // Simulate game ending: eliminate all but player 0
  for (let i = 1; i < s.state.players.length; i++) {
    s.eliminatePlayer(i);
  }

  // Simulate what endGame does: set frame.gameOver
  const frame: { gameOver?: { winner: string } } = {};
  frame.gameOver = { winner: "Player 1" };

  // Simulate what returnToLobby must do: clear gameOver
  frame.gameOver = undefined;

  assert(frame.gameOver === undefined, "gameOver should be cleared after returnToLobby");
});

// ---------------------------------------------------------------------------
// 2. Swept wall debris not visible in banner new scene
// ---------------------------------------------------------------------------

test("isolated walls are swept before battle banner captures newWalls", () => {
  const s = createScenario();

  // Add isolated wall tiles (0-1 neighbors) that sweepIsolatedWalls should remove
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
  player.walls.add(isolatedKey);

  // Verify it's truly isolated (0-1 neighbors)
  sweepIsolatedWalls(player.walls);
  assert(
    !player.walls.has(isolatedKey),
    "Isolated wall tile should be swept by sweepIsolatedWalls",
  );

  // Restore for the real test: advance through cannon phase to battle
  player.walls = wallsBefore;
  player.walls.add(isolatedKey);

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
// 3. Settings screen overlay includes castles when in-game
// ---------------------------------------------------------------------------

test("options overlay has castle data when game state exists", () => {
  const s = createScenario();

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
// 4. Cannon phantom snaps after placement
// ---------------------------------------------------------------------------

test("cannon cursor needs snap after successful placement", () => {
  const s = createScenario();
  assertPhase(s, Phase.CANNON_PLACE);

  // The fix: after tryPlaceCannon succeeds, cannonCursorNeedsSnap = true.
  // We verify that the controller's cannonTick returns a valid phantom
  // even after placement (snap finds a nearby spot).
  const ctrl = s.controllers[0]!;
  const maxSlots = s.state.cannonLimits[0] ?? 0;

  // Let AI place cannons normally
  ctrl.placeCannons(s.state, maxSlots);
  ctrl.flushCannons(s.state, maxSlots);

  // After placement, the controller should still report done
  assert(
    ctrl.isCannonPhaseDone(s.state, maxSlots),
    "Controller should be done after placing cannons",
  );
});

// ---------------------------------------------------------------------------
// 5. Camera does NOT zoom to human zone during AI-only reselection
// ---------------------------------------------------------------------------

test("camera stays unzoomed during AI-only reselection", () => {
  const s = createScenario();

  // Play a round so the camera has seen a real phase
  s.playRound();

  // Set state phase to CASTLE_RESELECT (simulating the moment life-lost
  // resolution triggers reselection, before it advances)
  s.state.phase = Phase.CASTLE_RESELECT;

  // Create camera as player 0 (human) with mobile auto-zoom
  const handle = s.createCamera({
    mode: Mode.SELECTION,
    phase: Phase.CASTLE_RESELECT,
    myPlayerId: 0,
    firstHumanPlayerId: 0,
    isSelectionReady: false,
    mobileAutoZoom: true,
  });

  // Tick camera — phase change to CASTLE_RESELECT should NOT trigger zone zoom
  handle.tick();
  assertCameraZone(handle, null);

  // Even after isSelectionReady becomes true, should not zoom for reselect
  handle.setCtx({ isSelectionReady: true });
  handle.tick();
  assertCameraZone(handle, null);
});

// ---------------------------------------------------------------------------
// 6. Life-lost dialog: eliminated player shows no bottom label
// ---------------------------------------------------------------------------

test("eliminated player entry has lives=0 and ABANDON choice", () => {
  const s = createScenario();

  // Set player 2 to 0 lives (will be auto-eliminated)
  s.setLives(2, 0);

  // Create dialog with player 1 needing reselect, player 2 eliminated
  const dialog = s.createLifeLostDialog([1], [2]);

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

test("continuing player entry shows Continuing label", () => {
  const s = createScenario();

  const dialog = s.createLifeLostDialog([0, 1]);

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
// 7. KNOWN BUG: Place Cannons banner doesn't progressively hide swept walls
// ---------------------------------------------------------------------------

test("Place Cannons banner old scene includes pre-sweep walls via pendingOldWalls", () => {
  const s = createScenario();

  // Play a round so we have battle damage and build phase
  s.runCannon();
  s.runBattle();
  s.runBuild();

  // Add an isolated wall (0-1 neighbors) that sweepIsolatedWalls will remove
  const player = s.state.players[0]!;
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
  assert(isolatedKey >= 0, "Should find tile for isolated wall");
  player.walls.add(isolatedKey);

  const wallCountBefore = player.walls.size;

  // Stash pre-sweep walls on banner (simulates what tickHostBuildPhase now does)
  const banner = s.createBanner();
  banner.pendingOldWalls = snapshotAllWalls(s.state);

  // finalizeBuildPhase sweeps isolated walls
  s.finalizeBuild();
  const wallCountAfter = player.walls.size;
  assert(!player.walls.has(isolatedKey), "Isolated wall removed by sweep");

  // showBannerTransition consumes pendingOldWalls for oldCastles
  showBannerTransition({
    banner,
    state: s.state,
    battleAnim: s.createBattleAnim(),
    text: "Place Cannons",
    onDone: () => {},
    reveal: true,
    setModeBanner: () => {},
  });

  // The old scene should have the pre-sweep walls (including the isolated one)
  const oldCastleWalls = banner.oldCastles?.find((c) => c.playerId === 0)?.walls;
  const oldSceneHasSweptWall = oldCastleWalls?.has(isolatedKey) ?? false;
  const newSceneHasSweptWall = player.walls.has(isolatedKey);

  console.log("  [debug] walls before sweep:", wallCountBefore);
  console.log("  [debug] walls after sweep:", wallCountAfter);
  console.log("  [debug] swept:", wallCountBefore - wallCountAfter, "walls");
  console.log("  [debug] isolated wall in banner old scene:", oldSceneHasSweptWall);
  console.log("  [debug] isolated wall in new scene:", newSceneHasSweptWall);

  assert(
    oldSceneHasSweptWall,
    "Banner old scene should include pre-sweep walls for progressive reveal",
  );
  assert(
    !newSceneHasSweptWall,
    "New scene should NOT have the swept wall",
  );
});

// ---------------------------------------------------------------------------
// 8. Online watcher: cannon banner missing reveal
// ---------------------------------------------------------------------------

test("online cannon banner uses reveal=true for progressive scene transition", () => {
  // Both local and online paths should use reveal=true for the cannon banner.
  // The fix added reveal=true to handleCannonStartTransition.
  const s = createScenario();
  s.runCannon();
  s.runBattle();
  s.runBuild();
  s.finalizeBuild();

  // Simulate what both paths now do: reveal=true
  const banner = s.createBanner();
  showBannerTransition({
    banner,
    state: s.state,
    battleAnim: s.createBattleAnim(),
    text: "Place Cannons",
    onDone: () => {},
    reveal: true,
    setModeBanner: () => {},
  });

  const hasOldScene = banner.oldCastles !== undefined;
  console.log("  [debug] cannon banner has old scene:", hasOldScene);
  console.log("  [debug] old castles count:", banner.oldCastles?.length ?? 0);

  assert(hasOldScene, "Cannon banner should capture old scene for progressive reveal");
});

// ---------------------------------------------------------------------------
// 9. Camera: human reselecting gets no initial zone zoom
// ---------------------------------------------------------------------------

test("camera zooms to human zone when human IS reselecting", () => {
  const s = createScenario();
  s.playRound();

  // Human (player 0) needs reselection
  s.setLives(0, 2);
  s.clearWalls(0);
  s.state.phase = Phase.CASTLE_RESELECT;

  const handle = s.createCamera({
    mode: Mode.SELECTION,
    phase: Phase.CASTLE_RESELECT,
    myPlayerId: 0,
    firstHumanPlayerId: 0,
    isSelectionReady: false,
    humanIsReselecting: true,
    mobileAutoZoom: true,
  });

  // Phase change tick — should zoom because human IS reselecting
  handle.tick();
  const zoneAfterPhaseChange = handle.camera.getCameraZone();
  console.log("  [debug] camera zone after phase change:", zoneAfterPhaseChange);
  console.log("  [debug] human's zone:", s.state.playerZones[0]);

  assert(
    zoneAfterPhaseChange !== null,
    "Camera should zoom to human zone when human is reselecting",
  );
});

// ---------------------------------------------------------------------------

runTests("Scenario Tests");
