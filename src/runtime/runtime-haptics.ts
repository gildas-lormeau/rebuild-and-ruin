/**
 * Haptic feedback sub-system — bus-driven vibration.
 *
 * Subscribes to the game event bus and fires `navigator.vibrate` on
 * lifecycle + battle events. No sibling subsystem sees a haptics "deps"
 * field — every trigger flows through the bus. All calls are no-ops on
 * devices without vibration support. Respects the haptics setting:
 * 0=off, 1=phase changes only, 2=all.
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
 * (reason + ms + minLevel) BEFORE the platform/level gate, so tests can
 * assert "this bus event would have triggered haptic X at level Y"
 * independently of `CAN_VIBRATE` and the haptics level.
 */

import {
  BATTLE_MESSAGE,
  type BattleEvent,
} from "../shared/core/battle-events.ts";
import {
  HAPTICS_ALL,
  HAPTICS_PHASE_ONLY,
} from "../shared/core/game-constants.ts";
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
   *  immediately without a separate `setLevel` path. */
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

const HAPTIC_PHASE_CHANGE_MS = 40;
const HAPTIC_WALL_HIT_MS = 30;
const HAPTIC_CANNON_DAMAGED_MS = 80;
const HAPTIC_CANNON_DESTROYED_MS = 150;
const HAPTIC_TOWER_KILLED_MS = 200;
const HAPTIC_CANNON_FIRED_MS = 15;
const BATTLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(BATTLE_MESSAGE),
);

export function createHapticsSubsystem(
  deps: HapticsSubsystemDeps,
): HapticsSubsystem {
  const { getLevel, getPovPlayerId, observer } = deps;
  let subscribedBus: GameEventBus | undefined;

  function vibrate(reason: HapticReason, ms: number, minLevel: 1 | 2): void {
    observer?.vibrate?.(reason, ms, minLevel);
    if (CAN_VIBRATE && getLevel() >= minLevel) navigator.vibrate(ms);
  }

  function handleBattleEvent(evt: BattleEvent): void {
    const pov = getPovPlayerId();
    if (evt.type === BATTLE_MESSAGE.WALL_DESTROYED && evt.playerId === pov) {
      vibrate("wallDestroyed", HAPTIC_WALL_HIT_MS, HAPTICS_ALL);
    } else if (
      evt.type === BATTLE_MESSAGE.CANNON_DAMAGED &&
      evt.playerId === pov
    ) {
      if (evt.newHp === 0)
        vibrate("cannonDestroyed", HAPTIC_CANNON_DESTROYED_MS, HAPTICS_ALL);
      else vibrate("cannonDamaged", HAPTIC_CANNON_DAMAGED_MS, HAPTICS_ALL);
    } else if (evt.type === BATTLE_MESSAGE.TOWER_KILLED) {
      vibrate(BATTLE_MESSAGE.TOWER_KILLED, HAPTIC_TOWER_KILLED_MS, HAPTICS_ALL);
    } else if (
      evt.type === BATTLE_MESSAGE.CANNON_FIRED &&
      evt.playerId === pov
    ) {
      vibrate("cannonFired", HAPTIC_CANNON_FIRED_MS, HAPTICS_ALL);
    }
  }

  function subscribeBus(bus: GameEventBus): void {
    if (subscribedBus === bus) return;
    subscribedBus = bus;
    bus.on(GAME_EVENT.BANNER_START, () => {
      vibrate("phaseChange", HAPTIC_PHASE_CHANGE_MS, HAPTICS_PHASE_ONLY);
    });
    // The early-out below skips the per-event walk on devices where vibration
    // is unavailable AND no test observer is listening — that's the hot path
    // in production. When an observer IS installed (deno tests, future debug
    // overlays), we walk so the observer sees every intent even though
    // `navigator.vibrate` ultimately won't fire.
    bus.onAny((type, event) => {
      if (!BATTLE_EVENT_TYPES.has(type)) return;
      if (!observer && (!CAN_VIBRATE || getLevel() < HAPTICS_ALL)) return;
      handleBattleEvent(event as BattleEvent);
    });
  }

  return { subscribeBus };
}
