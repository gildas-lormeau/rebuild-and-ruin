/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { Rng } from "../platform/rng.ts";
import type { Mode } from "../ui/ui-mode.ts";
import type {
  BurningPit,
  Cannonball,
  CannonMode,
  CapturedCannon,
  Grunt,
} from "./battle-types.ts";
import {
  EMPTY_FEATURES,
  type FeatureId,
  MODERN_FEATURES,
} from "./feature-defs.ts";
import {
  GAME_MODE_MODERN,
  type GameMode,
  type ModifierId,
} from "./game-constants.ts";
import type { GameEventBus } from "./game-event-bus.ts";
import type { Phase } from "./game-phase.ts";
import type { BonusSquare, GameMap } from "./geometry-types.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "./player-slot.ts";
import type { Player } from "./player-types.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

export interface GameState {
  /** Optional runtime-instance label for cross-runtime debugging.
   *  Set by test scenarios (HOST/WATCHER for `network-setup.ts`,
   *  LOCAL for `scenario.ts`) so capture-point traces from
   *  `scripts/debug` can attribute interleaved frames to the runtime
   *  that produced them. Production code never sets or reads this —
   *  it's pure test/diagnostic infrastructure. Kept on the type so
   *  V8-side capture expressions can reference it without a cast. */
  debugTag?: string;
  /** Shared seeded RNG for deterministic gameplay decisions.
   *  Available methods: .next() → [0,1), .int(lo,hi), .bool(prob),
   *  .pick(arr), .shuffle(arr). See rng.ts for full API. */
  rng: Rng;
  map: GameMap;
  phase: Phase;
  round: number;
  /** Max rounds before the game ends (3, 5, 8, 12, or Infinity for "To The Death"). */
  maxRounds: number;
  /** Hits needed to destroy a cannon (configurable: 3, 6, 9, or 12). */
  cannonMaxHp: number;
  /** Duration of the wall-build/repair phase in seconds (difficulty-scaled). */
  buildTimer: number;
  /** Duration of the cannon placement phase in seconds (difficulty-scaled). */
  cannonPlaceTimer: number;
  /** Cannons allowed in the first round (difficulty-scaled). */
  firstRoundCannons: number;
  players: Player[];
  /** Index of the player whose turn it is (for sequential phases). */
  /** Active phase timer (counts down in build, cannon, selection). Not used during
   *  battle — see battleCountdown. Remaining time in seconds (counts DOWN from
   *  phase max to 0).
   *
   *  Computed by advancePhaseTimer() as `timer = max - elapsed`, where elapsed is
   *  accumulated in TimerAccums per frame. Every peer ticks identically; the host
   *  is the authoritative source via FULL_STATE checkpoints, and `state.timer` is
   *  the only field carried across the wire (both peers reconstruct accums from it
   *  via `syncAccumulatorsFromTimer`).
   *
   *  Check `timer > 0` for "time left". Never write `timer -= dt` directly. */
  timer: number;
  /** Active cannonballs in flight. */
  cannonballs: Cannonball[];
  /** Number of cannonballs fired this battle round. */
  shotsFired: number;
  /** Active grunts on the map. */
  grunts: Grunt[];
  /** Whether each tower is alive (indexed same as map.towers). */
  towerAlive: boolean[];
  /** Dead towers that were enclosed last build phase — revive if still enclosed next build phase. */
  towerPendingRevive: Set<number>;
  /** Burning pits left by super gun incendiary cannonballs. Block placement. */
  burningPits: BurningPit[];
  /** Cannons captured by propaganda balloons this round (lasts one battle). */
  capturedCannons: CapturedCannon[];
  /** Persistent balloon hit counts — accumulates across battles, removed after capture or cannon destruction.
   *  Hit count persists across battles (cumulative toward capture threshold).
   *  capturerIds resets each battle — tracks which players contributed hits this round.
   *  Cleared by cleanupBalloonHitTrackingAfterBattle() at battle end. */
  /** Bonus squares on the map (3 per zone). */
  bonusSquares: BonusSquare[];
  /** Pre-battle countdown (Ready/Aim/Fire). Only meaningful during BATTLE phase.
   *  Separate from timer. 0 = battle active. */
  battleCountdown: number;
  /** Players who built (or rebuilt) a fresh castle this round. Populated as
   *  each player confirms a tower selection; drained at cannon-phase setup. Drives the "fresh castle"
   *  cannon-budget formula
   *  (`cannonSlotsForRound`) and the per-zone modifier grace period
   *  (`finalizeFreshCastles` sets `player.freshCastle = true`). */
  freshCastlePlayers: Set<number>;
  /** Zone index assigned to each player (indexed by player id). Set at game start. */
  playerZones: number[];
  /** Cannon slot limits per player for the current cannon phase.
   *  Computed by computeCannonLimitsForPhase at CANNON_PLACE start.
   *  Phase-dependent: only meaningful when `state.phase === Phase.CANNON_PLACE`.
   *  Always guard: `if (state.phase === Phase.CANNON_PLACE) { ... state.cannonLimits ... }` */
  cannonLimits: number[];
  /** Per-slot done flag for CANNON_PLACE — populated by:
   *  (1) local controller's `isCannonPhaseDone` going true (mark + broadcast if human);
   *  (2) wire `OPPONENT_CANNON_PHASE_DONE` from a remote-driven slot.
   *  Phase exits when every non-eliminated slot is in this set, OR the timer hits 0.
   *  Cleared on CANNON_PLACE entry (`enterCannonPlacePhase`). */
  cannonPlaceDone: Set<ValidPlayerSlot>;
  /** Bonus cannon slots earned via Salvage upgrade (cannon kills during battle).
   *  Consumed by computeCannonLimitsForPhase at cannon phase start, then zeroed. */
  salvageSlots: number[];
  /** Typed event bus for game-domain pub/sub. Transient — not serialized.
   *  Created by createGameEventBus() at game start. */
  bus: GameEventBus;
  /** Game mode: classic (original rules) or modern (environmental modifiers). Immutable for the match. */
  gameMode: GameMode;
  /** Active feature capabilities for this match. Empty in classic mode.
   *  Determines which game subsystems are active (modifiers, upgrades, combos).
   *  Derived from gameMode by setGameMode(). Guard with hasFeature(state, "featureId"). */
  activeFeatures: ReadonlySet<FeatureId>;
  /** Modern-mode state (modifiers, combos, upgrades, terrain effects).
   *  null in classic mode — inner fields carry phase-specific nullability
   *  (e.g. frozenTiles is null between battles). */
  modern: ModernState | null;
  /** Monotonic logical-tick counter advanced once per fixed simulation
   *  tick on every peer. Drives the lockstep scheduled-actions queue:
   *  every wire-broadcast input is stamped with `applyAt = senderSimTick
   *  + SAFETY` and applied at the corresponding tick on every peer
   *  (originator and receivers), so cross-peer event order is identical
   *  regardless of wire-vs-local timing. Serialized in FULL_STATE so
   *  late-joining watchers and post-migration hosts pick up at the
   *  authoritative count. */
  simTick: number;
  /** Cannons whose fire has been scheduled on this peer but not yet drained
   *  (ball not yet pushed to `cannonballs`). Keyed by
   *  `playerId * MAX_CANNON_SLOT_KEY + cannonIdx`. Read by `canFireOwnCannon`
   *  so the originator's AI doesn't double-fire the same cannon during the
   *  SAFETY window between schedule and apply. Per-peer transient: differs
   *  across peers during the wire-delay window (only entries from the local
   *  peer's own scheduled fires are observed, since `canFireOwnCannon` is
   *  only called for slots the peer drives). Cleared on rematch and at
   *  battle-phase setup; not synced over the wire. */
  pendingCannonFires: Set<number>;
  /** Per-player slot-cost counter for cannon placements scheduled on this
   *  peer but not yet drained. Read by `isCannonPlacementLegal` so the
   *  originator's AI strategy doesn't plan more cannons than `cannonLimits`
   *  during the SAFETY window between schedule and apply. Per-peer
   *  transient (same shape and rationale as `pendingCannonFires`). Cleared
   *  on rematch and at cannon-phase setup; not synced over the wire. */
  pendingCannonSlotCost: number[];
  /** Per-slot pending-broadcast marker for the cannon-phase-done lockstep
   *  schedule. Set when the originator detects done and schedules the
   *  `cannonPlaceDone.add` for `applyAt`; cleared on apply. Read by the
   *  detect loop in `tickCannonPhase` so the originator doesn't re-broadcast
   *  in the SAFETY window between schedule and apply. Per-peer transient
   *  (only the originator ever populates it; receivers never need it).
   *  Cleared on rematch and at cannon-phase setup. */
  pendingCannonPlaceDone: Set<ValidPlayerSlot>;
}

/** Upgrade offer triple — 3 unique upgrade choices offered to a player. */
export type UpgradeOfferTuple = [UpgradeId, UpgradeId, UpgradeId];

/** State exclusive to modern mode. null on GameState in classic mode. */
/** Floating combo event — structured data aged by the renderer, removed when expired.
 *  The render layer formats the display text from `kind`, `streak`, and `bonus`. */
export interface ComboEvent {
  kind: "wall" | "cannon" | "grunt";
  streak: number;
  bonus: number;
  age: number;
  playerId: ValidPlayerSlot;
}

export interface ModernState {
  /** Active modifier for the current round. null = none this round. */
  activeModifier: ModifierId | null;
  /** Tile keys changed by `activeModifier` (scarred / frozen / crumbled
   *  tiles depending on the modifier). Populated when the modifier
   *  applies; drives the `MODIFIER_REVEAL` dwell-phase tile pulse in
   *  the render path. Parallel lifecycle to `activeModifier` — cleared
   *  alongside it. Empty array = no changed tiles (or no active
   *  modifier). */
  activeModifierChangedTiles: readonly number[];
  /** Previous round's modifier id (for no-repeat rule). null = none. */
  lastModifierId: ModifierId | null;
  /** Master Builder lockout countdown (seconds remaining). 0 = no lockout.
   *  When exactly one player owns Master Builder, non-owners are locked out
   *  of building for this many seconds at the start of the build phase. */
  masterBuilderLockout: number;
  /** Players who picked Master Builder this round. null = nobody.
   *  Persists through the build phase (needed to compute buildMax for advancePhaseTimer). */
  masterBuilderOwners: ReadonlySet<ValidPlayerSlot> | null;
  /** Combo scoring tracker (transient during battle, not serialized).
   *  Created at battle start, cleared at battle end. */
  comboTracker: {
    players: {
      lastWallHitTime: number;
      wallStreak: number;
      lastGruntKillTime: number;
      gruntStreak: number;
      wallsDestroyedThisRound: number;
    }[];
    events: ComboEvent[];
  } | null;
  /** Pre-generated upgrade offers per player for the current round.
   *  Generated in prepareNextRound using synced RNG, consumed by the upgrade pick dialog.
   *  null before UPGRADE_FIRST_ROUND. */
  pendingUpgradeOffers: Map<ValidPlayerSlot, UpgradeOfferTuple> | null;
  /** Pre-computed AI upgrade pick per player, drawn from `state.rng` at
   *  battle-done.mutate (right after `pendingUpgradeOffers` is generated)
   *  so `state.rng` is consumed at a deterministic state-mutation point.
   *  Without this, the AI brain's `state.rng.next()` fires lazily in
   *  `tickAiUpgradePickEntry` at lock-in tick — and which peers tick which
   *  slots is determined by `shouldAutoResolve`, which is asymmetric across
   *  peers (host skips remote slots, non-host skips own slot). The
   *  resulting RNG-draw counts differ cross-peer, drifting `state.rng`.
   *  The dialog tick reads from this map instead of computing on-the-fly,
   *  making the draw both deterministic and peer-symmetric.
   *  null before UPGRADE_FIRST_ROUND or for non-modern modes. */
  precomputedUpgradePicks: Map<ValidPlayerSlot, UpgradeId> | null;
  /** Frozen river tiles (packed tile keys) — water tiles that grunts can cross.
   *  Set during battle when frozen_river modifier is active, null otherwise. */
  frozenTiles: Set<number> | null;
  /** Sinkhole tiles (packed tile keys) — grass tiles permanently converted to water.
   *  Cumulative across rounds. null = no sinkholes yet. */
  sinkholeTiles: Set<number> | null;
  /** High tide tiles (packed tile keys) — grass tiles temporarily flooded.
   *  Set when high_tide modifier fires, cleared at next battle start. null otherwise. */
  highTideTiles: Set<number> | null;
  /** Low water tiles (packed tile keys) — water tiles temporarily converted to grass.
   *  Set when low_water modifier fires, cleared at next battle start. null otherwise. */
  lowWaterTiles: Set<number> | null;
  /** Grunt tile keys that have absorbed one frostbite hit (the ice "chip" from
   *  reinforced-walls-style two-hit kill). Populated when frostbite is active;
   *  cleared between battles. null = no frostbite this round. */
  chippedGrunts: Set<number> | null;
  /** Precomputed dust-storm jitter angles (radians) drawn from `state.rng` at
   *  `prepareBattleState` when the rolled modifier is dust-storm. Indexed by
   *  `state.shotsFired` at fire time so both peers compute identical jitter
   *  without drawing rng during the lockstep SAFETY window. Empty array when
   *  dust-storm isn't active this round (the lookup is gated by
   *  `activeModifier === DUST_STORM`). Modulo'd if `shotsFired` exceeds the
   *  buffer — deterministic across peers either way. */
  precomputedDustStormJitters: readonly number[];
  /** Pre-removal snapshot for the rubble_clearing modifier. Captured by
   *  `rubbleClearingImpl.apply` BEFORE the live entities are filtered
   *  out of `player.cannons` / `state.burningPits`, so the renderer can
   *  fade them out post-banner via `overlay.battle.rubbleClearingFade`.
   *  null when no rubble_clearing reveal is in flight; cleared at the
   *  NEXT round's `prepareBattleState` (so the held set persists
   *  through battle, wall-build, and the next cannon-place phase). */
  rubbleClearingHeld: {
    pits: readonly BurningPit[];
    deadCannons: readonly {
      ownerId: ValidPlayerSlot;
      col: number;
      row: number;
      mode: CannonMode;
      /** Mortar flag at capture time — drives debris-variant choice
       *  (mortar_debris vs tier_n_debris). */
      mortar?: boolean;
      /** Owner's cannon tier at capture time — drives the
       *  tier_n_debris variant for non-special cannons. */
      tier: 1 | 2 | 3;
    }[];
  } | null;
  /** Pre-removal snapshot for the crumbling_walls modifier. Captured by
   *  `crumblingWallsImpl.apply` BEFORE `deletePlayerWallsBatch` removes
   *  the walls from `player.walls`. Two consumers:
   *
   *   1. `snapshotAllWalls` unions held tile keys into the per-player
   *      battle-walls snapshot at battle entry, so `battleWalls` includes
   *      the crumbled tiles and the wall-debris pipeline renders rubble
   *      on them for the rest of the battle (matches normal grunt-
   *      destruction behaviour).
   *   2. The renderer fades walls 1→0 + cross-fades wall-debris 0→1
   *      during the post-banner reveal window via
   *      `overlay.battle.crumblingWallsFade` + `heldDestroyedWalls`.
   *
   *  `damaged` is captured per wall so the wall manager picks the
   *  matching (mask, damaged) geometry bucket for reinforced-wall
   *  absorbed-hit state during the fade. null when no crumbling_walls
   *  reveal is in flight; cleared at the NEXT round's
   *  `prepareBattleState` (so the held set persists through battle,
   *  wall-build, and the next cannon-place phase). */
  crumblingWallsHeld:
    | readonly {
        playerId: ValidPlayerSlot;
        tileKey: number;
        damaged: boolean;
      }[]
    | null;
}

/** Player selection lobby state. */
export interface LobbyState {
  joined: boolean[];
  active: boolean;
  /** Accumulator for lobby countdown timer (local play). */
  timerAccum?: number;
  /** Pre-computed seed for the next game (also used for lobby map preview). */
  seed: number;
  map: GameMap | null;
  /** Online-only: the server-assigned room seed shown in the options modal.
   *  Set on showWaitingRoom, cleared on quit-to-menu. Distinct from `seed`
   *  (which is always a number, including the initial 0) so the renderer
   *  can show "—" before a room exists without colliding with a server-
   *  assigned seed of 0. */
  roomSeedDisplay: number | null;
}

/** Per-player state during castle selection (highlighted tower, confirm status). */
export interface SelectionState {
  highlighted: number;
  confirmed: boolean;
  /** True once the user has tapped/clicked the highlighted tower once,
   *  enabling confirmation on the second tap. Reset on pointer-move to a
   *  different tower. Used by touch input to require a deliberate double-tap. */
  towerAlreadyHighlighted?: boolean;
}

export interface FrameContext {
  // Identity
  readonly myPlayerId: PlayerSlotId;
  /** Point-of-view player for camera, sound, and haptics.
   *  Online: myPlayerId. Local: pointer player slot. Demo: 0. */
  readonly povPlayerId: ValidPlayerSlot;
  readonly hostAtFrameStart: boolean;
  /** Non-local player slots. See OnlineSession.remotePlayerSlots for full docs. */
  readonly remotePlayerSlots: ReadonlySet<ValidPlayerSlot>;

  // Mode / Phase
  readonly mode: Mode;
  readonly phase: Phase;

  /** True when the current game phase is BATTLE. */
  readonly inBattle: boolean;

  // Overlay flags
  readonly paused: boolean;
  readonly quitPending: boolean;
  readonly hasLifeLostDialog: boolean;
  readonly isSelectionReady: boolean;
  /** True when the local human player is in the reselect queue. */
  readonly humanIsReselecting: boolean;

  // Player presence
  /** True when a local human player exists and is not eliminated.
   *  Gates auto-zoom, crosshair rendering, and combo floating text. */
  readonly hasPointerPlayer: boolean;

  // Composite guards
  /** UI overlay suppresses gameplay (pause, quit dialog, life-lost). */
  readonly uiBlocking: boolean;
  /** Phase timer about to expire (< PHASE_ENDING_THRESHOLD) on non-touch. */
  readonly phaseEnding: boolean;
  /** Camera should unzoom (uiBlocking OR phaseEnding). */
  readonly shouldUnzoom: boolean;
  /** Non-interactive transition — camera suppresses auto-zoom. */
  readonly isTransition: boolean;
}

/** Pack `(playerId, cannonIdx)` into a single number for the
 *  `pendingCannonFires` Set. The multiplier is large enough to avoid
 *  collisions across realistic per-player cannon counts. */
const MAX_CANNON_SLOT_KEY = 256;

/** Pack a `(playerId, cannonIdx)` pair into the key shape used by
 *  `state.pendingCannonFires`. */
export function packPendingCannonFireKey(
  playerId: number,
  cannonIdx: number,
): number {
  return playerId * MAX_CANNON_SLOT_KEY + cannonIdx;
}

/** Set gameMode, activeFeatures, and modern atomically — prevents divergence. */
export function setGameMode(state: GameState, mode: GameMode): void {
  state.gameMode = mode;
  state.activeFeatures =
    mode === GAME_MODE_MODERN ? MODERN_FEATURES : EMPTY_FEATURES;
  state.modern =
    mode === GAME_MODE_MODERN ? (state.modern ?? createModernState()) : null;
}

/** Check if a feature capability is active for this match. */
export function hasFeature(state: GameState, feature: FeatureId): boolean {
  return state.activeFeatures.has(feature);
}

/** Create a fresh ModernState with all fields at their initial null values. */
function createModernState(): ModernState {
  return {
    activeModifier: null,
    activeModifierChangedTiles: [],
    lastModifierId: null,
    masterBuilderLockout: 0,
    masterBuilderOwners: null,
    comboTracker: null,
    pendingUpgradeOffers: null,
    precomputedUpgradePicks: null,
    frozenTiles: null,
    sinkholeTiles: null,
    highTideTiles: null,
    lowWaterTiles: null,
    chippedGrunts: null,
    precomputedDustStormJitters: [],
    rubbleClearingHeld: null,
    crumblingWallsHeld: null,
  };
}
