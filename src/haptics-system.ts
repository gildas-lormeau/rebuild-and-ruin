/**
 * Haptic feedback sub-system factory.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 *
 * Follows the factory-with-deps pattern used by sound, camera, selection, etc.
 */

import { type BattleEvent, MESSAGE } from "../server/protocol.ts";
import { CAN_VIBRATE } from "./platform.ts";

export interface HapticsSystem {
  setLevel: (level: number) => void;
  tap: () => void;
  phaseChange: () => void;
  battleEvents: (
    events: ReadonlyArray<BattleEvent>,
    myPlayerId: number,
  ) => void;
}

const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DESTROYED_MS = 150;

export function createHapticsSystem(): HapticsSystem {
  let hapticsLevel = 2;

  function vibrate(ms: number, minLevel: number): void {
    if (CAN_VIBRATE && hapticsLevel >= minLevel) navigator.vibrate(ms);
  }

  function setLevel(level: number): void {
    hapticsLevel = level;
  }

  /** Light tap for d-pad / button presses. */
  function tap(): void {
    vibrate(8, 2);
  }

  /** Phase transition banner. */
  function phaseChange(): void {
    vibrate(40, 1);
  }

  /** Process battle events and trigger appropriate haptics for the local player. */
  function battleEvents(
    events: ReadonlyArray<BattleEvent>,
    myPlayerId: number,
  ): void {
    if (!CAN_VIBRATE || hapticsLevel < 2) return;
    for (const evt of events) {
      if (evt.type === MESSAGE.WALL_DESTROYED && evt.playerId === myPlayerId) {
        vibrate(HAPTIC_WALL_HIT_MS, 2);
      } else if (
        evt.type === MESSAGE.CANNON_DAMAGED &&
        evt.playerId === myPlayerId
      ) {
        if (evt.newHp === 0) vibrate(HAPTIC_CANNON_DESTROYED_MS, 2);
        else vibrate(80, 2);
      } else if (evt.type === MESSAGE.TOWER_KILLED) {
        vibrate(200, 2);
      } else if (
        evt.type === MESSAGE.CANNON_FIRED &&
        evt.playerId === myPlayerId
      ) {
        vibrate(15, 2);
      }
    }
  }

  return { setLevel, tap, phaseChange, battleEvents };
}
