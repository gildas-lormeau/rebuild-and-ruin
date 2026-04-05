/**
 * Core types, interfaces, and constants for the game engine.
 */

import type {
  BurningPit,
  Cannon,
  Cannonball,
  CapturedCannon,
} from "./battle-types.ts";
import {
  GAME_MODE_MODERN,
  type GameMode,
  type ModifierId,
} from "./game-constants.ts";
import type { Phase } from "./game-phase.ts";
import type { Castle, GameMap, TilePos, Tower } from "./geometry-types.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "./player-slot.ts";
import type { Rng } from "./rng.ts";
import type { Mode } from "./ui-mode.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

/** Branded number proving a value was produced by packTile(row, col).
 *  Assignable to `number` (so existing Set<number> / Map<number,…> still work),
 *  but a raw number literal cannot be assigned to TileKey without packTile().
 *  Use packTile() to create, unpackTile() to destructure back to row/col. */
export type TileKey = number & { readonly __brand: "TileKey" };

/** Branded ReadonlySet<number> proving that interior was recomputed after the
 *  last wall mutation. Only produced by `markInteriorFresh` (board-occupancy)
 *  and `emptyFreshInterior` (initial construction / deserialization).
 *  Consumers can read `.has()` / `.size` / iterate freely — the brand carries
 *  through because FreshInterior extends ReadonlySet<number>. */
export type FreshInterior = ReadonlySet<number> & {
  readonly __brand: "FreshInterior";
};

export interface Player {
  id: ValidPlayerSlot;
  /** The tower this player selected as home castle. */
  homeTower: Tower | null;
  /** The castle built around the home tower. */
  castle: Castle | null;
  /** All towers currently enclosed by this player's walls. */
  ownedTowers: Tower[];
  /** Wall tiles owned by this player (row,col pairs encoded as row*COLS+col).
   *  ReadonlySet at the type level — mutations must go through board-occupancy
   *  helpers (addPlayerWall, clearPlayerWalls, etc.) which maintain epoch tracking. */
  walls: ReadonlySet<number>;
  /** All tiles fully enclosed by walls (flood-fill). Used for territory scoring,
   *  cannon placement eligibility, and grunt blocking. Encoded as row*COLS+col.
   *  Branded as FreshInterior — only recomputeInterior(), resetCastle(),
   *  and checkpoint deserialization may write to it. */
  interior: FreshInterior;
  /** Cannon positions (top-left tile of 2x2 cannon). */
  cannons: Cannon[];
  /** Lives remaining (starts at 3, lose 1 when failing to enclose any tower). */
  lives: number;
  /** Whether the player is eliminated (lives reached 0 and didn't continue). */
  eliminated: boolean;
  /** Accumulated territory points (scoring). */
  score: number;
  /** Default cannon facing (radians, 0 = up) — toward enemies, set at castle creation. */
  defaultFacing: number;
  /** Wall tiles forming the home castle perimeter (from castle construction).
   *  Used for tower revival and rebuild. Distinct from interior — these are wall
   *  tiles, not enclosed grass. Includes clumsy extras; protected from debris sweep. */
  castleWallTiles: ReadonlySet<number>;
  /** Active upgrades for this player (modern mode only). Key = upgrade id, value = stack count. */
  upgrades: Map<UpgradeId, number>;
  /** Wall tiles that have absorbed one hit (reinforced walls upgrade).
   *  Cleared at build phase start. Second hit destroys normally. */
  damagedWalls: Set<number>;
}

export interface Grunt extends TilePos {
  /** The player whose territory this grunt is attacking. Grunts are ownerless hazards. */
  victimPlayerId: ValidPlayerSlot;
  /** Locked target tower index. Stays until the tower is destroyed. */
  targetTowerIdx?: number;
  /** Countdown (seconds) before killing an adjacent tower or wall. Starts at 3 when adjacent. */
  attackTimer?: number;
  /** Number of consecutive battles the grunt has been blocked (not adjacent to target tower).
   *  Initialized to 0 at spawn; incremented by updateGruntBlockedBattles at end of each battle. */
  blockedBattles: number;
  /** If true, this grunt is attacking a wall tile during battle (decided at battle start). */
  wallAttack?: boolean;
  /** Facing angle in radians (snapped to 90°). 0 = up. */
  facing?: number;
}

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
  balloonHits: Map<Cannon, { count: number; capturerIds: number[] }>;
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
  /** Game mode: classic (original rules) or modern (environmental modifiers). Immutable for the match. */
  gameMode: GameMode;
  /** Modern-mode state (modifiers, combos, upgrades, terrain effects).
   *  null in classic mode — guard with `if (state.modern)` at entry points.
   *  Inner fields carry phase-specific nullability (e.g. frozenTiles is null between battles). */
  modern: ModernState | null;
}

/** Upgrade offer triple — 3 unique upgrade choices offered to a player. */
export type UpgradeOfferTuple = [UpgradeId, UpgradeId, UpgradeId];

/** State exclusive to modern mode. null on GameState in classic mode. */
/** Floating combo text event — aged by the renderer, removed when expired. */
export interface ComboEvent {
  text: string;
  age: number;
  playerId: ValidPlayerSlot;
}

export interface ModernState {
  /** Active modifier for the current round. null = none this round. */
  activeModifier: ModifierId | null;
  /** Previous round's modifier id (for no-repeat rule). null = none. */
  lastModifierId: ModifierId | null;
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
  readonly remoteHumanSlots: ReadonlySet<number>;

  // Mode / Phase
  readonly mode: Mode;
  readonly phase: Phase;

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

export interface BonusSquare extends TilePos {
  zone: number;
}

/** Set gameMode and modern atomically — prevents divergence between the two fields. */
export function setGameMode(state: GameState, mode: GameMode): void {
  state.gameMode = mode;
  state.modern =
    mode === GAME_MODE_MODERN ? (state.modern ?? createModernState()) : null;
}

/** Create a fresh ModernState with all fields at their initial null values. */
export function createModernState(): ModernState {
  return {
    activeModifier: null,
    lastModifierId: null,
    comboTracker: null,
    pendingUpgradeOffers: null,
    frozenTiles: null,
  };
}

/** Create a branded empty interior set. Use at Player creation. */
export function emptyFreshInterior(): FreshInterior {
  return new Set<number>() as unknown as FreshInterior;
}

/** Brand an existing set as fresh interior. Use at checkpoint
 *  deserialization where the set is constructed from trusted data. */
export function brandFreshInterior(set: ReadonlySet<number>): FreshInterior {
  return set as FreshInterior;
}

/** Type guard: player exists and is not eliminated.
 *  Use this instead of the `!player || player.eliminated` pattern. */
export function isPlayerAlive(
  player: Player | null | undefined,
): player is Player {
  return !!player && !player.eliminated;
}

/** True when a player has selected a castle and can actively participate. */
export function isPlayerSeated(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
}
