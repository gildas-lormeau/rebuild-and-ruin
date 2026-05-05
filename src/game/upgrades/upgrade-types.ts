/** Shared types for upgrade implementations. */

import type { ImpactEvent } from "../../shared/core/battle-events.ts";
import type { Cannon } from "../../shared/core/battle-types.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import type { Player } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";

/** Respawn target returned by onGruntKilled. Anchor coords are the victim's
 *  home tower — the caller runs findGruntSpawnNear from there. */
export interface ConscriptionRespawnTarget {
  readonly victimId: ValidPlayerSlot;
  readonly anchorRow: number;
  readonly anchorCol: number;
}

/** Dedup key set: identifies cannons already damaged in a ricochet chain. */
export type RicochetHitSet = Set<string>;

/** Callback supplied by battle-system to apply an impact at a bounce position.
 *  Receives the same hitCannons set on every call so the caller can skip
 *  cannon events for cannons already hit earlier in the chain. */
export type RicochetApplyBounce = (
  row: number,
  col: number,
  hitCannons: RicochetHitSet,
) => void;

/** Helpers from cannon-system that battle-start hooks need. Injected by
 *  phase-setup.ts so the dispatcher doesn't have to import from
 *  cannon-system (cycle avoidance). */
export interface BattleStartCannonDeps {
  readonly filterActiveFiringCannons: (player: Player) => Cannon[];
  readonly isCannonEnclosed: (cannon: Cannon, player: Player) => boolean;
  readonly homeEnclosedRegion: (player: Player) => Set<number>;
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
    pieceKeys: ReadonlySet<number>,
  ) => void;
  /** Post-impact follow-ups (e.g. ricochet bounces). */
  onImpactResolved?: (
    state: GameState,
    shooterId: ValidPlayerSlot,
    hitRow: number,
    hitCol: number,
    initialImpactEvents: readonly ImpactEvent[],
    applyBounce: RicochetApplyBounce,
  ) => void;
  /** Query for a grunt respawn target after a kill. First non-null wins. */
  onGruntKilled?: (
    state: GameState,
    shooterId: ValidPlayerSlot,
  ) => ConscriptionRespawnTarget | null;
  /** Side effects after a cannon kill (e.g. salvage slots). */
  onCannonKilled?: (state: GameState, shooterId: ValidPlayerSlot) => void;
  /** Side effects after a cannon is placed (e.g. consume one-shot upgrades).
   *  Runs from both originator (synchronous + scheduled drain) and receiver
   *  (scheduled drain) paths via `applyCannonAtDrain` / `placeCannon`.
   *  Player-only signature (no state) so callers with the narrow
   *  `CannonViewState` shape can dispatch without a cast. Widen if a future
   *  consumer needs state — none today. */
  onCannonPlaced?: (player: Player) => void;

  /* ── Query hooks (aggregated by dispatchers) ───────────────── */

  /** True → skip battle this round (boolean OR). */
  shouldSkipBattle?: (state: GameState) => boolean;
  /** False → block this player's build tick (boolean AND). */
  canBuildThisFrame?: (state: GameState, playerId: ValidPlayerSlot) => boolean;
  /** Extra build seconds (additive). */
  buildTimerBonus?: (state: GameState) => number;
  /** True → wall survives this hit (boolean OR). */
  shouldAbsorbWallHit?: (player: Player, tileKey: number) => boolean;
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
