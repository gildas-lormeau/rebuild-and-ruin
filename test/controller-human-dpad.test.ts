/**
 * HumanController dpadVector unit tests — verify the analog touch d-pad
 * path on the controller side. Drives `battleTick` directly (which calls
 * the private `moveCrosshairFromInput`) against a stub BattleViewState
 * with no players, so `aimCannons` early-returns and the only observable
 * effect is crosshair position drift.
 *
 * Covers:
 *   - vector drives crosshair in non-cardinal directions
 *   - vector wins precedence over heldActions
 *   - clearDpadVector() restores the heldActions code path
 *   - sprint (ROTATE held) applies to the vector branch
 *   - lifecycle resets (endBattle / onLifeLost / reset) clear the vector
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { HumanController } from "../src/controllers/controller-human.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import {
  type BattleViewState,
  CROSSHAIR_SPEED,
} from "../src/shared/core/system-interfaces.ts";
import { Action } from "../src/shared/ui/input-action.ts";
import { PLAYER_KEY_BINDINGS } from "../src/shared/ui/player-config.ts";

const PID = 0 as ValidPlayerSlot;
const TOLERANCE = 0.0001;

Deno.test(
  "dpadVector drives crosshair drift in the exact direction set",
  () => {
    const ctrl = makeController();
    ctrl.setCrosshair(100, 100);
    // Unit vector aimed at NNW: x ≈ -0.3827, y ≈ -0.9239 (22.5° W of N).
    const angle = -Math.PI / 2 - Math.PI / 8;
    ctrl.setDpadVector(Math.cos(angle), Math.sin(angle));
    ctrl.battleTick(stubBattleState(), 1);
    const cross = ctrl.getCrosshair();
    assertAlmostEquals(
      cross.x,
      100 + Math.cos(angle) * CROSSHAIR_SPEED,
      TOLERANCE,
    );
    assertAlmostEquals(
      cross.y,
      100 + Math.sin(angle) * CROSSHAIR_SPEED,
      TOLERANCE,
    );
  },
);

Deno.test("dpadVector wins precedence over held cardinals", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(100, 100);
  // Keyboard says LEFT, touch says RIGHT — vector must win.
  ctrl.handleKeyDown(Action.LEFT);
  ctrl.setDpadVector(1, 0);
  ctrl.battleTick(stubBattleState(), 1);
  const cross = ctrl.getCrosshair();
  assertAlmostEquals(cross.x, 100 + CROSSHAIR_SPEED, TOLERANCE);
  assertAlmostEquals(cross.y, 100, TOLERANCE);
});

Deno.test("clearDpadVector falls back to heldActions cardinals", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(100, 100);
  ctrl.setDpadVector(1, 0);
  ctrl.clearDpadVector();
  ctrl.handleKeyDown(Action.LEFT);
  ctrl.battleTick(stubBattleState(), 1);
  const cross = ctrl.getCrosshair();
  assertAlmostEquals(cross.x, 100 - CROSSHAIR_SPEED, TOLERANCE);
});

Deno.test("ROTATE sprint multiplier applies to the vector branch", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(100, 100);
  ctrl.handleKeyDown(Action.ROTATE);
  ctrl.setDpadVector(1, 0);
  ctrl.battleTick(stubBattleState(), 1);
  // CROSSHAIR_SPRINT_MULTIPLIER is 2 — vector × 2× speed × dt(1).
  assertAlmostEquals(ctrl.getCrosshair().x, 100 + CROSSHAIR_SPEED * 2, TOLERANCE);
});

Deno.test("endBattle clears the dpadVector", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(100, 100);
  ctrl.setDpadVector(1, 0);
  ctrl.endBattle();
  ctrl.battleTick(stubBattleState(), 1);
  assertEquals(ctrl.getCrosshair().x, 100);
});

Deno.test("onLifeLost clears the dpadVector", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(100, 100);
  ctrl.setDpadVector(0, 1);
  ctrl.onLifeLost();
  ctrl.battleTick(stubBattleState(), 1);
  assertEquals(ctrl.getCrosshair().y, 100);
});

Deno.test("reset clears the dpadVector", () => {
  const ctrl = makeController();
  ctrl.setDpadVector(-1, 0);
  ctrl.reset();
  // reset() moves the crosshair to its default origin — set a known
  // position AFTER reset, then assert the next tick produces no movement.
  ctrl.setCrosshair(100, 100);
  ctrl.battleTick(stubBattleState(), 1);
  assertEquals(ctrl.getCrosshair().x, 100);
});

Deno.test("crosshair clamps to map bounds even with vector overflow", () => {
  const ctrl = makeController();
  ctrl.setCrosshair(0, 0);
  ctrl.setDpadVector(-1, -1);
  ctrl.battleTick(stubBattleState(), 1);
  const cross = ctrl.getCrosshair();
  assert(cross.x >= 0, `expected x clamped to >=0, got ${cross.x}`);
  assert(cross.y >= 0, `expected y clamped to >=0, got ${cross.y}`);
});

function makeController(): HumanController {
  return new HumanController(PID, PLAYER_KEY_BINDINGS[0]!);
}

function stubBattleState(): BattleViewState {
  // aimCannons() reads state.players[playerId] and early-returns when the
  // slot is empty, so an empty players array is the minimal safe state.
  return { players: [], capturedCannons: [] } as unknown as BattleViewState;
}
