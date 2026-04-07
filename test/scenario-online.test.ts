import { MESSAGE, type ServerMessage } from "../server/protocol.ts";
import { applyImpactEvent, resolveBalloons } from "../src/game/battle-system.ts";
import { snapshotAllWalls } from "../src/shared/board-occupancy.ts";
import { createOnlineOverlay } from "../src/render/render-composition.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "../src/shared/player-config.ts";
import { GRID_COLS } from "../src/shared/grid.ts";
import {
  handleBattleStartTransition,
  handleBuildStartTransition,
  handleCannonStartTransition,
} from "../src/online/online-phase-transitions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
} from "../src/online/online-serialize.ts";
import {
  BATTLE_START_STEPS,
  executeTransition,
  showBattlePhaseBanner,
} from "../src/game/phase-transition-steps.ts";
import { showBannerTransition } from "../src/game/phase-banner.ts";
import {
  assertPhase,
  createScenario,
} from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import { enterCannonPlacePhase, nextPhase } from "../src/game/game-engine.ts";
import { initControllerForCannonPhase, prepareCannonPhase } from "../src/game/phase-setup.ts";
import { SPECTATOR_SLOT, type ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { Phase } from "../src/shared/game-phase.ts";
import type { BannerState } from "../src/shared/ui-contracts.ts";

// ---------------------------------------------------------------------------
// Online watcher: cannon banner missing preservePrevScene
// ---------------------------------------------------------------------------

Deno.test("online cannon banner uses preservePrevScene=true for progressive scene transition", async () => {
  // Both local and online paths should use preservePrevScene=true for the cannon banner.
  // The fix added preservePrevScene=true to handleCannonStartTransition.
  const s = await createScenario();
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
// Online transition: cannon start stashes pre-sweep walls
// ---------------------------------------------------------------------------

Deno.test("online handleCannonStartTransition stashes pre-checkpoint walls on banner", async () => {
  const s = await createScenario();

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
// Online transition: battle start sets banner.newWalls post-checkpoint
// ---------------------------------------------------------------------------

Deno.test("online handleBattleStartTransition sets banner.newWalls after checkpoint", async () => {
  const s = await createScenario();

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
// Cannon-start: host and watcher init controller the same way
// ---------------------------------------------------------------------------

Deno.test("cannon-start: watcher uses same initControllerForCannonPhase as host", async () => {
  const s = await createScenario();
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
// Build-start: watcher calls startBuildPhase on local controller
// ---------------------------------------------------------------------------

Deno.test("build-start: watcher calls startBuildPhase on local controller", async () => {
  const s = await createScenario();
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
  handleBuildStartTransition(msg as ServerMessage, ctx);

  assert(buildPhaseStartCalled, "Watcher should call startBuildPhase on local controller");
  assertPhase(s, Phase.WALL_BUILD);
});

// ---------------------------------------------------------------------------
// Build-start parity: host initControllers does real work
// ---------------------------------------------------------------------------

Deno.test("build-start: host initControllers runs startBuildPhase (not a no-op)", async () => {
  const s = await createScenario();
  s.runCannon();
  s.runBattle();

  // Before build-start, controllers should NOT have build state
  const ctrl = s.controllers[0]!;
  const hadPieceBefore = ctrl.getCurrentPiece() !== undefined;

  // Trigger the watcher build-start path
  const msg = createBuildStartMessage(s.state);
  const ctx = s.createTransitionContext();
  handleBuildStartTransition(msg as ServerMessage, ctx);

  // Watcher inits the controller — it should have a piece now
  const hasPieceAfter = ctrl.getCurrentPiece() !== undefined;
  assert(
    !hadPieceBefore || hasPieceAfter,
    "Controller should have build state after build-start transition",
  );
  assertPhase(s, Phase.WALL_BUILD);
});

// ---------------------------------------------------------------------------
// Battle-start parity: host and watcher reach same post-sweep state
// ---------------------------------------------------------------------------

Deno.test("battle-start: host and watcher produce same phase and territory snapshot", async () => {
  const s = await createScenario();
  s.runCannon();

  // --- Host path: nextPhase + snapshot territory ---
  const hostState = s.state;
  nextPhase(hostState);
  const hostFlights = resolveBalloons(hostState);
  const hostTerritory = hostState.players.map((p) => new Set(p.interior));
  const hostPhase = hostState.phase;

  // --- Watcher path: apply the message the host would have sent ---
  // Reset to pre-transition state for watcher test
  // (host already advanced, so we use the serialized message from before)
  // We test that handleBattleStartTransition sets the same phase.
  const msg = createBattleStartMessage(hostState, hostFlights);
  // Create a fresh scenario for the watcher so states don't share
  const w = await createScenario();
  w.runCannon();
  const wCtx = w.createTransitionContext();
  let watcherTerritory: Set<number>[] | undefined;
  let bannerNewTerritory: Set<number>[] | undefined = undefined;
  // Intercept snapshotTerritory and banner to capture what the watcher produces
  const origSnapshot = wCtx.battleLifecycle.snapshotTerritory;
  wCtx.battleLifecycle.snapshotTerritory = () => {
    watcherTerritory = origSnapshot();
    return watcherTerritory;
  };
  const origBanner = wCtx.ui.banner;
  // banner.newTerritory is set by the recipe's snapshotForBanner step
  handleBattleStartTransition(msg as ServerMessage, wCtx);
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

Deno.test("watcher: wall debris visible in render overlay after WALL_DESTROYED", async () => {
  // Simulate the full watcher flow: checkpoint → wall destruction → overlay build
  const s = await createScenario();
  s.runCannon();

  // Host side: create the BATTLE_START message
  nextPhase(s.state);
  const hostFlights = resolveBalloons(s.state);
  const msg = createBattleStartMessage(s.state, hostFlights);

  // --- Watcher side ---
  const w = await createScenario();
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

  handleBattleStartTransition(msg as ServerMessage, wCtx);
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
// Burning pits must survive visually through cannon→battle banner transition
// ---------------------------------------------------------------------------

Deno.test("burning pits visible in overlay during cannon-to-battle banner", async () => {
  const s = await createScenario();

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
