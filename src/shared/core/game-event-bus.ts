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
import type { Viewport } from "./geometry-types.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

/** Identity of the banner being shown — carried on every BANNER_START /
 *  BANNER_SWEEP_END / BANNER_HIDDEN / BANNER_REPLACED event. Consumers
 *  discriminate on this field instead of reading `phase` (which lies
 *  during the upgrade-pick flow — the dialog banner and the following
 *  build banner both carry phase=WALL_BUILD) or matching banner text. */
export type BannerKind =
  | "modifier-reveal"
  | "battle"
  | "build"
  | "cannon-place"
  | "upgrade-pick";

export type LifecycleEvent =
  | { type: "phaseStart"; phase: Phase; round: number }
  | { type: "phaseEnd"; phase: Phase; round: number }
  | { type: "roundStart"; round: number }
  | { type: "roundEnd"; round: number }
  | { type: "gameEnd"; round: number; winner: ValidPlayerSlot }
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
  /** Phase-transition banner started. Emitted synchronously from
   *  `showBanner` (sweep not yet drawn — the next frame paints it with
   *  progress=0). Consumers identify the banner via `bannerKind`, not
   *  `text` or `phase`. */
  | {
      type: "bannerStart";
      bannerKind: BannerKind;
      text: string;
      subtitle?: string;
      phase: Phase;
      round: number;
    }
  /** Phase-transition banner's sweep animation completed (progress reached
   *  1). Emitted from inside `tickBanner` on the `sweeping → swept`
   *  transition. The banner is still on screen at this point — held in
   *  its `swept` state until `hideBanner()` or the next `showBanner`
   *  replaces it. Fires immediately; the banner's `onDone` callback
   *  runs on the same tick. Consumers that want the "sweep just
   *  finished" beat (music cues, in-banner SFX timing) bind here. */
  | {
      type: "bannerSweepEnd";
      bannerKind: BannerKind;
      text: string;
      phase: Phase;
      round: number;
    }
  /** Phase-transition banner was removed from screen by an explicit
   *  `hideBanner()` call — lifecycle teardown between non-banner display
   *  steps (dialogs, score overlays) or the end of a banner chain. Most
   *  banner-end consumers want this one; use it when you need "this
   *  banner went away on its own schedule" (not because another banner
   *  clobbered it). */
  | {
      type: "bannerHidden";
      bannerKind: BannerKind;
      text: string;
      phase: Phase;
      round: number;
    }
  /** One banner was overwritten by another via a subsequent `showBanner`
   *  call. Fires synchronously before the new banner's BANNER_START.
   *  Carries both the outgoing and incoming banner identity so consumers
   *  that need the "chain of banners" beat can trace it without keeping
   *  their own history. Watchers legitimately replay banners on
   *  checkpoint retransmit — those show up here too. */
  | {
      type: "bannerReplaced";
      prevKind: BannerKind;
      prevText: string;
      newKind: BannerKind;
      newText: string;
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
  | { type: "tick"; dt: number }
  /** Pre-battle announcement transitions, emitted once per crossing of the
   *  `battleCountdown` thresholds (> 3 s → Ready, 1–3 s → Aim, ≤ 1 s →
   *  Fire!). Drives the voice-line SFX for each beat. Host + watcher both
   *  derive these locally from their own `state.battleCountdown`
   *  progression, so the events are never networked. */
  | { type: "battleReady"; round: number }
  | { type: "battleAim"; round: number }
  | { type: "battleFire"; round: number }
  /** Balloon capture animation started — fires once at the cannon-place
   *  → battle transition when at least one flight is queued. Drives the
   *  jaws-theme music cue; paired with `balloonAnimEnd` so the track stops
   *  at the exact frame the animation finishes. */
  | { type: "balloonAnimStart"; round: number }
  /** Balloon capture animation finished — fires once when every flight
   *  reaches progress=1. The next frame enters battle proper. */
  | { type: "balloonAnimEnd"; round: number }
  /** Upgrade-pick dialog is about to show ("Choose Upgrade" banner +
   *  per-player card dialog). Lets subsystems (music) suppress cues
   *  tied to the underlying WALL_BUILD phase transition — by the time
   *  this fires, `state.phase` is already WALL_BUILD, so the upgrade
   *  banner's bannerSweepEnd would otherwise be indistinguishable from
   *  the subsequent "Build & Repair" banner's bannerSweepEnd. */
  | { type: "upgradePickShow"; round: number }
  /** Upgrade-pick dialog resolved — every player has picked or
   *  auto-skipped. Pairs with `upgradePickShow` to bookend the
   *  dialog. The "Build & Repair" banner follows immediately. */
  | { type: "upgradePickEnd"; round: number }
  /** Battle timer reached 0. Distinct from `phaseEnd(BATTLE)` — the phase
   *  hangs around after the timer expires while in-flight cannonballs
   *  land, so consumers that care about the "cease firing" beat (voice
   *  SFX) key off this, not phaseEnd. Derived locally on host + watcher
   *  when `state.timer` crosses from > 0 to 0 during BATTLE. */
  | { type: "battleCease"; round: number }
  /** A cannonball has entered its descent phase — fired once per ball
   *  at a variant-specific lead time so the whistle sample's full
   *  duration fits in the remaining travel window. Scheduling the start
   *  so the sample's built-in impact pop lands on impact avoids doubling
   *  up with the separately-played impact SFX (exp2 / exp3 / explrg1 /
   *  woodcrus). The `variant` field carries the pre-selected index
   *  (picked at launch via state.rng); sfx-player owns the variant →
   *  sample name mapping so game state stays asset-agnostic. Not all
   *  cannonballs whistle — short-trajectory shots whose travel time is
   *  below every variant's duration skip this event entirely. */
  | { type: "cannonballDescending"; variant: number }
  /** Camera target changed at a discrete state transition: phase entry
   *  (per-phase memory restore or first-entry default), explicit zone
   *  command (E/H button → setCameraZone), or life-lost auto-engage.
   *  Continuous motion (edge-pan, tap-nudge animation, pinch updates)
   *  does NOT emit this event — only the moments where the player's
   *  intended camera target changes. `kind` discriminates between a
   *  cameraZone-derived target and a freeform pinch viewport (or the
   *  full map when both are cleared). Used by determinism fixtures to
   *  verify camera v2 phase-transition behavior. */
  | (
      | {
          type: "cameraTarget";
          kind: "zone";
          zone: number;
          source: CameraTargetSource;
        }
      | {
          type: "cameraTarget";
          kind: "pinch";
          viewport: Viewport;
          source: CameraTargetSource;
        }
      | { type: "cameraTarget"; kind: "fullmap"; source: CameraTargetSource }
    )
  /** A wall piece placed during the build phase landed on top of a live
   *  house, crushing it. Drives the `woodcrus` SFX. Distinct from the
   *  battle-phase `houseDestroyed` event (cannonball impact) — that one
   *  is a networked game-state ImpactEvent, this one is purely
   *  presentational. */
  | { type: "houseCrushed"; row: number; col: number };

export type EntityEvent =
  | {
      type: "castlePlaced";
      playerId: ValidPlayerSlot;
      row: number;
      col: number;
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

/** Origin annotation on `cameraTarget` events — fixture readability and
 *  test-side filtering. Drives no game logic. */
export type CameraTargetSource =
  | "phaseEnter"
  | "phaseEnterDefault"
  | "userZone"
  | "userPinch"
  | "engageAutoZoom"
  | "followCrosshair";

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
  BANNER_SWEEP_END: "bannerSweepEnd",
  BANNER_HIDDEN: "bannerHidden",
  BANNER_REPLACED: "bannerReplaced",
  SCORE_OVERLAY_START: "scoreOverlayStart",
  SCORE_OVERLAY_END: "scoreOverlayEnd",
  TICK: "tick",
  BATTLE_READY: "battleReady",
  BATTLE_AIM: "battleAim",
  BATTLE_FIRE: "battleFire",
  BATTLE_CEASE: "battleCease",
  BALLOON_ANIM_START: "balloonAnimStart",
  BALLOON_ANIM_END: "balloonAnimEnd",
  UPGRADE_PICK_SHOW: "upgradePickShow",
  UPGRADE_PICK_END: "upgradePickEnd",
  CANNONBALL_DESCENDING: "cannonballDescending",
  HOUSE_CRUSHED: "houseCrushed",
  CAMERA_TARGET: "cameraTarget",
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
