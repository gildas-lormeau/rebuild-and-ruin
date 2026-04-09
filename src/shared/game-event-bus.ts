/**
 * Typed game event bus — unified pub/sub for all game-domain events.
 *
 * Events are organized in **categories** (discriminated unions). The master
 * GameEventMap is auto-derived from the union — adding a member to any
 * category union + a constant automatically registers it on the bus.
 *
 * Battle events reuse the existing BattleEvent union from battle-events.ts.
 */

import { BATTLE_MESSAGE, type BattleEvent } from "./battle-events.ts";
import type { ModifierId } from "./game-constants.ts";
import type { Phase } from "./game-phase.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

export type LifecycleEvent =
  | { type: "phaseStart"; phase: Phase; round: number }
  | { type: "phaseEnd"; phase: Phase; round: number }
  | { type: "roundStart"; round: number }
  | { type: "roundEnd"; round: number }
  | { type: "gameStart"; round: number }
  | { type: "gameEnd"; round: number }
  | { type: "playerEliminated"; playerId: ValidPlayerSlot; round: number }
  | {
      type: "lifeLost";
      playerId: ValidPlayerSlot;
      livesRemaining: number;
      round: number;
    };

export type EntityEvent =
  | {
      type: "wallPlaced";
      playerId: ValidPlayerSlot;
      tileKeys: readonly number[];
    }
  | {
      type: "cannonPlaced";
      playerId: ValidPlayerSlot;
      row: number;
      col: number;
      cannonIdx: number;
    };

export type ModernEvent =
  | {
      type: "modifierApplied";
      modifierId: ModifierId;
      round: number;
    }
  | {
      type: "upgradePicked";
      playerId: ValidPlayerSlot;
      upgradeId: UpgradeId;
    };

/** All game events across all categories. */
export type GameEvent =
  | BattleEvent
  | LifecycleEvent
  | EntityEvent
  | ModernEvent;

/** Union of all event type strings. */
type GameEventType = GameEvent["type"];

/** Auto-derived map: event type string → payload type.
 *  No manual maintenance — derived from the GameEvent union via key remapping. */
export type GameEventMap = {
  [E in GameEvent as E["type"]]: E;
};

// Compile-time: every constant must have a matching event type and vice versa.
type ConstantValues = (typeof GAME_EVENT)[keyof typeof GAME_EVENT];

type UnmatchedConstants = Exclude<ConstantValues, GameEventType>;

type MissingConstants = Exclude<GameEventType, ConstantValues>;

type BusComplete = [UnmatchedConstants, MissingConstants] extends [never, never]
  ? true
  : never;

/** Typed handler for a specific event type. */
export type GameEventHandler<K extends keyof GameEventMap> = (
  event: GameEventMap[K],
) => void;

/** Catch-all handler for logging, debugging, replay. */
export type AnyEventHandler = (
  type: keyof GameEventMap,
  event: GameEventMap[keyof GameEventMap],
) => void;

export interface GameEventBus {
  /** Emit an event to typed + wildcard listeners. */
  emit<K extends keyof GameEventMap>(type: K, event: GameEventMap[K]): void;
  /** Subscribe to a specific event type. */
  on<K extends keyof GameEventMap>(type: K, handler: GameEventHandler<K>): void;
  /** Unsubscribe from a specific event type. */
  off<K extends keyof GameEventMap>(
    type: K,
    handler: GameEventHandler<K>,
  ): void;
  /** Subscribe to ALL events (logging, debugging). */
  onAny(handler: AnyEventHandler): void;
  /** Unsubscribe a catch-all handler. */
  offAny(handler: AnyEventHandler): void;
  /** Remove all listeners (game teardown). */
  clear(): void;
}

type InternalHandler = (event: unknown) => void;

interface GameLogEntry {
  readonly type: GameEventType;
  readonly round: number;
  readonly data: GameEventMap[keyof GameEventMap];
}

interface GameLogger {
  /** All recorded entries (append-only, chronological). */
  readonly entries: readonly GameLogEntry[];
  /** Filter entries by event type (payload narrows to GameEventMap[K]). */
  filter<K extends keyof GameEventMap>(
    type: K,
  ): readonly (GameLogEntry & { readonly data: GameEventMap[K] })[];
  /** Disconnect from the bus. */
  detach(): void;
  /** Clear all recorded entries. */
  clear(): void;
}

const LIFECYCLE_EVENT = {
  PHASE_START: "phaseStart",
  PHASE_END: "phaseEnd",
  ROUND_START: "roundStart",
  ROUND_END: "roundEnd",
  GAME_START: "gameStart",
  GAME_END: "gameEnd",
  PLAYER_ELIMINATED: "playerEliminated",
  LIFE_LOST: "lifeLost",
} as const;
const ENTITY_EVENT = {
  WALL_PLACED: "wallPlaced",
  CANNON_PLACED: "cannonPlaced",
} as const;
const MODERN_EVENT = {
  MODIFIER_APPLIED: "modifierApplied",
  UPGRADE_PICKED: "upgradePicked",
} as const;
const busComplete: BusComplete = true;
/** All event type constants. Use GAME_EVENT.* in emit/on/off calls. */
export const GAME_EVENT = {
  ...BATTLE_MESSAGE,
  ...LIFECYCLE_EVENT,
  ...ENTITY_EVENT,
  ...MODERN_EVENT,
} as const;

export function createGameEventBus(): GameEventBus {
  const typed = new Map<string, Set<InternalHandler>>();
  const wildcard = new Set<AnyEventHandler>();

  return {
    emit<K extends keyof GameEventMap>(type: K, event: GameEventMap[K]): void {
      const set = typed.get(type as string);
      if (set) for (const handler of set) handler(event);
      for (const handler of wildcard) {
        handler(type, event as GameEventMap[keyof GameEventMap]);
      }
    },
    on<K extends keyof GameEventMap>(
      type: K,
      handler: GameEventHandler<K>,
    ): void {
      let set = typed.get(type as string);
      if (!set) {
        set = new Set();
        typed.set(type as string, set);
      }
      set.add(handler as InternalHandler);
    },
    off<K extends keyof GameEventMap>(
      type: K,
      handler: GameEventHandler<K>,
    ): void {
      typed.get(type as string)?.delete(handler as InternalHandler);
    },
    onAny(handler: AnyEventHandler): void {
      wildcard.add(handler);
    },
    offAny(handler: AnyEventHandler): void {
      wildcard.delete(handler);
    },
    clear(): void {
      typed.clear();
      wildcard.clear();
    },
  };
}

/** Convenience: emit with auto-filled `type` discriminant.
 *  Avoids repeating the type string in the payload. */
export function emitGameEvent<K extends keyof GameEventMap>(
  bus: GameEventBus,
  type: K,
  payload: Omit<GameEventMap[K], "type">,
): void {
  bus.emit(type, { type, ...payload } as GameEventMap[K]);
}

export function createGameLogger(
  bus: GameEventBus,
  getRound: () => number,
): GameLogger {
  const entries: GameLogEntry[] = [];
  const handler: AnyEventHandler = (type, data) => {
    entries.push({ type: type as GameEventType, round: getRound(), data });
  };
  bus.onAny(handler);

  return {
    entries,
    filter<K extends keyof GameEventMap>(
      type: K,
    ): readonly (GameLogEntry & { readonly data: GameEventMap[K] })[] {
      return entries.filter((entry) => entry.type === type) as (GameLogEntry & {
        readonly data: GameEventMap[K];
      })[];
    },
    detach(): void {
      bus.offAny(handler);
    },
    clear(): void {
      entries.length = 0;
    },
  };
}

/** Subscribe to the bus and format events as readable log lines via a sink function.
 *  Returns a detach function. Filters can narrow which events are logged. */
export function createBusLog(
  bus: GameEventBus,
  sink: (line: string) => void,
  filter?: ReadonlySet<string>,
): () => void {
  const handler: AnyEventHandler = (type, event) => {
    if (filter && !filter.has(type)) return;
    const parts: string[] = [type as string];
    const record = event as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "type") continue;
      parts.push(`${key}=${record[key]}`);
    }
    sink(parts.join(" "));
  };
  bus.onAny(handler);
  return () => bus.offAny(handler);
}

void busComplete;
