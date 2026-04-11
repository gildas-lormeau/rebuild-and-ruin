/**
 * Haptic feedback sub-system factory.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 *
 * Follows the factory-with-deps pattern used by sound, camera, selection, etc.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` in the deps bag to capture every
 * vibrate intent — including which game event triggered it — without
 * needing a real `navigator.vibrate`. The observer fires whether or not
 * `CAN_VIBRATE` is true and whether or not the current `hapticsLevel`
 * gates the call, so tests can assert "this game event would have
 * triggered haptic X at level Y" independently of the platform/setting.
 *
 * The observer is a write-only sink, threaded from the test scenario
 * through `createHeadlessRuntime` → `createGameRuntime` → here. Production
 * callers (`main.ts`, `online-runtime-game.ts`) pass nothing, so the
 * observer property access is the only added overhead in the hot path.
 */

import { BATTLE_MESSAGE, type BattleEvent } from "../shared/battle-events.ts";
import { HAPTICS_ALL, HAPTICS_PHASE_ONLY } from "../shared/game-constants.ts";
import { CAN_VIBRATE } from "../shared/platform/platform.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type {
  HapticReason,
  HapticsObserver,
  HapticsSystem,
} from "../shared/system-interfaces.ts";

/** Construction-time deps for the haptics sub-system. `observer` is the
 *  test seam — production callers omit it. */
interface HapticsSystemDeps {
  observer?: HapticsObserver;
}

const HAPTIC_TAP_MS = 8;
const HAPTIC_PHASE_CHANGE_MS = 40;
const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DAMAGED_MS = 80;
const HAPTIC_CANNON_DESTROYED_MS = 150;
const HAPTIC_TOWER_KILLED_MS = 200;
const HAPTIC_CANNON_FIRED_MS = 15;

export function createHapticsSystem(
  deps: HapticsSystemDeps = {},
): HapticsSystem {
  const { observer } = deps;
  let hapticsLevel = HAPTICS_ALL;

  function vibrate(reason: HapticReason, ms: number, minLevel: 1 | 2): void {
    observer?.vibrate?.(reason, ms, minLevel);
    if (CAN_VIBRATE && hapticsLevel >= minLevel) navigator.vibrate(ms);
  }

  function setLevel(level: number): void {
    hapticsLevel = level;
  }

  /** Light tap for d-pad / button presses. */
  function tap(): void {
    vibrate("tap", HAPTIC_TAP_MS, HAPTICS_ALL);
  }

  /** Phase transition banner. */
  function phaseChange(): void {
    vibrate("phaseChange", HAPTIC_PHASE_CHANGE_MS, HAPTICS_PHASE_ONLY);
  }

  /** Process battle events and trigger appropriate haptics for the local player.
   *
   *  The early-out below skips the per-event walk on devices where vibration
   *  is unavailable AND no test observer is listening — that's the hot path
   *  in production. When an observer IS installed (deno tests, future debug
   *  overlays), we walk the events so the observer sees every intent even
   *  though `navigator.vibrate` ultimately won't fire. */
  function battleEvents(
    events: ReadonlyArray<BattleEvent>,
    povPlayerId: ValidPlayerSlot,
  ): void {
    if (!observer && (!CAN_VIBRATE || hapticsLevel < HAPTICS_ALL)) return;
    for (const evt of events) {
      if (
        evt.type === BATTLE_MESSAGE.WALL_DESTROYED &&
        evt.playerId === povPlayerId
      ) {
        vibrate("wallDestroyed", HAPTIC_WALL_HIT_MS, HAPTICS_ALL);
      } else if (
        evt.type === BATTLE_MESSAGE.CANNON_DAMAGED &&
        evt.playerId === povPlayerId
      ) {
        if (evt.newHp === 0)
          vibrate("cannonDestroyed", HAPTIC_CANNON_DESTROYED_MS, HAPTICS_ALL);
        else vibrate("cannonDamaged", HAPTIC_CANNON_DAMAGED_MS, HAPTICS_ALL);
      } else if (evt.type === BATTLE_MESSAGE.TOWER_KILLED) {
        vibrate(
          BATTLE_MESSAGE.TOWER_KILLED,
          HAPTIC_TOWER_KILLED_MS,
          HAPTICS_ALL,
        );
      } else if (
        evt.type === BATTLE_MESSAGE.CANNON_FIRED &&
        evt.playerId === povPlayerId
      ) {
        vibrate("cannonFired", HAPTIC_CANNON_FIRED_MS, HAPTICS_ALL);
      }
    }
  }

  return { setLevel, tap, phaseChange, battleEvents };
}
