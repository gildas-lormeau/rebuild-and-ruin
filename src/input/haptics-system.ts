/**
 * Haptic feedback sub-system factory.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 *
 * Follows the factory-with-deps pattern used by sound, camera, selection, etc.
 *
 * ### Test observer
 *
 * `setHapticsObserver` is the test seam (mirrors `setRenderObserver` in
 * `render-map.ts`). Tests install an observer to capture every vibrate
 * intent — including which game event triggered it — without needing a
 * real `navigator.vibrate`. The observer fires whether or not
 * `CAN_VIBRATE` is true and whether or not the current `hapticsLevel`
 * gates the call, so tests can assert "this game event would have
 * triggered haptic X at level Y" independently of the platform/setting.
 *
 * The observer is a write-only sink — tests subscribe via
 * `setHapticsObserver({...})`, run the scenario, then read the recorded
 * calls. Pass `undefined` to clear (paired with the scenario disposable
 * so a follow-on test starts clean).
 */

import { BATTLE_MESSAGE, type BattleEvent } from "../shared/battle-events.ts";
import { HAPTICS_ALL, HAPTICS_PHASE_ONLY } from "../shared/game-constants.ts";
import { CAN_VIBRATE } from "../shared/platform.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { HapticsSystem } from "../shared/system-interfaces.ts";

/** Reason a haptic call was made — lets the observer (and future debug
 *  overlays) attribute a vibration to the game event that triggered it
 *  instead of just seeing a duration. */
export type HapticReason =
  | "tap"
  | "phaseChange"
  | "wallDestroyed"
  | "cannonDamaged"
  | "cannonDestroyed"
  | "towerKilled"
  | "cannonFired";

/** Test observer — receives every vibrate intent BEFORE the platform/level
 *  gate. Tests use this to assert that game events triggered the right
 *  haptic feedback without needing a real `navigator.vibrate`. Inlined
 *  in the `setHapticsObserver` signature so callers don't need a named
 *  import; the type is local-only by design (knip would otherwise flag
 *  it as an unused export). */
interface HapticsObserver {
  vibrate?(reason: HapticReason, ms: number, minLevel: 1 | 2): void;
}

const HAPTIC_TAP_MS = 8;
const HAPTIC_PHASE_CHANGE_MS = 40;
const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DAMAGED_MS = 80;
const HAPTIC_CANNON_DESTROYED_MS = 150;
const HAPTIC_TOWER_KILLED_MS = 200;
const HAPTIC_CANNON_FIRED_MS = 15;

let hapticsObserver: HapticsObserver | undefined;

/** Install a haptics observer (test seam). Pass `undefined` to clear.
 *  Mirrors `setRenderObserver` from `render-map.ts`. Production code never
 *  sets this. */
export function setHapticsObserver(
  observer: HapticsObserver | undefined,
): void {
  hapticsObserver = observer;
}

export function createHapticsSystem(): HapticsSystem {
  let hapticsLevel = HAPTICS_ALL;

  function vibrate(reason: HapticReason, ms: number, minLevel: 1 | 2): void {
    hapticsObserver?.vibrate?.(reason, ms, minLevel);
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
    if (!hapticsObserver && (!CAN_VIBRATE || hapticsLevel < HAPTICS_ALL))
      return;
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
