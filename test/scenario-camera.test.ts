import {
  assertCameraZone,
  createScenario,
} from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { Mode } from "../src/shared/ui-mode.ts";

// ---------------------------------------------------------------------------
// Camera does NOT zoom to human zone during AI-only reselection
// ---------------------------------------------------------------------------

Deno.test("camera stays unzoomed during AI-only reselection", () => {
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
  assertCameraZone(handle, undefined);

  // Even after isSelectionReady becomes true, should not zoom for reselect
  handle.setCtx({ isSelectionReady: true });
  handle.tick();
  assertCameraZone(handle, undefined);
});

// ---------------------------------------------------------------------------
// Camera zooms to human zone when human IS reselecting
// ---------------------------------------------------------------------------

Deno.test("camera zooms to human zone when human IS reselecting", () => {
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
    handle.camera.getCameraZone() !== undefined,
    "Camera should zoom to human zone when human is reselecting",
  );
});

// ---------------------------------------------------------------------------
// No auto-zoom without a human player (demo / spectator)
// ---------------------------------------------------------------------------

Deno.test("camera stays unzoomed when no human player exists", () => {
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
  assertCameraZone(handle, undefined);

  // Transition to battle — still no zoom
  s.state.phase = Phase.BATTLE;
  handle.setCtx({ phase: Phase.BATTLE });
  handle.tick();
  assertCameraZone(handle, undefined);
});
