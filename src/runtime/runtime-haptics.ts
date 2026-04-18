/**
 * Haptic feedback sub-system — bus-driven vibration.
 *
 * Subscribes to the game event bus and fires `navigator.vibrate` on
 * lifecycle + battle events. No sibling subsystem sees a haptics "deps"
 * field — every trigger flows through the bus. All calls are no-ops on
 * devices without vibration support. Respects the on/off haptics setting.
 *
 * ### Wiring
 *
 * The composition root constructs the subsystem once and calls
 * `subscribeBus(state.bus)` from the bootstrap `onStateReady` hook so
 * every new game (first launch + rematch) binds to its fresh bus.
 * `subscribeBus` is idempotent per-bus identity.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` that captures every vibrate intent
 * (reason + ms) BEFORE the platform/level gate, so tests can assert
 * "this bus event would have triggered haptic X" independently of
 * `CAN_VIBRATE` and the haptics setting.
 */

import { BATTLE_MESSAGE } from "../shared/core/battle-events.ts";
import { HAPTICS_ON } from "../shared/core/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventBus,
} from "../shared/core/game-event-bus.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type {
  HapticReason,
  HapticsObserver,
} from "../shared/core/system-interfaces.ts";
import { CAN_VIBRATE } from "../shared/platform/platform.ts";

interface HapticsSubsystemDeps {
  /** Live getter — read once per haptic fire so setting changes take effect
   *  immediately without a separate `setLevel` path. Returns 0=off, 1=on. */
  getLevel: () => number;
  /** Point-of-view player, used to filter battle events to the local
   *  perspective (camera follows pov in shared-screen mode). */
  getPovPlayerId: () => ValidPlayerSlot;
  /** Test observer — production callers omit. */
  observer?: HapticsObserver;
}

interface HapticsSubsystem {
  /** Subscribe to a fresh game-event bus. Idempotent per bus identity —
   *  safe to call on every `onStateReady` hook so rematches rebind to the
   *  new bus. */
  subscribeBus: (bus: GameEventBus) => void;
}

// Durations are tuned for commodity Android motors (ERM / LRA) which need
// ~20–40ms just to spin up before any pulse is perceptible. The empirical
// floor — from the pulses used in progressier's public vibration demo and
// confirmed in /haptics-test.html — is 100–150ms; anything shorter fires
// the API but typically isn't felt.
const HAPTIC_TAP_MS = 50;
const HAPTIC_WALL_HIT_MS = 200;
const HAPTIC_PHASE_CHANGE_MS = 250;
const HAPTIC_CANNON_DAMAGED_MS = 300;
const HAPTIC_CANNON_DESTROYED_MS = 450;
const HAPTIC_TOWER_KILLED_MS = 600;

export function createHapticsSubsystem(
  deps: HapticsSubsystemDeps,
): HapticsSubsystem {
  const { getLevel, getPovPlayerId, observer } = deps;
  let subscribedBus: GameEventBus | undefined;

  function vibrate(reason: HapticReason, ms: number): void {
    observer?.vibrate?.(reason, ms);
    if (CAN_VIBRATE && getLevel() >= HAPTICS_ON) navigator.vibrate(ms);
  }

  function subscribeBus(bus: GameEventBus): void {
    if (subscribedBus === bus) return;
    subscribedBus = bus;
    bus.on(GAME_EVENT.BANNER_START, () => {
      vibrate("phaseChange", HAPTIC_PHASE_CHANGE_MS);
    });
    bus.on(GAME_EVENT.UI_TAP, () => {
      vibrate("tap", HAPTIC_TAP_MS);
    });
    bus.on(BATTLE_MESSAGE.WALL_DESTROYED, (event) => {
      if (event.playerId === getPovPlayerId()) {
        vibrate("wallDestroyed", HAPTIC_WALL_HIT_MS);
      }
    });
    bus.on(BATTLE_MESSAGE.CANNON_DAMAGED, (event) => {
      if (event.playerId !== getPovPlayerId()) return;
      if (event.newHp === 0) {
        vibrate("cannonDestroyed", HAPTIC_CANNON_DESTROYED_MS);
      } else {
        vibrate("cannonDamaged", HAPTIC_CANNON_DAMAGED_MS);
      }
    });
    bus.on(BATTLE_MESSAGE.TOWER_KILLED, (event) => {
      if (event.playerId === getPovPlayerId()) {
        vibrate("towerKilled", HAPTIC_TOWER_KILLED_MS);
      }
    });
  }

  return { subscribeBus };
}
