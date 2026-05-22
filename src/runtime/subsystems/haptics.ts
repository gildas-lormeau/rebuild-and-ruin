/**
 * Haptic feedback — bus-driven vibration. Subscribes to the game bus and
 * fires `navigator.vibrate` on lifecycle + battle events; every trigger
 * flows through the bus, no sibling deps. No-op without vibration;
 * respects the haptics setting. The composition root calls
 * `subscribeBus(state.bus)` from `onStateReady` so each new game binds
 * fresh (idempotent per-bus). Tests pass an optional observer.
 */

import { BATTLE_MESSAGE } from "../../shared/core/battle-events.ts";
import { HAPTICS_ON } from "../../shared/core/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
  type GameEventMap,
} from "../../shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type {
  HapticReason,
  HapticsObserver,
} from "../../shared/core/system-interfaces.ts";
import { CAN_VIBRATE } from "../../shared/platform/platform.ts";

interface HapticsSubsystemDeps {
  /** Live getter — read once per haptic fire so setting changes take effect
   *  immediately without a separate `setLevel` path. Returns 0=off, 1=on. */
  getLevel: () => number;
  /** Point-of-view player, used to filter battle events to the local
   *  perspective (camera follows pov in shared-screen mode). */
  getPovPlayerId: () => ValidPlayerId;
  /** Test observer — production callers omit. */
  observer?: HapticsObserver;
}

interface HapticsSubsystem {
  /** Subscribe to a fresh game-event bus. Idempotent per bus identity;
   *  when given a new bus, unbinds the previous one first so rematches
   *  don't accumulate stale listeners. Safe to call on every
   *  `onStateReady` hook. */
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
  const boundHandlers: Array<{
    type: keyof GameEventMap;
    handler: GameEventHandler<keyof GameEventMap>;
  }> = [];

  function vibrate(reason: HapticReason, ms: number): void {
    observer?.vibrate?.(reason, ms);
    if (CAN_VIBRATE && getLevel() >= HAPTICS_ON) navigator.vibrate(ms);
  }

  function unbindCurrentBus(): void {
    if (subscribedBus) {
      for (const { type, handler } of boundHandlers) {
        subscribedBus.off(type, handler);
      }
    }
    subscribedBus = undefined;
    boundHandlers.length = 0;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (subscribedBus === bus) return;
    unbindCurrentBus();
    subscribedBus = bus;

    const bind = <K extends keyof GameEventMap>(
      type: K,
      handler: GameEventHandler<K>,
    ): void => {
      bus.on(type, handler);
      boundHandlers.push({
        type,
        handler: handler as GameEventHandler<keyof GameEventMap>,
      });
    };

    bind(GAME_EVENT.BANNER_START, () => {
      vibrate("phaseChange", HAPTIC_PHASE_CHANGE_MS);
    });
    bind(GAME_EVENT.UI_TAP, () => {
      vibrate("tap", HAPTIC_TAP_MS);
    });
    bind(BATTLE_MESSAGE.WALL_DESTROYED, (event) => {
      if (event.playerId === getPovPlayerId()) {
        vibrate("wallDestroyed", HAPTIC_WALL_HIT_MS);
      }
    });
    bind(BATTLE_MESSAGE.CANNON_DAMAGED, (event) => {
      if (event.playerId !== getPovPlayerId()) return;
      if (event.newHp === 0) {
        vibrate("cannonDestroyed", HAPTIC_CANNON_DESTROYED_MS);
      } else {
        vibrate("cannonDamaged", HAPTIC_CANNON_DAMAGED_MS);
      }
    });
    bind(BATTLE_MESSAGE.TOWER_KILLED, (event) => {
      if (event.playerId === getPovPlayerId()) {
        vibrate("towerKilled", HAPTIC_TOWER_KILLED_MS);
      }
    });
  }

  return { subscribeBus };
}
