/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { Rng } from "../platform/rng.ts";
import type { ImpactEvent } from "./battle-events.ts";
import type {
  BurningPit,
  Cannon,
  Cannonball,
  CannonMode,
  CapturedCannon,
  Grunt,
} from "./battle-types.ts";
import type { LifeLostChoiceOverride } from "./dialog-state.ts";
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
import type {
  BonusSquare,
  CannonIdx,
  GameMap,
  TowerIdx,
} from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type {
  RubbleClearingHeld,
  SerializedModifierTiles,
  SupplyBonusId,
  SupplyShip,
} from "./modifier-defs.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { GameOwned, Player } from "./player-types.ts";
import type { UpgradeId } from "./upgrade-defs.ts";
import type { ZoneId } from "./zone-id.ts";

/** Current round number (1-based) — game-owned. The field is `readonly` so
 *  `++` / `=` are compile errors (branding alone misses `++`); writes go via
 *  `initialRound` (creation), `advanceRound` (round-end), or `restoreRound`
 *  (checkpoint). Stops the raw `state.round++` the runtime phase machine used
 *  to perform inline. */
export type Round = GameOwned<number, "Round">;

/** Cannonballs fired this battle round — game-owned. `readonly` (mutated via
 *  `++`, which branding alone misses). Indexes `precomputedDustStormJitters`,
 *  so a stray write silently desyncs dust-storm jitter cross-peer. Writes via
 *  `initialShotsFired` / `incrementShotsFired` / `resetShotsFired` /
 *  `restoreShotsFired`. */
export type ShotsFired = GameOwned<number, "ShotsFired">;

/** Match-lifetime grunt-spawn rotation counter — game-owned. `readonly`;
 *  monotonic (never reset — see the field doc), drives synced spawn-tile
 *  rotation, so a stray write desyncs grunt placement. Writes via
 *  `initialGruntSpawnSeq` / `nextGruntSpawnSeq` / `restoreGruntSpawnSeq`. */
export type GruntSpawnSeq = GameOwned<number, "GruntSpawnSeq">;

/** Writable view of the game-owned GameState scalar fields — the producers
 *  cast through it for the one blessed write. Mirrors `MutableAccums` /
 *  `WritableRuleFields`. */
type WritableGameOwned = {
  -readonly [K in "round" | "shotsFired" | "gruntSpawnSeq"]: GameState[K];
};

export interface GameState {
  /** Optional runtime-instance label for cross-runtime debugging.
   *  Set by test scenarios (HOST/WATCHER for `network-setup.ts`,
   *  LOCAL for `scenario.ts`) so capture-point traces from
   *  `scripts/debug` can attribute interleaved frames to the runtime
   *  that produced them. Production code never sets or reads this —
   *  it's pure test/diagnostic infrastructure. Kept on the type so
   *  V8-side capture expressions can reference it without a cast. */
  debugTag?: string;
  /** Test-only filters for modifier rolls + upgrade offers. Honoured by
   *  `rollModifier` (game/modifier-system.ts) and `drawOffers`
   *  (game/upgrade-system.ts). Set by `createScenario` from `ScenarioOptions`
   *  after bootstrap, mirrored on every peer so host/watcher stay in sync.
   *  Never serialized in the wire format — checkpoint roundtrips drop it,
   *  but tests set it at boot so that's fine. Production code never sets or
   *  reads this. */
  testHooks?: TestHooks;
  /** Shared seeded RNG for deterministic gameplay decisions.
   *  Available methods: .next() → [0,1), .int(lo,hi), .bool(prob),
   *  .pick(arr), .shuffle(arr). See rng.ts for full API. */
  rng: Rng;
  map: GameMap;
  phase: Phase;
  readonly round: Round;
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
  readonly shotsFired: ShotsFired;
  /** Active grunts on the map. */
  grunts: Grunt[];
  /** Match-lifetime counter advanced on each call to
   *  `findGruntSpawnPositions`. Used to rotate the sorted bank (and
   *  edge fallback) by `seq % list.length`, so successive spawn calls
   *  cycle through every candidate tile instead of all seeding at the
   *  closest-to-tower tile. Deliberately NOT reset at round boundaries
   *  — keeping it monotonic prevents the per-round-first spawn from
   *  landing on the same tile every round. */
  readonly gruntSpawnSeq: GruntSpawnSeq;
  /** Per-zone set of bank/edge tiles already used for grunt spawns in
   *  the current round. Acts as a hard guarantee against same-tile
   *  reuse even when grunts walk inland between spawn events (and the
   *  existing-grunt filter no longer blocks the original bank tile).
   *  Cleared at the WALL_BUILD → next-round transition (just before
   *  `state.round++` + ROUND_START) — cross-round reuse is allowed. */
  gruntSpawnUsedTiles: Map<ZoneId, Set<TileKey>>;
  /** Whether each tower is alive (indexed same as map.towers). */
  towerAlive: boolean[];
  /** Dead towers that were enclosed last build phase — revive if still enclosed next build phase. */
  towerPendingRevive: Set<TowerIdx>;
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
  /** Zone index assigned to each player (indexed by player id). Set at game start. */
  playerZones: ZoneId[];
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
  cannonPlaceDone: Set<ValidPlayerId>;
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
  pendingCannonPlaceDone: Set<ValidPlayerId>;
}

/** Upgrade offer triple — 3 unique upgrade choices offered to a player. */
export type UpgradeOfferTuple = [UpgradeId, UpgradeId, UpgradeId];

/** Test-only filters consumed by `rollModifier` and `drawOffers`.
 *
 *  `forceModifier`/`forceUpgrade` short-circuit the RNG-driven draw — when
 *  set, no `state.rng` is consumed at the draw site. That keeps the
 *  override predictable but means subsequent RNG-dependent state (grunt
 *  positions, AI picks) differs vs. an unfiltered scenario. Tests that
 *  care about post-roll RNG should pin them via fixtures instead.
 *
 *  `disabledModifiers`/`disabledUpgrades` exclude IDs from the candidate
 *  pool BEFORE the weighted draw — RNG still consumes from the smaller
 *  pool.
 *
 *  Array-shaped (instead of Set) so the same struct can ride a fixture
 *  JSON via `FixtureFile.testHooks` without a runtime → wire conversion
 *  step. Pool sizes are tiny (≤13 modifiers, ≤19 upgrades), so the
 *  linear `.includes()` lookup is fine. */
export interface TestHooks {
  /** Modifier IDs excluded from the random pool. The roll still consumes
   *  RNG (via `bool` + weighted draw on the remaining candidates). */
  disabledModifiers?: readonly ModifierId[];
  /** When set, `rollModifier` returns this value directly — no RNG draw.
   *  Pass `null` to force "no modifier this round" (bypasses both the
   *  fire-chance roll and the weighted draw). */
  forceModifier?: ModifierId | null;
  /** Upgrade IDs excluded from `drawOffers`. */
  disabledUpgrades?: readonly UpgradeId[];
  /** When set, `drawOffers` returns this id as the first of the 3 offers.
   *  The remaining 2 are drawn normally from the (filtered) pool. */
  forceUpgrade?: UpgradeId;
  /** Force a player's life-lost dialog decision (CONTINUE/ABANDON) instead of
   *  the AI default (always CONTINUE). Consumed at the decision site
   *  (`aiChooseLifeLost`) per `entry.playerId`; fires only when that player
   *  actually reaches a life-loss. Lets a test drive the human ABANDON /
   *  elimination path that no seed can produce. Never serialized. */
  lifeLostChoices?: readonly LifeLostChoiceOverride[];
  /** Pin every alive player's score to the alive maximum at the end of the
   *  given round (consumed in `finalizeRound`, after scoring and before the
   *  game-over peek). Lets a test drive the sudden-death path — an exact
   *  top-score tie at the round limit — that no seed can reliably produce.
   *  Consumes no RNG. Never serialized. */
  equalizeScoresOnRound?: number;
}

/** State exclusive to modern mode. null on GameState in classic mode. */
/** Floating combo event — structured data aged by the renderer, removed when expired.
 *  The render layer formats the display text from `kind`, `streak`, and `bonus`. */
export interface ComboEvent {
  kind: "wall" | "cannon" | "grunt";
  streak: number;
  bonus: number;
  age: number;
  playerId: ValidPlayerId;
}

export interface ModernState {
  /** Active modifier for the current round. null = none this round. */
  activeModifier: ModifierId | null;
  /** Tile keys changed by `activeModifier` (scarred / frozen
   *  tiles depending on the modifier). Populated when the modifier
   *  applies; drives the `MODIFIER_REVEAL` dwell-phase tile pulse in
   *  the render path. Parallel lifecycle to `activeModifier` — cleared
   *  alongside it. Empty array = no changed tiles (or no active
   *  modifier). */
  activeModifierChangedTiles: readonly TileKey[];
  /** Previous round's modifier id (for no-repeat rule). null = none. */
  lastModifierId: ModifierId | null;
  /** Exclusive build-lockout countdown (seconds remaining). 0 = no lockout.
   *  Shared by every source that can grant a head-start this round —
   *  Master Builder ownership AND a sunk supply-ship `extra_build_time`
   *  bonus both set/extend this same countdown (see `onBuildPhaseStart`
   *  in `upgrades/master-builder.ts` and the union in
   *  `enterWallBuildPhase`). Non-owners are locked out of building while
   *  this is > 0. */
  masterBuilderLockout: number;
  /** Players seated in the exclusive build-lockout window this round —
   *  the union of Master Builder owners and supply-ship `extra_build_time`
   *  earners. null = nobody. Persists through the build phase (needed to
   *  compute buildMax for advancePhaseTimer). */
  masterBuilderOwners: ReadonlySet<ValidPlayerId> | null;
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
  pendingUpgradeOffers: Map<ValidPlayerId, UpgradeOfferTuple> | null;
  /** Frozen river tiles (packed tile keys) — water tiles that grunts can cross.
   *  Set during battle when frozen_river modifier is active, null otherwise. */
  frozenTiles: Set<TileKey> | null;
  /** Sinkhole tiles (packed tile keys) — grass tiles permanently converted to water.
   *  Cumulative across rounds. null = no sinkholes yet. */
  sinkholeTiles: Set<TileKey> | null;
  /** Exposed riverbed tiles (packed tile keys) — water tiles the
   *  low_water modifier marks as walkable + visually exposed for one
   *  round. Tile types stay water; the set is the source of truth.
   *  Stored (not derived) because the RNG-shuffled erosion produces
   *  different sets per draw. null when low_water is not active. */
  exposedRiverbedTiles: Set<TileKey> | null;
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
  rubbleClearingHeld: RubbleClearingHeld | null;
  /** Neutral supply ships active during the current battle. Spawned by
   *  the supply_ship modifier's `apply` at battle start; advanced by the
   *  battle tick; sunk by cannonball hits or auto-sunk near battle end.
   *  Cleared back to null at battle end. AIs target these occasionally
   *  (no lead prediction), so the modifier still favours humans who can
   *  time and lead their shots. */
  supplyShips: SupplyShip[] | null;
  /** Per-player queue of one-round supply-ship bonuses pending
   *  consumption. Pushed onto by `tryHitSupplyShip` when a ship sinks
   *  (credited to the cannonball's scoring player); drained by each
   *  bonus type's consumer at the relevant phase entry. Spans round
   *  boundaries (not cleared in the modifier's `clear`) so a sink
   *  late in a battle still benefits the closing/next phase. */
  pendingSupplyBonuses: Map<ValidPlayerId, SupplyBonusId[]> | null;
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
  highlighted: TowerIdx;
  confirmed: boolean;
  /** True once the user has tapped/clicked the highlighted tower once,
   *  enabling confirmation on the second tap. Reset on pointer-move to a
   *  different tower. Used by touch input to require a deliberate double-tap. */
  towerAlreadyHighlighted: boolean;
}

/** Result shape returned by every modifier's apply function. */
interface ModifierApplyResult {
  readonly changedTiles: readonly TileKey[];
  readonly gruntsSpawned: number;
  /** Optional grunt-spawn requests for the orchestrator to execute AFTER
   *  apply() returns. Lets deep-logic modifiers (grunt-surge) stay below
   *  grunt-system in the import graph: the modifier returns descriptors
   *  carrying any RNG-consumed planning decisions, then phase-setup runs
   *  spawnGruntSurgeOnZone per request. The orchestrator merges resulting
   *  spawn tiles + counts into the returned ModifierDiff so the reveal
   *  banner pulse and grunts-spawned banner stay correct. */
  readonly spawnRequests?: readonly ModifierSpawnRequest[];
}

/** A request to spawn grunts on a player's zone, emitted by a modifier's
 *  apply() for the orchestrator to execute. */
export interface ModifierSpawnRequest {
  readonly playerId: ValidPlayerId;
  readonly count: number;
}

/** Hooks shared across all lifecycle variants. */
interface ModifierImplBase {
  /** Apply the modifier at battle start. */
  apply(state: GameState): ModifierApplyResult;
  /** Opt-out flag: set `true` ONLY when the modifier provably leaves
   *  walls and tile passability untouched (no map mutation, no wall
   *  destruction, no grunt enclosure changes). The default — recheck —
   *  matches the watcher's `applyBattleStartCheckpoint`, which always
   *  recomputes territory after restoring modifier tiles. Forgetting to
   *  opt out is harmless (one extra recheck); forgetting to opt IN to a
   *  recheck on a tile-mutating modifier would silently desync host vs
   *  watcher territory. Default-on closes that footgun. */
  skipsRecheck?: true;
  /** Drop modifier-owned state at the lifecycle's expiry point. Required on
   *  round-scoped (narrowed below); optional on instant (most instant
   *  modifiers have nothing to clean up); not used on permanent. Timing is
   *  derived from `lifecycle`:
   *   - `instant`     → fires at BATTLE_END (from `finalizeBattle`)
   *   - `round-scoped` → fires at next CANNON_PLACE-done (from
   *                      `clearActiveModifiers` in `prepareBattleState`)
   *   - `permanent`   → never fires (state persists across rounds) */
  clear?(state: GameState): void;
  /** Optional post-battle diagnostic trace. Returns a one-line summary of
   *  what the modifier resolved to this battle (e.g. supply-ship bonuses
   *  awarded), logged generically by the `battle-done` transition via
   *  `describeModifierResolution`. Log-only — must never mutate state, so
   *  it can't affect cross-peer parity. Omit when the modifier has nothing
   *  interesting to trace. */
  resolutionLog?(state: GameState): string | null;
}

/** Instant modifier: side effects flow through normal game state at
 *  apply-time. No persistent modifier-owned state to clean up. */
interface InstantModifier extends ModifierImplBase {
  readonly lifecycle: "instant";
}

/** Permanent modifier: tile-mutating state survives until the next modifier
 *  rolls (or, for permanent map mutations, forever). `restore` is required
 *  because the watcher rebuilds the map from seed and must reapply the
 *  mutation. Modifiers are global — life loss / zone teardown does not
 *  touch their state. */
interface PermanentModifier extends ModifierImplBase {
  readonly lifecycle: "permanent";
  /** Restore tile-mutating state from checkpoint data and re-apply tile
   *  mutations on a map regenerated from seed. */
  restore(state: GameState, data: SerializedModifierTiles): void;
}

/** Round-scoped modifier: active from this round's BATTLE through next
 *  CANNON_PLACE, cleared just before the next modifier rolls. Global —
 *  life loss / zone teardown does not touch their state. */
interface RoundScopedModifier extends ModifierImplBase {
  readonly lifecycle: "round-scoped";
  /** Revert per-modifier state at next round's CANNON_PLACE-done.
   *  Idempotent. */
  clear(state: GameState): void;
  /** Restore tile-mutating state from checkpoint data and re-apply tile
   *  mutations on a map regenerated from seed. Optional — only needed
   *  when the modifier carries serializable state (see `needsCheckpoint`
   *  in modifier-defs.ts). */
  restore?(state: GameState, data: SerializedModifierTiles): void;
}

/** Discriminated union of all modifier impls. The `lifecycle` field
 *  tags each variant and the type system enforces that the right hooks
 *  are present (e.g. `clear` is required iff `lifecycle === "round-scoped"`). */
export type ModifierImpl =
  | InstantModifier
  | PermanentModifier
  | RoundScopedModifier;

/** Respawn target returned by onGruntKilled. Anchor coords are the victim's
 *  home tower — the caller runs findGruntSpawnNear from there. */
export interface ConscriptionRespawnTarget {
  readonly victimId: ValidPlayerId;
  readonly anchorRow: number;
  readonly anchorCol: number;
}

/** A bounce position yielded by an `onImpactResolved` upgrade hook. The
 *  battle-system orchestrator consumes these from the generator one at a
 *  time, applying impact + dedup between yields so the upgrade's
 *  per-bounce RNG draws remain interleaved with battle-system's
 *  per-impact RNG draws (preserves determinism vs the old applyBounce
 *  callback shape). */
export interface BounceDescriptor {
  readonly row: number;
  readonly col: number;
}

/** Helpers from cannon-system that battle-start hooks need. Injected by
 *  phase-setup.ts so the dispatcher doesn't have to import from
 *  cannon-system (cycle avoidance). */
export interface BattleStartCannonDeps {
  readonly filterActiveFiringCannons: (player: Player) => Cannon[];
  readonly isCannonEnclosed: (cannon: Cannon, player: Player) => boolean;
  readonly homeEnclosedRegion: (player: Player) => Set<TileKey>;
}

/** Implementation hooks for a single upgrade. All hooks are optional —
 *  upgrades only implement the hooks relevant to their mechanic.
 *  Dispatchers in upgrade-system.ts iterate the registry and call each
 *  hook with the appropriate aggregation strategy. */
export interface UpgradeImpl {
  /* ── Pick-time ─────────────────────────────────────────────── */

  /** One-shot effect applied when this upgrade is picked. Registry lookup
   *  by choice ID means no UID guard is needed inside the implementation. */
  onPick?: (state: GameState, player: Player) => void;

  /* ── Phase lifecycle ───────────────────────────────────────── */

  /** Configure state at build phase start (e.g. lockout timers). */
  onBuildPhaseStart?: (state: GameState) => void;
  /** Run elections/configuration at battle phase start (e.g. mortar pick). */
  onBattlePhaseStart?: (state: GameState, deps: BattleStartCannonDeps) => void;
  /** Advance timers each build frame. */
  tickBuild?: (state: GameState, dt: number) => void;

  /* ── Event hooks ───────────────────────────────────────────── */

  /** Side effects after a piece is placed. */
  onPiecePlaced?: (
    state: GameState,
    player: Player,
    pieceKeys: ReadonlySet<TileKey>,
  ) => void;
  /** Post-impact follow-ups (e.g. ricochet bounces). Generator yields each
   *  bounce position; the orchestrator applies impact + emits between
   *  yields so the upgrade's RNG draws stay interleaved with any
   *  applyImpactEvent RNG draws (HOUSE_CRUSHED → grunt-spawn roll). */
  onImpactResolved?: (
    state: GameState,
    shooterId: ValidPlayerId,
    hitRow: number,
    hitCol: number,
    initialImpactEvents: readonly ImpactEvent[],
  ) => Generator<BounceDescriptor, void> | undefined;
  /** Query for a grunt respawn target after a kill. First non-null wins.
   *  `killedGruntTile` is the packed tile of the dead grunt — a board-independent
   *  per-kill discriminator for the R5b derived respawn roll. */
  onGruntKilled?: (
    state: GameState,
    shooterId: ValidPlayerId,
    killedGruntTile: number,
  ) => ConscriptionRespawnTarget | null;
  /** Side effects after a cannon kill (e.g. salvage slots). */
  onCannonKilled?: (state: GameState, shooterId: ValidPlayerId) => void;
  /** Side effects after a cannon is placed (e.g. consume one-shot upgrades).
   *  Runs from both originator (synchronous + scheduled drain) and receiver
   *  (scheduled drain) paths via `applyCannonAtDrain` / `placeCannon`.
   *  No state param so callers with the narrow `CannonViewState` shape can
   *  dispatch without a cast. Widen if a future consumer needs state —
   *  none today. */
  onCannonPlaced?: (player: Player, mode: CannonMode) => void;

  /* ── Query hooks (aggregated by dispatchers) ───────────────── */

  /** True → skip battle this round (boolean OR). */
  shouldSkipBattle?: (state: GameState) => boolean;
  /** False → block this player's build tick (boolean AND). */
  canPlayerBuild?: (state: GameState, playerId: ValidPlayerId) => boolean;
  /** Extra build seconds (additive). */
  buildTimerBonus?: (state: GameState) => number;
  /** True → wall survives this hit (boolean OR). */
  shouldAbsorbWallHit?: (player: Player, tileKey: TileKey) => boolean;
  /** Territory score multiplier (multiplicative). */
  territoryScoreMult?: (player: Player) => number;
  /** Extra cannon slots (additive). */
  cannonSlotsBonus?: (player: Player) => number;
  /** True → draw from small-piece pool (boolean OR). */
  useSmallPieces?: (player: Player) => boolean;
  /** Own-wall tiles allowed to overlap per piece (additive). */
  wallOverlapAllowance?: (player: Player) => number;
  /** True → pieces may cover burning pits (boolean OR). */
  canPlaceOverBurningPit?: (player: Player) => boolean;
  /** True → pieces may cover grunts (boolean OR). Takes the players array
   *  because global upgrades (Entomb) need access to every owner. */
  canPlaceOverGrunt?: (players: readonly Player[], player: Player) => boolean;
}

/** Pack `(playerId, cannonIdx)` into a single number for the
 *  `pendingCannonFires` Set. The multiplier is large enough to avoid
 *  collisions across realistic per-player cannon counts. */
const MAX_CANNON_SLOT_KEY = 256;

/** Pack a `(playerId, cannonIdx)` pair into the key shape used by
 *  `state.pendingCannonFires`. */
export function packPendingCannonFireKey(
  playerId: ValidPlayerId,
  cannonIdx: CannonIdx,
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

/** Round number for a freshly created game (round 1). */
export function initialRound(): Round {
  return brandRound(1);
}

/** Advance to the next round. The sole in-game producer of an incremented
 *  `Round` — replaces the raw `state.round++` that the runtime phase machine
 *  used to perform inline (`round` is `readonly`, so even `++` is now a
 *  compile error). Writes through the blessed `WritableGameOwned` cast. */
export function advanceRound(state: GameState): void {
  (state as WritableGameOwned).round = brandRound(state.round + 1);
}

/** Restore the round from trusted checkpoint data (post-construction write at
 *  the deserialize boundary). Takes a plain number so callers needn't import
 *  `Round`. */
export function restoreRound(state: GameState, value: number): void {
  (state as WritableGameOwned).round = brandRound(value);
}

/** Shots-fired counter for a freshly created game (0). */
export function initialShotsFired(): ShotsFired {
  return brandShotsFired(0);
}

/** Increment the battle's shots-fired counter (one cannonball launched). */
export function incrementShotsFired(state: GameState): void {
  (state as WritableGameOwned).shotsFired = brandShotsFired(
    state.shotsFired + 1,
  );
}

/** Reset the shots-fired counter at battle start. */
export function resetShotsFired(state: GameState): void {
  (state as WritableGameOwned).shotsFired = brandShotsFired(0);
}

/** Restore shots-fired from trusted checkpoint data. */
export function restoreShotsFired(state: GameState, value: number): void {
  (state as WritableGameOwned).shotsFired = brandShotsFired(value);
}

/** Grunt-spawn rotation counter for a freshly created game (0). */
export function initialGruntSpawnSeq(): GruntSpawnSeq {
  return brandGruntSpawnSeq(0);
}

/** Return the current grunt-spawn sequence number and advance it (post-
 *  increment semantics — replaces `state.gruntSpawnSeq++`). The sole in-game
 *  producer of an advanced counter. */
export function nextGruntSpawnSeq(state: GameState): number {
  const seq = state.gruntSpawnSeq;
  (state as WritableGameOwned).gruntSpawnSeq = brandGruntSpawnSeq(seq + 1);
  return seq;
}

/** Restore the grunt-spawn counter from trusted checkpoint data. */
export function restoreGruntSpawnSeq(state: GameState, value: number): void {
  (state as WritableGameOwned).gruntSpawnSeq = brandGruntSpawnSeq(value);
}

/** Max cannon slots a player may place this CANNON_PLACE phase, defaulting
 *  to 0 for an absent/sparse slot. The single source of truth for the
 *  empty-slot semantics — only meaningful while
 *  `state.phase === Phase.CANNON_PLACE` (see the `cannonLimits` field).
 *  Takes the structural slice so both `GameState` and the decoupled
 *  `CannonViewState` controllers can call it. */
export function cannonSlotsFor(
  state: { readonly cannonLimits: readonly number[] },
  playerId: ValidPlayerId,
): number {
  return state.cannonLimits[playerId] ?? 0;
}

/** Mint a `Round` — module-private; all field writes go through the producers
 *  above via the `WritableGameOwned` cast (the field is `readonly`). */
function brandRound(value: number): Round {
  return value as Round;
}

/** Mint a `ShotsFired` — module-private (see `brandRound`). */
function brandShotsFired(value: number): ShotsFired {
  return value as ShotsFired;
}

/** Mint a `GruntSpawnSeq` — module-private (see `brandRound`). */
function brandGruntSpawnSeq(value: number): GruntSpawnSeq {
  return value as GruntSpawnSeq;
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
    frozenTiles: null,
    sinkholeTiles: null,
    exposedRiverbedTiles: null,
    precomputedDustStormJitters: [],
    rubbleClearingHeld: null,
    supplyShips: null,
    pendingSupplyBonuses: null,
  };
}
