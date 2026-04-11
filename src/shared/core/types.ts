/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { Rng } from "../platform/rng.ts";
import type { Mode } from "../ui/ui-mode.ts";
import type {
  BurningPit,
  Cannonball,
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
   *  Host: computed by advancePhaseTimer() as `timer = max - elapsed`, where elapsed
   *  is accumulated in TimerAccums per frame. This is the authoritative source.
   *
   *  Watcher: recomputed each frame as `timer = phaseDuration - (now - phaseStart)`,
   *  using wall-clock time since the watcher doesn't run the host tick loop.
   *  Both converge to the same value but the computation path differs by role.
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
  /** Players who reselected a castle since the last cannon phase setup. */
  reselectedPlayers: Set<number>;
  /** Zone index assigned to each player (indexed by player id). Set at game start. */
  playerZones: number[];
  /** Cannon slot limits per player for the current cannon phase.
   *  Computed by computeCannonLimitsForPhase at CANNON_PLACE start.
   *  Phase-dependent: only meaningful when `state.phase === Phase.CANNON_PLACE`.
   *  Always guard: `if (state.phase === Phase.CANNON_PLACE) { ... state.cannonLimits ... }` */
  cannonLimits: number[];
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
   *  Generated in enterBuildFromBattle using synced RNG, consumed by the upgrade pick dialog.
   *  null before UPGRADE_FIRST_ROUND. */
  pendingUpgradeOffers: Map<ValidPlayerSlot, UpgradeOfferTuple> | null;
  /** Frozen river tiles (packed tile keys) — water tiles that grunts can cross.
   *  Set during battle when frozen_river modifier is active, null otherwise. */
  frozenTiles: Set<number> | null;
  /** Sinkhole tiles (packed tile keys) — grass tiles permanently converted to water.
   *  Cumulative across rounds. null = no sinkholes yet. */
  sinkholeTiles: Set<number> | null;
  /** High tide tiles (packed tile keys) — grass tiles temporarily flooded.
   *  Set when high_tide modifier fires, cleared at next battle start. null otherwise. */
  highTideTiles: Set<number> | null;
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
    lastModifierId: null,
    masterBuilderLockout: 0,
    masterBuilderOwners: null,
    comboTracker: null,
    pendingUpgradeOffers: null,
    frozenTiles: null,
    sinkholeTiles: null,
    highTideTiles: null,
  };
}
