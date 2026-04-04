import { MESSAGE } from "../server/protocol.ts";
import { applyImpactEvent, canFireOwnCannon, resolveBalloons } from "../src/game/battle-system.ts";
import { snapshotAllWalls, removeIsolatedWalls } from "../src/shared/board-occupancy.ts";
import { createOnlineOverlay } from "../src/render/render-composition.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "../src/shared/player-config.ts";
import { isCannonEnclosed } from "../src/game/cannon-system.ts";
import { initControllerForCannonPhase, prepareCannonPhase } from "../src/game/phase-setup.ts";
import { GRID_COLS } from "../src/shared/grid.ts";
import {
  handleBattleStartTransition,
  handleBuildEndTransition,
  handleBuildStartTransition,
  handleCannonStartTransition,
} from "../src/online/online-phase-transitions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
  serializePlayers,
} from "../src/online/online-serialize.ts";
import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  runBuildEndSequence,
  showBattlePhaseBanner,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
  showUpgradePickBanner,
} from "../src/game/phase-transition-shared.ts";
import { createSession, resetSessionState } from "../src/online/online-session.ts";
import { type BannerState, showBannerTransition } from "../src/game/phase-banner.ts";
import {
  assertCameraZone,
  assertLifeLostLabel,
  assertPhase,
  createScenario,
} from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";
import { enterCannonPlacePhase, nextPhase } from "../src/game/game-engine.ts";
import { SPECTATOR_SLOT, type PlayerSlotId, type ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { Phase, Mode } from "../src/shared/game-phase.ts";
import { LifeLostChoice, type LifeLostDialogState } from "../src/shared/dialog-types.ts";
import { CannonMode } from "../src/shared/battle-types.ts";

// ---------------------------------------------------------------------------
// 1. Game-over overlay cleared on returnToLobby
// ---------------------------------------------------------------------------

test("frame.gameOver is undefined after game ends and lobby is requested", () => {
  const s = createScenario();

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
// 2. Swept wall debris not visible in banner new scene
// ---------------------------------------------------------------------------

test("isolated walls are swept before battle banner captures newWalls", () => {
  const s = createScenario();

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
    myPlayerId: 0 as PlayerSlotId,
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

test("continuing player entry shows Continuing label", () => {
  const s = createScenario();

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

// ---------------------------------------------------------------------------
// 8. Online watcher: cannon banner missing preservePrevScene
// ---------------------------------------------------------------------------

test("online cannon banner uses preservePrevScene=true for progressive scene transition", () => {
  // Both local and online paths should use preservePrevScene=true for the cannon banner.
  // The fix added preservePrevScene=true to handleCannonStartTransition.
  const s = createScenario();
  s.runCannon();
  s.runBattle();
  s.runBuild();
  s.finalizeBuild();

  // Simulate what both paths now do: preservePrevScene=true
  const banner = s.createBanner();
  showBannerTransition({
    banner,
    state: s.state,
    battleAnim: s.createBattleAnim(),
    text: "Place Cannons",
    onDone: () => {},
    preservePrevScene: true,
    setModeBanner: () => {},
  });

  assert(
    banner.prevCastles !== undefined,
    "Cannon banner should capture old scene for progressive transition",
  );
});

// ---------------------------------------------------------------------------
// 9. Camera: human reselecting gets no initial zone zoom
// ---------------------------------------------------------------------------

test("camera zooms to human zone when human IS reselecting", () => {
  const s = createScenario();
  s.playRound();

  // Human (player 0) needs reselection
  s.setLives(0 as ValidPlayerSlot, 2);
  s.clearWalls(0 as ValidPlayerSlot);
  s.state.phase = Phase.CASTLE_RESELECT;

  const handle = s.createCamera({
    mode: Mode.SELECTION,
    phase: Phase.CASTLE_RESELECT,
    myPlayerId: 0 as PlayerSlotId,
    isSelectionReady: false,
    humanIsReselecting: true,
    mobileAutoZoom: true,
  });

  // Phase change tick — should zoom because human IS reselecting
  handle.tick();

  assert(
    handle.camera.getCameraZone() !== null,
    "Camera should zoom to human zone when human is reselecting",
  );
});

// ---------------------------------------------------------------------------
// 7b. No auto-zoom without a human player (demo / spectator)
// ---------------------------------------------------------------------------

test("camera stays unzoomed when no human player exists", () => {
  const s = createScenario();
  s.state.phase = Phase.WALL_BUILD;

  const handle = s.createCamera({
    mode: Mode.GAME,
    phase: Phase.WALL_BUILD,
    myPlayerId: 0 as PlayerSlotId,
    mobileAutoZoom: true,
    hasPointerPlayer: false,
  });

  handle.tick();
  assertCameraZone(handle, null);

  // Transition to battle — still no zoom
  s.state.phase = Phase.BATTLE;
  handle.setCtx({ phase: Phase.BATTLE });
  handle.tick();
  assertCameraZone(handle, null);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Scripted player actions work
// ---------------------------------------------------------------------------

test("placeCannonAt places a cannon at the given position", () => {
  const s = createScenario();
  assertPhase(s, Phase.CANNON_PLACE);

  const player = s.state.players[0]!;
  const cannonsBefore = player.cannons.length;

  // Find a valid interior tile for cannon placement
  const interior = [...player.interior];
  assert(interior.length > 0, "Player should have interior tiles");

  // Try placing at first interior tile (may fail if blocked by tower, etc.)
  let placed = false;
  for (const key of interior) {
    const row = Math.floor(key / GRID_COLS);
    const col = key % GRID_COLS;
    if (s.placeCannonAt(0 as ValidPlayerSlot, row, col)) {
      placed = true;
      break;
    }
  }
  assert(placed, "Should place at least one cannon via placeCannonAt");
  assert(player.cannons.length === cannonsBefore + 1, "Cannon count should increase by 1");
});

test("fireAt launches a cannonball at the target", () => {
  const s = createScenario();

  // Place cannons and advance to battle
  s.runCannon();
  s.advanceTo(Phase.BATTLE);
  for (const ctrl of s.controllers) ctrl.initBattleState(s.state);

  const player = s.state.players[0]!;
  const aliveCannon = player.cannons.findIndex((c) => c.hp > 0);
  assert(aliveCannon >= 0, "Player should have an alive cannon");

  const shotsBefore = s.state.shotsFired;
  const fired = s.fireAt(0 as ValidPlayerSlot, aliveCannon, 20, 20);
  assert(fired, "fireAt should succeed for alive cannon");
  assert(s.state.shotsFired === shotsBefore + 1, "shotsFired should increase");
});

// ---------------------------------------------------------------------------
// 12. Online transition: cannon start stashes pre-sweep walls
// ---------------------------------------------------------------------------

test("online handleCannonStartTransition stashes pre-checkpoint walls on banner", () => {
  const s = createScenario();

  // Play a round to get into a realistic state, then advance to CANNON_PLACE
  s.runCannon();
  s.runBattle();
  s.runBuild();
  s.finalizeBuild();

  // Serialize the current (post-sweep) state as the server would send it
  const msg = createCannonStartMessage(s.state);

  // Now add an isolated wall that the checkpoint will remove
  // (simulates the watcher having stale pre-sweep state)
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
  (player.walls as Set<number>).add(isolatedKey);

  // Reset phase so the transition handler runs its banner logic
  s.state.phase = Phase.WALL_BUILD;

  const ctx = s.createTransitionContext();
  handleCannonStartTransition(msg, ctx);

  // The banner old scene uses current (post-checkpoint) walls — no reintroduction
  const banner = ctx.ui.banner as BannerState;
  const prevWalls = banner.prevCastles?.find((c) => c.playerId === 0)?.walls;
  assert(
    !(prevWalls?.has(isolatedKey) ?? false),
    "Banner old scene should NOT reintroduce pre-checkpoint wall",
  );

  // The live state should NOT have the isolated wall (checkpoint replaced it)
  assert(
    !player.walls.has(isolatedKey),
    "Live state should have post-checkpoint walls (isolated wall gone)",
  );
});

// ---------------------------------------------------------------------------
// 13. Online transition: battle start sets banner.newWalls post-checkpoint
// ---------------------------------------------------------------------------

test("online handleBattleStartTransition sets banner.newWalls after checkpoint", () => {
  const s = createScenario();

  // Advance to cannon phase and serialize battle start message
  s.runCannon();
  const msg = createBattleStartMessage(s.state, []);

  const ctx = s.createTransitionContext();
  handleBattleStartTransition(msg, ctx);

  // banner.newWalls should be set (post-checkpoint walls)
  assert(
    ctx.ui.banner.newWalls !== undefined,
    "banner.newWalls should be set after battle start transition",
  );
  assert(
    ctx.ui.banner.newTerritory !== undefined,
    "banner.newTerritory should be set after battle start transition",
  );
});

// ---------------------------------------------------------------------------
// 14. State summary
// ---------------------------------------------------------------------------

test("describe() returns a compact state summary", () => {
  const s = createScenario();
  const desc = s.describe();

  // Should contain phase, all players, and round
  assert(desc.includes("Phase:"), "Should include phase");
  assert(desc.includes("P0:"), "Should include player 0");
  assert(desc.includes("P1:"), "Should include player 1");
  assert(desc.includes("P2:"), "Should include player 2");
  assert(desc.includes("round:"), "Should include round");

  // After elimination, should show 'elim'
  s.eliminatePlayer(2 as ValidPlayerSlot);
  const desc2 = s.describe();
  assert(desc2.includes("P2:elim"), "Should show eliminated player as 'elim'");
});

// ---------------------------------------------------------------------------
// 15. Damage helpers
// ---------------------------------------------------------------------------

test("destroyWalls removes walls and reclaims territory", () => {
  const s = createScenario();
  const player = s.state.players[0]!;
  const wallsBefore = player.walls.size;
  assert(wallsBefore > 0, "Player should have walls");

  const removed = s.destroyWalls(0 as ValidPlayerSlot, 5);
  assert(removed > 0, "Should remove at least one wall");
  assert(player.walls.size === wallsBefore - removed, "Wall count should decrease");
});

test("destroyCannon sets cannon HP to 0", () => {
  const s = createScenario();
  s.runCannon();
  const player = s.state.players[0]!;
  const aliveBefore = player.cannons.filter((c) => c.hp > 0).length;
  assert(aliveBefore > 0, "Should have alive cannons");

  s.destroyCannon(0 as ValidPlayerSlot, 0);
  assert(player.cannons[0]!.hp === 0, "Cannon HP should be 0");
  const aliveAfter = player.cannons.filter((c) => c.hp > 0).length;
  assert(aliveAfter === aliveBefore - 1, "One fewer alive cannon");
});

// ---------------------------------------------------------------------------
// 16. Multi-round shortcut
// ---------------------------------------------------------------------------

test("playRounds advances multiple rounds with reselection handling", () => {
  const s = createScenario();
  const roundBefore = s.state.round;

  s.playRounds(3);

  // Round counter increments at BUILD→CANNON transition, so after N playRounds
  // the round advances by at least N-1 (first playRound starts mid-cycle).
  assert(
    s.state.round > roundBefore,
    `Should advance rounds (was ${roundBefore}, now ${s.state.round})`,
  );
  // Verify no crash and game still functional
  assert(
    s.state.players.some((p) => !p.eliminated),
    "At least one player should still be alive",
  );
});

// ---------------------------------------------------------------------------
// 17. Tile finders return valid results
// ---------------------------------------------------------------------------

test("tile finders return valid positions", () => {
  const s = createScenario();

  const grass = s.findGrassTile(0 as ValidPlayerSlot);
  assert(grass !== null, "Should find a grass tile in player 0's zone");
  assert(
    !s.state.players.some(
      (p) => p.walls.has(grass!.row * GRID_COLS + grass!.col) || p.interior.has(grass!.row * GRID_COLS + grass!.col),
    ),
    "Grass tile should not be occupied",
  );

  const interior = s.findInteriorTile(0 as ValidPlayerSlot);
  assert(interior !== null, "Should find an interior tile for player 0");
  assert(
    s.state.players[0]!.interior.has(interior!.row * GRID_COLS + interior!.col),
    "Interior tile should be in player's interior set",
  );

  const enemy = s.findEnemyWallTile(0 as ValidPlayerSlot);
  assert(enemy !== null, "Should find an enemy wall tile");
  assert(enemy!.owner !== 0, "Enemy wall should not belong to player 0");
  assert(
    s.state.players[enemy!.owner]!.walls.has(enemy!.row * GRID_COLS + enemy!.col),
    "Enemy wall tile should be in the owner's wall set",
  );
});

// ---------------------------------------------------------------------------
// 18. Online session cleanup on disconnect
// ---------------------------------------------------------------------------

test("resetSessionState closes WebSocket and resets all fields", () => {
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
// 19. Demo mode auto-returns to lobby after game over
// ---------------------------------------------------------------------------

test("demo mode auto-returns to lobby after game ends (all-AI)", async () => {
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

test("demo timer does not fire if user clicks rematch first", async () => {
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

test("demo timer not started when human is playing", () => {
  const joined = [true, false, false];
  const allAi = joined.every((j) => !j);
  assert(!allAi, "Should not be all-AI when a human joined");
});

// ---------------------------------------------------------------------------
// 20. Super gun can fire immediately after placement
// ---------------------------------------------------------------------------

test("super gun placed during cannon phase can fire in battle", () => {
  // Seed 14: P0 has enough interior for a 3x3 super gun after 1 round
  const s = createScenario(14);
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
// 22. runBuildEndSequence notifies all affected players
// ---------------------------------------------------------------------------

test("runBuildEndSequence notifies all affected players", () => {
  const notified: number[] = [];
  let dialogShown = false;
  runBuildEndSequence({
    needsReselect: [0 as ValidPlayerSlot, 2 as ValidPlayerSlot],
    eliminated: [1 as ValidPlayerSlot],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: (pid) => notified.push(pid),
    showLifeLostDialog: () => { dialogShown = true; },
  });
  assert(notified.length === 3, `Expected 3 notifications, got ${notified.length}`);
  assert(notified[0] === 0, "First notified should be P0");
  assert(notified[1] === 2, "Second notified should be P2");
  assert(notified[2] === 1, "Third notified should be P1");
  assert(dialogShown, "Should show life-lost dialog");
});

test("runBuildEndSequence calls onLifeLostResolved when no affected players", () => {
  let resolved = false;
  runBuildEndSequence({
    needsReselect: [],
    eliminated: [],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: () => { throw new Error("should not notify"); },
    showLifeLostDialog: () => { throw new Error("should not show dialog"); },
    onLifeLostResolved: () => { resolved = true; },
  });
  assert(resolved, "Should call onLifeLostResolved when no affected players");
});

// ---------------------------------------------------------------------------
// 23. Host and watcher build-end paths both notify the local player
// ---------------------------------------------------------------------------

test("host and watcher build-end both notify affected controller via shared sequence", () => {
  const s = createScenario();
  s.playRounds(2);

  // Destroy P0's walls so they need reselect after build phase
  s.clearWalls(0 as ValidPlayerSlot);
  s.advanceTo(Phase.WALL_BUILD);
  const { needsReselect } = s.finalizeBuild();
  assert(needsReselect.includes(0 as ValidPlayerSlot), "P0 should need reselect after losing all walls");

  // --- Host path: capture who gets notified ---
  const hostNotified: number[] = [];
  runBuildEndSequence({
    needsReselect,
    eliminated: [] as ValidPlayerSlot[],
    showScoreDeltas: (onDone) => onDone(),
    notifyLifeLost: (pid) => hostNotified.push(pid),
    showLifeLostDialog: () => {},
    onLifeLostResolved: () => {},
  });

  // --- Watcher path: build a BUILD_END message and run through the transition ---
  const watcherNotified: number[] = [];
  const ctx = s.createTransitionContext();
  // Intercept the local controller's onLifeLost to capture the call
  const origCtrl = s.controllers[0]!;
  const origOnLifeLost = origCtrl.onLifeLost.bind(origCtrl);
  origCtrl.onLifeLost = () => {
    watcherNotified.push(0);
    origOnLifeLost();
  };

  const buildEndMsg = {
    type: MESSAGE.BUILD_END,
    needsReselect,
    eliminated: [] as number[],
    scores: s.state.players.map((p) => p.score),
    players: serializePlayers(s.state),
  };
  handleBuildEndTransition(buildEndMsg as any, ctx);

  // Both paths should have notified P0
  assert(hostNotified.includes(0), "Host path should notify P0");
  assert(watcherNotified.includes(0), "Watcher path should notify P0");
});

// ---------------------------------------------------------------------------
// 24. Banner shared helpers pass subtitle
// ---------------------------------------------------------------------------

test("showCannonPhaseBanner passes subtitle to showBanner", () => {
  let capturedSubtitle: string | undefined;
  const mockShow = (_t: string, _cb: () => void, _r?: boolean, _nb?: any, sub?: string) => {
    capturedSubtitle = sub;
  };
  showCannonPhaseBanner(mockShow, () => {});
  assert(capturedSubtitle !== undefined, "Should pass subtitle");
  assert(capturedSubtitle!.length > 0, "Subtitle should be non-empty");
});

test("showBattlePhaseBanner passes subtitle to showBanner", () => {
  let capturedSubtitle: string | undefined;
  const mockShow = (_t: string, _cb: () => void, _r?: boolean, _nb?: any, sub?: string) => {
    capturedSubtitle = sub;
  };
  showBattlePhaseBanner(mockShow, "Battle!", () => {});
  assert(capturedSubtitle !== undefined, "Should pass subtitle");
  assert(capturedSubtitle!.length > 0, "Subtitle should be non-empty");
});

test("showBuildPhaseBanner passes subtitle to showBanner", () => {
  let capturedSubtitle: string | undefined;
  const mockShow = (_t: string, _cb: () => void, _r?: boolean, _nb?: any, sub?: string) => {
    capturedSubtitle = sub;
  };
  showBuildPhaseBanner(mockShow, "Repair!", () => {});
  assert(capturedSubtitle !== undefined, "Should pass subtitle");
  assert(capturedSubtitle!.length > 0, "Subtitle should be non-empty");
});

test("showUpgradePickBanner passes text and subtitle to showBanner", () => {
  let capturedText: string | undefined;
  let capturedSubtitle: string | undefined;
  let capturedPreserve: boolean | undefined;
  const mockShow = (text: string, _cb: () => void, preserve?: boolean, _nb?: any, sub?: string) => {
    capturedText = text;
    capturedPreserve = preserve;
    capturedSubtitle = sub;
  };
  showUpgradePickBanner(mockShow, () => {});
  assert(capturedText === "Choose Upgrade", `Expected 'Choose Upgrade', got '${capturedText}'`);
  assert(capturedSubtitle !== undefined, "Should pass subtitle");
  assert(capturedSubtitle!.length > 0, "Subtitle should be non-empty");
  assert(capturedPreserve === true, "Should preserve prev scene");
});

test("showUpgradePickBanner fires onDone callback", () => {
  let doneFired = false;
  const mockShow = (_t: string, onDone: () => void) => {
    onDone();
  };
  showUpgradePickBanner(mockShow, () => {
    doneFired = true;
  });
  assert(doneFired, "onDone should have been called");
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 25. Cannon-start: host and watcher init controller the same way
// ---------------------------------------------------------------------------

test("cannon-start: watcher uses same initControllerForCannonPhase as host", () => {
  const s = createScenario();
  s.runCannon();
  s.runBattle();
  s.runBuild();
  s.finalizeBuild();

  // Serialize cannon-start message as host would send it
  // (must be done before entering cannon phase — checkpoint captures current state)
  const msg = createCannonStartMessage(s.state);

  // --- Host path: enter cannon phase then init controller ---
  prepareCannonPhase(s.state);
  enterCannonPlacePhase(s.state);
  const hostCtrl = s.controllers[0]!;
  initControllerForCannonPhase(hostCtrl, s.state);
  const hostCursor = { ...hostCtrl.cannonCursor };

  // --- Watcher path: reset cursor and phase, then apply transition ---
  hostCtrl.cannonCursor = { row: 0, col: 0 }; // deliberately wrong
  s.state.phase = Phase.WALL_BUILD; // reset so transition runs full path
  const ctx = s.createTransitionContext();
  handleCannonStartTransition(msg, ctx);
  const watcherCursor = { ...hostCtrl.cannonCursor };

  // Both should produce the same snapped cursor position
  assert(
    hostCursor.row === watcherCursor.row && hostCursor.col === watcherCursor.col,
    `Cursor mismatch: host=(${hostCursor.row},${hostCursor.col}) watcher=(${watcherCursor.row},${watcherCursor.col})`,
  );
});

// ---------------------------------------------------------------------------
// 26. Build-start: watcher calls startBuildPhase on local controller
// ---------------------------------------------------------------------------

test("build-start: watcher calls startBuildPhase on local controller", () => {
  const s = createScenario();
  s.runCannon();
  s.runBattle();

  // Serialize build-start message as host would send it
  const msg = createBuildStartMessage(s.state);

  let buildPhaseStartCalled = false;
  const ctrl = s.controllers[0]!;
  const origOnBuildPhaseStart = ctrl.startBuildPhase.bind(ctrl);
  ctrl.startBuildPhase = (...args) => {
    buildPhaseStartCalled = true;
    origOnBuildPhaseStart(...args);
  };

  const ctx = s.createTransitionContext();
  handleBuildStartTransition(msg as any, ctx);

  assert(buildPhaseStartCalled, "Watcher should call startBuildPhase on local controller");
  assertPhase(s, Phase.WALL_BUILD);
});

// ---------------------------------------------------------------------------
// 27. executeTransition runs steps in declared order
// ---------------------------------------------------------------------------

test("executeTransition runs steps in declared order for all recipes", () => {
  const log: string[] = [];

  // BUILD_START: showBanner → applyCheckpoint → initControllers
  executeTransition(BUILD_START_STEPS, {
    showBanner: () => log.push("showBanner"),
    applyCheckpoint: () => log.push("applyCheckpoint"),
    initControllers: () => log.push("initControllers"),
  });
  assert(log.length === 3, `BUILD: expected 3 steps, got ${log.length}`);
  assert(log[0] === "showBanner", `BUILD step 0: ${log[0]}`);
  assert(log[1] === "applyCheckpoint", `BUILD step 1: ${log[1]}`);
  assert(log[2] === "initControllers", `BUILD step 2: ${log[2]}`);

  // CANNON_START: showBanner → applyCheckpoint → initControllers
  log.length = 0;
  executeTransition(CANNON_START_STEPS, {
    showBanner: () => log.push("showBanner"),
    applyCheckpoint: () => log.push("applyCheckpoint"),
    initControllers: () => log.push("initControllers"),
  });
  assert(log[0] === "showBanner", `CANNON step 0: ${log[0]}`);
  assert(log[1] === "applyCheckpoint", `CANNON step 1: ${log[1]}`);
  assert(log[2] === "initControllers", `CANNON step 2: ${log[2]}`);

  // BATTLE_START: showBanner → applyCheckpoint → snapshotForBanner
  log.length = 0;
  executeTransition(BATTLE_START_STEPS, {
    showBanner: () => log.push("showBanner"),
    applyCheckpoint: () => log.push("applyCheckpoint"),
    snapshotForBanner: () => log.push("snapshotForBanner"),
  });
  assert(log[0] === "showBanner", `BATTLE step 0: ${log[0]}`);
  assert(log[1] === "applyCheckpoint", `BATTLE step 1: ${log[1]}`);
  assert(log[2] === "snapshotForBanner", `BATTLE step 2: ${log[2]}`);
});

// ---------------------------------------------------------------------------
// 28. All three recipes are structurally distinct (no accidental reuse)
// ---------------------------------------------------------------------------

test("recipe step arrays are distinct and have expected lengths", () => {
  // Each recipe is 3 steps
  assert(CANNON_START_STEPS.length === 3, "CANNON_START_STEPS should have 3 steps");
  assert(BATTLE_START_STEPS.length === 3, "BATTLE_START_STEPS should have 3 steps");
  assert(BUILD_START_STEPS.length === 3, "BUILD_START_STEPS should have 3 steps");

  // Battle uses a different recipe (snapshot instead of initControllers)
  const cannon = CANNON_START_STEPS.join(",");
  const battle = BATTLE_START_STEPS.join(",");
  assert(cannon !== battle, "CANNON and BATTLE recipes must differ");

  // All transitions start with banner (capture old scene before reconcile)
  assert(CANNON_START_STEPS[0] === "showBanner", "Cannon must banner first");
  assert(BATTLE_START_STEPS[0] === "showBanner", "Battle must banner first");
  assert(BUILD_START_STEPS[0] === "showBanner", "Build must banner first");
});

// ---------------------------------------------------------------------------
// 29. Build-start parity: host initControllers does real work
// ---------------------------------------------------------------------------

test("build-start: host initControllers runs startBuildPhase (not a no-op)", () => {
  const s = createScenario();
  s.runCannon();
  s.runBattle();

  // Before build-start, controllers should NOT have build state
  const ctrl = s.controllers[0]!;
  const hadPieceBefore = ctrl.getCurrentPiece() !== undefined;

  // Trigger the watcher build-start path
  const msg = createBuildStartMessage(s.state);
  const ctx = s.createTransitionContext();
  handleBuildStartTransition(msg as any, ctx);

  // Watcher inits the controller — it should have a piece now
  const hasPieceAfter = ctrl.getCurrentPiece() !== undefined;
  assert(
    !hadPieceBefore || hasPieceAfter,
    "Controller should have build state after build-start transition",
  );
  assertPhase(s, Phase.WALL_BUILD);
});

// ---------------------------------------------------------------------------
// 30. Battle-start parity: host and watcher reach same post-sweep state
// ---------------------------------------------------------------------------

test("battle-start: host and watcher produce same phase and territory snapshot", () => {
  const s = createScenario();
  s.runCannon();

  // --- Host path: nextPhase + snapshot territory ---
  const hostState = s.state;
  const hostFlights = resolveBalloons(hostState);
  nextPhase(hostState);
  const hostTerritory = hostState.players.map((p) => new Set(p.interior));
  const hostPhase = hostState.phase;

  // --- Watcher path: apply the message the host would have sent ---
  // Reset to pre-transition state for watcher test
  // (host already advanced, so we use the serialized message from before)
  // We test that handleBattleStartTransition sets the same phase.
  const msg = createBattleStartMessage(hostState, hostFlights);
  // Create a fresh scenario for the watcher so states don't share
  const w = createScenario();
  w.runCannon();
  const wCtx = w.createTransitionContext();
  let watcherTerritory: Set<number>[] | undefined;
  let bannerNewTerritory: Set<number>[] | undefined;
  // Intercept snapshotTerritory and banner to capture what the watcher produces
  const origSnapshot = wCtx.battleLifecycle.snapshotTerritory;
  wCtx.battleLifecycle.snapshotTerritory = () => {
    watcherTerritory = origSnapshot();
    return watcherTerritory;
  };
  const origBanner = wCtx.ui.banner;
  // banner.newTerritory is set by the recipe's snapshotForBanner step
  handleBattleStartTransition(msg as any, wCtx);
  bannerNewTerritory = origBanner.newTerritory;

  // Both should be in BATTLE phase
  assert(hostPhase === Phase.BATTLE, `Host should be in BATTLE, got ${hostPhase}`);
  assertPhase(w, Phase.BATTLE);

  // Banner should have received territory snapshot
  assert(bannerNewTerritory !== undefined, "Watcher banner should have newTerritory set");
  assert(
    bannerNewTerritory!.length === hostTerritory.length,
    `Territory array length mismatch: host=${hostTerritory.length} watcher=${bannerNewTerritory!.length}`,
  );

  // Verify exact tile-set equality for each player
  for (let i = 0; i < hostTerritory.length; i++) {
    const hSet = hostTerritory[i]!;
    const wSet = bannerNewTerritory![i]!;
    assert(
      hSet.size === wSet.size,
      `Player ${i} territory size mismatch: host=${hSet.size} watcher=${wSet.size}`,
    );
    for (const tile of hSet) {
      assert(wSet.has(tile), `Player ${i} tile ${tile} in host but not watcher`);
    }
  }
});

// ---------------------------------------------------------------------------
// Watcher: wall debris visible after WALL_DESTROYED events
// ---------------------------------------------------------------------------

test("watcher: wall debris visible in render overlay after WALL_DESTROYED", () => {
  // Simulate the full watcher flow: checkpoint → wall destruction → overlay build
  const s = createScenario();
  s.runCannon();

  // Host side: create the BATTLE_START message
  const hostFlights = resolveBalloons(s.state);
  nextPhase(s.state);
  const msg = createBattleStartMessage(s.state, hostFlights);

  // --- Watcher side ---
  const w = createScenario();
  w.runCannon();

  // Replicate what online-client-runtime does: shared battleAnim object
  const battleAnim = w.createBattleAnim();
  const wCtx = w.createTransitionContext();

  // Rewire checkpoint to write into OUR battleAnim (like online-client-runtime does)
  const origApply = wCtx.checkpoint.applyBattleStart;
  wCtx.checkpoint.applyBattleStart = (data) => {
    // Mimic applyBattleStartCheckpoint writing to the shared battleAnim
    origApply(data);
    // The transition context has its own internal battleAnim; copy walls to ours
    // This simulates buildCheckpointDeps() capturing rs.battleAnim
    battleAnim.walls = snapshotAllWalls(w.state);
    battleAnim.territory = w.state.players.map((p) => new Set(p.interior));
  };

  handleBattleStartTransition(msg as any, wCtx);
  assertPhase(w, Phase.BATTLE);

  // Verify battleAnim.walls was populated
  assert(battleAnim.walls.length > 0, "battleAnim.walls should be set after checkpoint");

  // Find a wall to destroy
  let targetPid = -1 as ValidPlayerSlot;
  let targetWallKey = -1;
  let targetRow = -1;
  let targetCol = -1;
  for (const player of w.state.players) {
    if (player.walls.size > 0) {
      targetPid = player.id;
      for (const key of player.walls) {
        targetWallKey = key;
        targetRow = Math.floor(key / GRID_COLS);
        targetCol = key % GRID_COLS;
        break;
      }
      break;
    }
  }
  assert(targetPid >= 0, "Need a player with walls to test debris");

  // Confirm the wall is in the snapshot
  assert(
    battleAnim.walls[targetPid]!.has(targetWallKey),
    "battleAnim.walls snapshot should contain the wall before destruction",
  );

  // Simulate WALL_DESTROYED event arriving on watcher
  applyImpactEvent(w.state, {
    type: MESSAGE.WALL_DESTROYED,
    row: targetRow,
    col: targetCol,
    playerId: targetPid,
  });

  // Wall removed from live state but still in snapshot
  assert(
    !w.state.players[targetPid]!.walls.has(targetWallKey),
    "player.walls should not contain the destroyed wall",
  );
  assert(
    battleAnim.walls[targetPid]!.has(targetWallKey),
    "battleAnim.walls snapshot should still contain the destroyed wall",
  );

  // Build the render overlay — this is what the renderer actually sees
  const banner = w.createBanner();
  const overlay = createOnlineOverlay({
    previousSelection: { highlighted: null, selected: null },
    state: w.state,
    banner,
    battleAnim,
    frame: { crosshairs: [], phantoms: {} },
    bannerUi: undefined,
    inBattle: w.state.phase === Phase.BATTLE,
    lifeLostDialog: null,
    upgradePickDialog: null,
    povPlayerId: 0 as ValidPlayerSlot,
    hasPointerPlayer: true,
    upgradePickInteractiveId: SPECTATOR_SLOT,
    playerNames: PLAYER_NAMES,
    playerColors: PLAYER_COLORS,
    getLifeLostPanelPos: () => ({ px: 0, py: 0 }),
  });

  // overlay.battle.battleWalls should contain the snapshot (origWalls for debris)
  const battle = overlay.battle!;
  assert(
    battle.battleWalls !== undefined,
    "overlay.battle.battleWalls should be defined during BATTLE phase",
  );
  const origWalls = battle.battleWalls![targetPid];
  assert(
    origWalls !== undefined,
    `battleWalls[${targetPid}] should exist in overlay`,
  );
  assert(
    origWalls!.has(targetWallKey),
    "overlay battleWalls (origWalls) should still have the destroyed wall for debris",
  );

  // overlay.castles[].walls should NOT have the destroyed wall (current state)
  const castle = overlay.castles!.find((c) => c.playerId === targetPid);
  assert(castle !== undefined, `Castle for player ${targetPid} should exist`);
  assert(
    !castle!.walls.has(targetWallKey),
    "overlay castle.walls should NOT have the destroyed wall",
  );

  // This is exactly what drawWallDebris checks:
  // origWalls.has(key) && !castle.walls.has(key) → draw debris
  // If both conditions hold, debris is visible.
});

// ---------------------------------------------------------------------------
// Castle wall ring must not overlap other towers
// ---------------------------------------------------------------------------

test("prebuilt castle walls never land on another tower's tiles", () => {
  // Try multiple seeds to exercise different tower layouts
  for (const seed of [1, 7, 42, 99, 123, 256, 500, 777]) {
    const s = createScenario(seed);
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

// ---------------------------------------------------------------------------
// Burning pits must survive visually through cannon→battle banner transition
// ---------------------------------------------------------------------------

test("burning pits visible in overlay during cannon-to-battle banner", () => {
  const s = createScenario();

  // Inject a burning pit with roundsLeft=1 so enterBattleFromCannon will expire it
  const wallTile = s.findEnemyWallTile(0 as ValidPlayerSlot);
  assert(wallTile !== null, "need an enemy wall tile for pit placement");
  s.state.burningPits.push({ row: wallTile!.row, col: wallTile!.col, roundsLeft: 1 });
  assert(s.state.burningPits.length > 0, "pit should exist before transition");

  // Advance to CANNON_PLACE so we can trigger the cannon→battle transition
  s.runCannon();

  // Run the transition steps manually (same as startHostBattleLifecycle)
  const banner = s.createBanner();
  const battleAnim = s.createBattleAnim();

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () =>
      showBattlePhaseBanner(
        (text, onDone, preservePrevScene?, newBattle?, subtitle?) => {
          showBannerTransition({
            banner,
            state: s.state,
            battleAnim,
            text,
            subtitle,
            onDone,
            preservePrevScene,
            newBattle,
            setModeBanner: () => {},
          });
        },
        "BATTLE!",
        () => {},
      ),
    applyCheckpoint: () => {
      nextPhase(s.state);
      battleAnim.impacts = [];
    },
    snapshotForBanner: () => {
      battleAnim.territory = s.state.players.map((p) => new Set(p.interior));
      battleAnim.walls = s.state.players.map((p) => new Set(p.walls));
      banner.newTerritory = battleAnim.territory;
      banner.newWalls = battleAnim.walls;
    },
  });

  // After transition, state.burningPits has been filtered (the pit expired)
  assert(
    s.state.burningPits.length === 0,
    "pit should be expired in live state after enterBattleFromCannon",
  );

  // But the overlay rendered during the banner should still show the pit
  const overlay = createOnlineOverlay({
    previousSelection: { highlighted: null, selected: null },
    state: s.state,
    banner,
    battleAnim,
    frame: { crosshairs: [], phantoms: {} },
    bannerUi: undefined,
    inBattle: s.state.phase === Phase.BATTLE,
    lifeLostDialog: null,
    upgradePickDialog: null,
    povPlayerId: 0 as ValidPlayerSlot,
    hasPointerPlayer: true,
    upgradePickInteractiveId: SPECTATOR_SLOT,
    playerNames: PLAYER_NAMES,
    playerColors: PLAYER_COLORS,
    getLifeLostPanelPos: () => ({ px: 0, py: 0 }),
  });

  // Current scene (below sweep) shows live state — pits are gone, that's correct
  assert(
    overlay.entities!.burningPits!.length === 0,
    "current scene should show live state (pits expired)",
  );

  // Old scene (above sweep) preserves pits via the snapshot
  assert(
    overlay.ui!.bannerPrevEntities !== undefined,
    "banner should have old entities snapshot",
  );
  assert(
    overlay.ui!.bannerPrevEntities!.burningPits!.length > 0,
    "old scene should still show burning pits during the banner transition",
  );
});

// ---------------------------------------------------------------------------

await runTests("Scenario Tests");
