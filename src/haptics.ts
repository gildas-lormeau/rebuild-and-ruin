/**
 * Haptic feedback for mobile devices.
 * All calls are no-ops on devices without vibration support.
 */

const canVibrate = typeof navigator !== "undefined" && !!navigator.vibrate;

function vibrate(ms: number): void {
  if (canVibrate) navigator.vibrate(ms);
}

/** Your wall was destroyed. */
export function hapticWallHit(): void { vibrate(30); }

/** Your cannon took damage. */
export function hapticCannonDamaged(): void { vibrate(80); }

/** Your cannon was destroyed. */
export function hapticCannonDestroyed(): void { vibrate(150); }

/** A tower was killed by grunts. */
export function hapticTowerKilled(): void { vibrate(200); }

/** You fired a cannon. */
export function hapticFired(): void { vibrate(15); }

/** Phase transition banner. */
export function hapticPhaseChange(): void { vibrate(40); }

/** Process battle events and trigger appropriate haptics for the local player. */
export function hapticBattleEvents(
  events: Array<{ type: string; playerId?: number; hp?: number }>,
  myPlayerId: number,
): void {
  if (!canVibrate) return;
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
