/**
 * Haptic feedback for mobile devices.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 */

import { MSG } from "../server/protocol.ts";
import { CAN_VIBRATE } from "./platform.ts";

const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DESTROYED_MS = 150;

/** Current haptics level — set by the game runtime from settings. */
let level = 2;

export function setHapticsLevel(l: number): void { level = l; }

/** Light tap for d-pad / button presses. */
export function hapticTap(): void { vibrate(8, 2); }

/** Phase transition banner. */
export function hapticPhaseChange(): void { vibrate(40, 1); }

/** Process battle events and trigger appropriate haptics for the local player. */
export function hapticBattleEvents(
  events: ReadonlyArray<{ type: string; playerId?: number; hp?: number }>,
  myPlayerId: number,
): void {
  if (!CAN_VIBRATE || level < 2) return;
  for (const evt of events) {
    if (evt.type === MSG.WALL_DESTROYED && evt.playerId === myPlayerId) {
      hapticWallHit();
    } else if (evt.type === MSG.CANNON_DAMAGED && evt.playerId === myPlayerId) {
      if (evt.hp === 0) hapticCannonDestroyed();
      else hapticCannonDamaged();
    } else if (evt.type === MSG.TOWER_KILLED) {
      hapticTowerKilled();
    } else if (evt.type === MSG.CANNON_FIRED && evt.playerId === myPlayerId) {
      hapticFired();
    }
  }
}

/** Your wall was destroyed. */
function hapticWallHit(): void { vibrate(HAPTIC_WALL_HIT_MS, 2); }

/** Your cannon took damage. */
function hapticCannonDamaged(): void { vibrate(80, 2); }

/** Your cannon was destroyed. */
function hapticCannonDestroyed(): void { vibrate(HAPTIC_CANNON_DESTROYED_MS, 2); }

/** A tower was killed by grunts. */
function hapticTowerKilled(): void { vibrate(200, 2); }

/** You fired a cannon. */
function hapticFired(): void { vibrate(15, 2); }

function vibrate(ms: number, minLevel: number): void {
  if (CAN_VIBRATE && level >= minLevel) navigator.vibrate(ms);
}
