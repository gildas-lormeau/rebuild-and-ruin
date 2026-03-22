/**
 * Haptic feedback for mobile devices.
 * All calls are no-ops on devices without vibration support.
 * Respects the haptics setting: 0=off, 1=phase changes only, 2=all.
 */

const canVibrate = typeof navigator !== "undefined" && !!navigator.vibrate;

/** Current haptics level — set by the game runtime from settings. */
let level = 2; // default: all

export function setHapticsLevel(l: number): void { level = l; }

function vibrate(ms: number, minLevel: number): void {
  if (canVibrate && level >= minLevel) navigator.vibrate(ms);
}

/** Your wall was destroyed. */
export function hapticWallHit(): void { vibrate(30, 2); }

/** Your cannon took damage. */
export function hapticCannonDamaged(): void { vibrate(80, 2); }

/** Your cannon was destroyed. */
export function hapticCannonDestroyed(): void { vibrate(150, 2); }

/** A tower was killed by grunts. */
export function hapticTowerKilled(): void { vibrate(200, 2); }

/** You fired a cannon. */
export function hapticFired(): void { vibrate(15, 2); }

/** Phase transition banner. */
export function hapticPhaseChange(): void { vibrate(40, 1); }

/** Process battle events and trigger appropriate haptics for the local player. */
export function hapticBattleEvents(
  events: Array<{ type: string; playerId?: number; hp?: number }>,
  myPlayerId: number,
): void {
  if (!canVibrate || level < 2) return;
  for (const evt of events) {
    if (evt.type === "wall_destroyed" && evt.playerId === myPlayerId) {
      hapticWallHit();
    } else if (evt.type === "cannon_damaged" && evt.playerId === myPlayerId) {
      if (evt.hp === 0) hapticCannonDestroyed();
      else hapticCannonDamaged();
    } else if (evt.type === "tower_killed") {
      hapticTowerKilled();
    } else if (evt.type === "cannon_fired" && evt.playerId === myPlayerId) {
      hapticFired();
    }
  }
}
