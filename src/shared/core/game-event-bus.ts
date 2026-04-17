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
  | { type: "gameEnd"; round: number }
  | { type: "playerEliminated"; playerId: ValidPlayerSlot; round: number }
  | {
      type: "lifeLost";
      playerId: ValidPlayerSlot;
      livesRemaining: number;
      round: number;
    }
  /** Emitted once when the life-lost dialog is about to show. Lets
   *  observation subsystems (sound) fire a one-shot cue without
   *  double-triggering on per-player `lifeLost` events. */
  | {
      type: "lifeLostDialogShow";
      needsReselect: readonly ValidPlayerSlot[];
      eliminated: readonly ValidPlayerSlot[];
      round: number;
    }
  /** Phase-transition banner started. Emitted on the first tick AFTER all
   *  banner content has settled, so mid-frame mutations (e.g. the modifier
   *  reveal replacing the battle banner) are captured with final content. */
  | {
      type: "bannerStart";
      text: string;
      subtitle?: string;
      phase: Phase;
      round: number;
      /** Set when the banner is showing a modifier reveal. */
      modifierId?: ModifierId;
      /** Tile keys changed by the modifier — consumed by the progressive
       *  reveal animation. Undefined when the banner has no modifier. */
      changedTiles?: readonly number[];
    }
  /** Phase-transition banner finished (progress reached 1). Emitted before
   *  the banner's completion callback fires. */
  | {
      type: "bannerEnd";
      text: string;
      phase: Phase;
      round: number;
    }
  /** Between-rounds score-delta overlay started. Fires when
   *  `scoreDelta.show` arms the delta timer at end of WALL_BUILD; pairs
   *  with `scoreOverlayEnd` when the timer expires. */
  | { type: "scoreOverlayStart"; round: number }
  /** Between-rounds score-delta overlay finished. Emitted immediately
   *  before the `onDone` callback runs (life-lost dialog or next banner). */
  | { type: "scoreOverlayEnd"; round: number }
  /** Dev-only per-frame tick. Emitted once per frame after rendering, only
   *  when IS_DEV is true. The E2E bridge attaches a canvas snapshot to the
   *  busLog entry so browser-based tests can read per-frame pixel data. */
  | { type: "tick"; dt: number };

export type EntityEvent =
  | {
      type: "castlePlaced";
      playerId: ValidPlayerSlot;
      row: number;
      col: number;
      /** True when a player is re-picking their starting castle after losing
       *  all enclosing walls — consumers (music) that only care about the
       *  initial selection can filter on `isReselect=false`. */
      isReselect: boolean;
    }
  | {
      type: "wallPlaced";
      playerId: ValidPlayerSlot;
      tileKeys: readonly number[];
    }
  /** One tile of a castle prebuild animation (round-1 autobuild /
   *  reselect) was just dropped in. Fires per tile, so N tiles in a
   *  castle = N events. Separate from `wallPlaced` (which is for
   *  player-driven build-phase placement) so consumers can disambiguate
   *  the two gameplay beats — cosmetic-only event for SFX pacing. */
  | { type: "castleBuildTile"; playerId: ValidPlayerSlot; tileKey: number }
  /** A tower transitioned from un-enclosed to enclosed by a player (all
   *  footprint tiles became interior-or-wall). Fires from inside the
   *  territory flood-fill, so prebuild animations AND player-driven wall
   *  placement both trigger it identically. Consumers decide whether to
   *  dedupe — the SFX layer tracks "first this phase per player" locally
   *  to gate the fanfare. */
  | { type: "towerEnclosed"; playerId: ValidPlayerSlot; towerIndex: number }
  | {
      type: "cannonPlaced";
      playerId: ValidPlayerSlot;
      row: number;
      col: number;
      cannonIdx: number;
    }
  | {
      type: "gruntSpawn";
      row: number;
      col: number;
      victimPlayerId: ValidPlayerSlot;
    }
  | {
      type: "gruntSpawnBlocked";
      playerId: ValidPlayerSlot;
      requested: number;
      placed: number;
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

/** UI interaction events — user-driven touch/click feedback signals that
 *  don't belong to any game-logic category (not a lifecycle beat, not an
 *  entity change). Consumers are typically feedback subsystems (haptics,
 *  future sound) that react to "the user just tapped a control" without
 *  the control itself knowing about the feedback subsystem. */
export type InteractionEvent = { type: "uiTap" };

/** All game events across all categories. */
export type GameEvent =
  | BattleEvent
  | LifecycleEvent
  | EntityEvent
  | ModernEvent
  | InteractionEvent;

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

const LIFECYCLE_EVENT = {
  PHASE_START: "phaseStart",
  PHASE_END: "phaseEnd",
  ROUND_START: "roundStart",
  ROUND_END: "roundEnd",
  GAME_END: "gameEnd",
  PLAYER_ELIMINATED: "playerEliminated",
  LIFE_LOST: "lifeLost",
  LIFE_LOST_DIALOG_SHOW: "lifeLostDialogShow",
  BANNER_START: "bannerStart",
  BANNER_END: "bannerEnd",
  SCORE_OVERLAY_START: "scoreOverlayStart",
  SCORE_OVERLAY_END: "scoreOverlayEnd",
  TICK: "tick",
} as const;
const ENTITY_EVENT = {
  CASTLE_PLACED: "castlePlaced",
  WALL_PLACED: "wallPlaced",
  CASTLE_BUILD_TILE: "castleBuildTile",
  TOWER_ENCLOSED: "towerEnclosed",
  CANNON_PLACED: "cannonPlaced",
  GRUNT_SPAWN: "gruntSpawn",
  GRUNT_SPAWN_BLOCKED: "gruntSpawnBlocked",
} as const;
const MODERN_EVENT = {
  MODIFIER_APPLIED: "modifierApplied",
  UPGRADE_PICKED: "upgradePicked",
} as const;
const INTERACTION_EVENT = {
  UI_TAP: "uiTap",
} as const;
const busComplete: BusComplete = true;
/** All event type constants. Use GAME_EVENT.* in emit/on/off calls. */
export const GAME_EVENT = {
  ...BATTLE_MESSAGE,
  ...LIFECYCLE_EVENT,
  ...ENTITY_EVENT,
  ...MODERN_EVENT,
  ...INTERACTION_EVENT,
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

void busComplete;
