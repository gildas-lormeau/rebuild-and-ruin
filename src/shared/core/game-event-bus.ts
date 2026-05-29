/**
 * Typed game event bus — unified pub/sub. Events are category unions; the
 * master GameEventMap is auto-derived, so adding a member + constant
 * registers it. Battle events reuse the BattleEvent union from
 * `battle-events.ts`.
 */

import { BATTLE_MESSAGE, type BattleEvent } from "./battle-events.ts";
import type { ModifierId } from "./game-constants.ts";
import type { Phase } from "./game-phase.ts";
import type { CannonIdx, TowerIdx, Viewport } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";
import type { ZoneId } from "./zone-id.ts";

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

type LifecycleEvent =
  | { type: "phaseStart"; phase: Phase; round: number }
  | { type: "phaseEnd"; phase: Phase; round: number }
  | { type: "roundStart"; round: number }
  | { type: "roundEnd"; round: number }
  | { type: "gameEnd"; round: number; winner: ValidPlayerId }
  | { type: "playerEliminated"; playerId: ValidPlayerId; round: number }
  | {
      type: "lifeLost";
      playerId: ValidPlayerId;
      livesRemaining: number;
      round: number;
    }
  /** Emitted once when the life-lost dialog is about to show. Lets
   *  observation subsystems (sound) fire a one-shot cue without
   *  double-triggering on per-player `lifeLost` events. */
  | {
      type: "lifeLostDialogShow";
      needsReselect: readonly ValidPlayerId[];
      eliminated: readonly ValidPlayerId[];
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
  /** Per-frame tick (dev/test only). Emitted once per frame after rendering
   *  while a session is live, when `RuntimeConfig.emitTickEvent` is set —
   *  true in headless tests and on the dev server / localhost (E2E + local
   *  dev), false in deployed prod (which has no consumers). The dev-only E2E
   *  bridge attaches a canvas snapshot to the busLog entry so browser-based
   *  tests can read per-frame pixel data. */
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
   *  command (zone-cycle button → setCameraZone), or life-lost auto-engage.
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
          zone: ZoneId;
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
   *  house, crushing it. The house is replaced by a grunt at the same
   *  tile (no wall is laid there). Purely diagnostic — no SFX. Distinct
   *  from the battle-phase `houseDestroyed` event (cannonball impact),
   *  which is a networked game-state ImpactEvent. */
  | { type: "houseCrushed"; row: number; col: number };

type EntityEvent =
  | {
      type: "castlePlaced";
      playerId: ValidPlayerId;
      row: number;
      col: number;
    }
  | {
      type: "wallPlaced";
      playerId: ValidPlayerId;
      tileKeys: readonly TileKey[];
    }
  /** One tile of a castle prebuild animation (round-1 autobuild /
   *  reselect) was just dropped in. Fires per tile, so N tiles in a
   *  castle = N events. Separate from `wallPlaced` (which is for
   *  player-driven build-phase placement) so consumers can disambiguate
   *  the two gameplay beats — cosmetic-only event for SFX pacing. */
  | { type: "castleBuildTile"; playerId: ValidPlayerId; tileKey: TileKey }
  /** A tower transitioned from un-enclosed to enclosed by a player (all
   *  footprint tiles became interior-or-wall). Fires from inside the
   *  territory flood-fill, so prebuild animations AND player-driven wall
   *  placement both trigger it identically. Consumers decide whether to
   *  dedupe — the SFX layer tracks "first this phase per player" locally
   *  to gate the fanfare. */
  | { type: "towerEnclosed"; playerId: ValidPlayerId; towerIndex: TowerIdx }
  | {
      type: "cannonPlaced";
      playerId: ValidPlayerId;
      row: number;
      col: number;
      cannonIdx: CannonIdx;
    }
  | {
      type: "gruntSpawn";
      row: number;
      col: number;
      /** How the grunt arrived: `"zone-pick"` = chosen by
       *  `findGruntSpawnPositions` (bank/edge tier), `"at-tile"` =
       *  spawned at an exact tile via `spawnGruntAtTile` (house crushed
       *  by piece placement). Tests can filter by source — only zone-pick
       *  spawns are subject to the picker's distribution rules. */
      source: "zone-pick" | "at-tile";
      round: number;
    }
  | {
      type: "gruntSpawnBlocked";
      playerId: ValidPlayerId;
      requested: number;
      placed: number;
    }
  /** One enclosure of the player's territory just trapped one or more
   *  grunts. Fires once per connected enclosed region containing grunts
   *  (a single placement can produce multiple events if it seals off
   *  several disjoint pockets at once). Drives the `woodcrus` SFX. */
  | {
      type: "gruntsEnclosed";
      playerId: ValidPlayerId;
      count: number;
    };

type ModernEvent =
  | {
      type: "modifierApplied";
      modifierId: ModifierId;
      round: number;
    }
  | {
      type: "upgradePicked";
      playerId: ValidPlayerId;
      upgradeId: UpgradeId;
    };

/** UI interaction events — user-driven touch/click feedback signals that
 *  don't belong to any game-logic category (not a lifecycle beat, not an
 *  entity change). Consumers are typically feedback subsystems (haptics,
 *  future sound) that react to "the user just tapped a control" without
 *  the control itself knowing about the feedback subsystem. */
type InteractionEvent = { type: "uiTap" };

/** Origin annotation on `cameraTarget` events — fixture readability and
 *  test-side filtering. Drives no game logic. */
export type CameraTargetSource =
  | "phaseEnter"
  | "userZone"
  | "userPinch"
  | "lifeLostHold"
  | "followCrosshair";

type GameEvent =
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
type AnyEventHandler = (
  type: keyof GameEventMap,
  event: GameEventMap[keyof GameEventMap],
) => void;

export interface GameEventBus {
  /** Emit an event to typed + wildcard listeners. */
  emit<K extends keyof GameEventMap>(type: K, event: GameEventMap[K]): void;
  // lint:allow-callback-inversion -- observer: bus broadcasts; handlers
  // run at the caller's layer and don't feed back into bus logic.
  /** Subscribe to a specific event type. */
  on<K extends keyof GameEventMap>(type: K, handler: GameEventHandler<K>): void;
  // lint:allow-callback-inversion -- observer (see `on` above).
  /** Unsubscribe from a specific event type. */
  off<K extends keyof GameEventMap>(
    type: K,
    handler: GameEventHandler<K>,
  ): void;
  // lint:allow-callback-inversion -- observer (see `on` above).
  /** Subscribe to ALL events (logging, debugging). */
  onAny(handler: AnyEventHandler): void;
  // lint:allow-callback-inversion -- observer (see `on` above).
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
  GRUNTS_ENCLOSED: "gruntsEnclosed",
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
      const set = typed.get(type);
      if (set) for (const handler of set) handler(event);
      for (const handler of wildcard) {
        handler(type, event);
      }
    },
    on<K extends keyof GameEventMap>(
      type: K,
      handler: GameEventHandler<K>,
    ): void {
      let set = typed.get(type);
      if (!set) {
        set = new Set();
        typed.set(type, set);
      }
      set.add(handler as InternalHandler);
    },
    off<K extends keyof GameEventMap>(
      type: K,
      handler: GameEventHandler<K>,
    ): void {
      typed.get(type)?.delete(handler as InternalHandler);
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
