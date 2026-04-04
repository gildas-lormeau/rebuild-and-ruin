/**
 * Haptic feedback sub-system factory.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 *
 * Follows the factory-with-deps pattern used by sound, camera, selection, etc.
 */

import { type BattleEvent, MESSAGE } from "../server/protocol.ts";
import { CAN_VIBRATE } from "./platform.ts";
import { HAPTICS_ALL, HAPTICS_PHASE_ONLY } from "./player-config.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";

export interface HapticsSystem {
  setLevel: (level: number) => void;
  tap: () => void;
  phaseChange: () => void;
  battleEvents: (
    events: ReadonlyArray<BattleEvent>,
    povPlayerId: ValidPlayerSlot,
  ) => void;
}

const HAPTIC_TAP_MS = 8;
const HAPTIC_PHASE_CHANGE_MS = 40;
const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DAMAGED_MS = 80;
const HAPTIC_CANNON_DESTROYED_MS = 150;
const HAPTIC_TOWER_KILLED_MS = 200;
const HAPTIC_CANNON_FIRED_MS = 15;

export function createHapticsSystem(): HapticsSystem {
  let hapticsLevel = HAPTICS_ALL;

  function vibrate(
    ms: number,
    minLevel: typeof HAPTICS_PHASE_ONLY | typeof HAPTICS_ALL,
  ): void {
    if (CAN_VIBRATE && hapticsLevel >= minLevel) navigator.vibrate(ms);
  }

  function setLevel(level: number): void {
    hapticsLevel = level;
  }

  /** Light tap for d-pad / button presses. */
  function tap(): void {
    vibrate(HAPTIC_TAP_MS, HAPTICS_ALL);
  }

  /** Phase transition banner. */
  function phaseChange(): void {
    vibrate(HAPTIC_PHASE_CHANGE_MS, HAPTICS_PHASE_ONLY);
  }

  /** Process battle events and trigger appropriate haptics for the local player. */
  function battleEvents(
    events: ReadonlyArray<BattleEvent>,
    povPlayerId: ValidPlayerSlot,
  ): void {
    if (!CAN_VIBRATE || hapticsLevel < HAPTICS_ALL) return;
    for (const evt of events) {
      if (evt.type === MESSAGE.WALL_DESTROYED && evt.playerId === povPlayerId) {
        vibrate(HAPTIC_WALL_HIT_MS, HAPTICS_ALL);
      } else if (
        evt.type === MESSAGE.CANNON_DAMAGED &&
        evt.playerId === povPlayerId
      ) {
        if (evt.newHp === 0) vibrate(HAPTIC_CANNON_DESTROYED_MS, HAPTICS_ALL);
        else vibrate(HAPTIC_CANNON_DAMAGED_MS, HAPTICS_ALL);
      } else if (evt.type === MESSAGE.TOWER_KILLED) {
        vibrate(HAPTIC_TOWER_KILLED_MS, HAPTICS_ALL);
      } else if (
        evt.type === MESSAGE.CANNON_FIRED &&
        evt.playerId === povPlayerId
      ) {
        vibrate(HAPTIC_CANNON_FIRED_MS, HAPTICS_ALL);
      }
    }
  }

  return { setLevel, tap, phaseChange, battleEvents };
}
