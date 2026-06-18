/**
 * DefaultStrategy class — production implementation of `AiStrategy`.
 * The interface lives in ai-strategy-types.ts so phase modules can
 * import it without pulling in this file's dep tree. Personality
 * rolling lives in ai-personality-roll.ts.
 */

import type {
  AiPersonality,
  ArchetypeId,
} from "../shared/core/ai-personality.ts";
import type {
  GameMap,
  PixelPos,
  TilePos,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import type { FireOrigin } from "./ai-battle-diag.ts";
import type { AiPlacement } from "./ai-build-types.ts";
import { CHAIN, type ChainType, TACTIC, type TacticId } from "./ai-chain.ts";
import { planCharitySweep } from "./ai-plan-charity-sweep.ts";
import {
  pickWeightedTargetEnemy,
  planDenyEnclosure,
} from "./ai-plan-deny-enclosure.ts";
import { planFatBreach } from "./ai-plan-fat-breach.ts";
import { planGruntSweep } from "./ai-plan-grunt-sweep.ts";
import { planIceTrench } from "./ai-plan-ice-trench.ts";
import { planMaxRepairCost } from "./ai-plan-max-repair-cost.ts";
import { planPocketDestruction } from "./ai-plan-pocket-destruction.ts";
import { planStructuralHit } from "./ai-plan-structural-hit.ts";
import { planSuperAttack } from "./ai-plan-super-attack.ts";
import { planWallDemolition } from "./ai-plan-wall-demolition.ts";
import {
  type BattleTargetMemory,
  countUsableCannons,
  pickTarget,
  type ShotKey,
  trackShot,
} from "./ai-strategy-battle.ts";
import { pickPlacement } from "./ai-strategy-build.ts";
import {
  autoSelectTower,
  createCannonPlacementContext,
  nextCannonPlacement,
} from "./ai-strategy-cannon.ts";
import type {
  AiStrategy,
  BattlePlan,
  CannonPlacement,
  CannonPlacementContext,
  StrategicPixelPos,
} from "./ai-strategy-types.ts";
import { traitLookup } from "./ai-utils.ts";

/** Shared empty exclusion set `planBattle` falls back to when the entry call
 *  omits the param (no allocation per battle). Entry-vs-replan is flagged by
 *  the param being omitted, NOT by set emptiness — a re-plan after a
 *  defensive-only chain legitimately passes an empty set. */
const EMPTY_TACTICS: ReadonlySet<TacticId> = new Set();
/** Chance to focus all fire on the weakest enemy for the entire battle. */
const FOCUS_FIRE_PROBABILITY = 0.5;
/** Minimum usable cannons required to attempt any chain attack. */
const CHAIN_ATTACK_MIN_CANNONS = 6;
/** Chance to help an overwhelmed enemy by sweeping grunts on their territory. */
const CHARITY_SWEEP_PROBABILITY = 1 / 10;
/** Chance to launch a connected-wall demolition chain attack. */
const WALL_DEMOLITION_PROBABILITY = 1 / 3;
/** Chance to launch a strided (every-other-tile) wall demolition attack. */
const SUPER_ATTACK_PROBABILITY = 1 / 8;
/** Chance to attempt a structural hit (break 2+ enclosures in 1–2 shots). */
const STRUCTURAL_HIT_PROBABILITY = 1 / 2;
/** Chance to attempt a diagonal fat-wall breach (drill through a ≥3-thick wall body). */
const FAT_BREACH_PROBABILITY = 1 / 4;
/** Chance to launch a min-cut enclosure-denial siege — the top-priority
 *  offensive tactic, since enclosure denial (not tower kills) is how defensive
 *  players actually lose lives. Scales with battleTactics. */
const DENY_ENCLOSURE_PROBABILITY = 3 / 4;
/** Chance to launch a re-enclosure-cost-maximising "rubble siege" — a wide
 *  open-field breach that makes the defender's cheapest ring expensive to
 *  rebuild, rather than minimising the cut like deny_enclosure. Prototype: tier
 *  2/3 only, and placed BEFORE deny in the cascade so it draws comparable
 *  samples (deny still fires the remaining share + when this planner returns
 *  null), letting the efficiency / re-enclosure-cost metric compare the two. */
const MAX_REPAIR_COST_PROBABILITY = 0.4;
/** Weak-tier (battleTactics 1: chaotic / builder) enclosure-denial chance. The
 *  ONLY enclosure-breaking tactic enabled at tier 1 — kept small so weak AI
 *  stays clearly below the tier-2 baseline (0.15 ≪ 0.75) but is no longer 100%
 *  passive: it now occasionally lands a surgical min-cut instead of only spraying
 *  walls. deny_enclosure is the right (and only safe) lever here — its
 *  `rng.bool` already consumes a draw at prob 0, so raising it preserves the
 *  RNG-stream alignment (structural / fat_breach skip their roll at tier 1, so
 *  enabling THOSE would shift every downstream draw). Naturally rate-limited by
 *  the ≥6-usable-cannon gate and planDenyEnclosure finding an affordable cut. */
const WEAK_DENY_ENCLOSURE_PROBABILITY = 0.15;
/** Minimum usable cannons to attempt an ice trench (lower than general chain threshold). */
const ICE_TRENCH_MIN_CANNONS = 4;

export class DefaultStrategy implements AiStrategy {
  /** Shot count per cannon — tracks hits to know when to stop targeting.
   *  Keyed by (cannonTile, playerId, cannonIdx) — see `shotCountKey` — so it
   *  survives checkpoint cannon replacement but rolls over when a life-loss
   *  board reset reuses cannon indices for brand-new cannons. */
  private shotCounts = new Map<ShotKey, number>();
  /** Focus fire on this player during battle. Exposed via the AiStrategy
   *  interface so the battle-diag emit path can distinguish a focus-fire
   *  pickTarget commit from an unfocused one. */
  focusFirePlayerId: ValidPlayerId | undefined;
  /** Sticky enclosure target — prevents per-shot oscillation between
   *  enclosures. Invalidated when the anchor tile leaves any eligible
   *  enemy's interior (breach, enemy eliminated, focus-fire switch). */
  private battleTargetMemory: BattleTargetMemory = {
    ownerId: undefined,
    anchorTileKey: undefined,
    lastWallTileKey: undefined,
  };
  /** Whether home tower was not enclosed at the end of last build phase. */
  private _homeWasBroken = false;
  /** Enclosure target committed to on the previous build tick. The planner
   *  reuses this without re-ranking as long as the cached tower remains a
   *  closeable candidate — eliminating per-tick churn (Mode #2). Cleared in
   *  assessBuildEnd so each build phase starts fresh. */
  private _lastTargetTowerIndex: TowerIdx | undefined = undefined;

  /** Seeded PRNG — log rng.seed to reproduce this AI's behavior. */
  readonly rng: Rng;
  readonly archetype: ArchetypeId;
  bankHugging: boolean;
  private caresAboutHouses: boolean;
  private caresAboutBonuses: boolean;
  private buildSkill: 1 | 2 | 3 | 4 | 5;
  thinkingSpeed: 1 | 2 | 3;
  cursorSkill: 1 | 2 | 3;
  private aggressiveness: 1 | 2 | 3;
  private defensiveness: 1 | 2 | 3;
  private battleTactics: 1 | 2 | 3;
  private spatialAwareness: 1 | 2 | 3;

  /**
   * @param rng — RNG used only for runtime decision rolls (focus-fire, ice
   *   trench, demolition probability, etc.) and animation timing. Pure-AI
   *   initial-bootstrap controllers share `state.rng` (every peer ticks
   *   them in lockstep). Promotion-time pure-AI and AssistedHuman
   *   controllers use a private `new Rng(seed)` because their construction
   *   or animation runs asymmetrically across peers.
   * @param personality — pre-rolled archetype + traits. Rolling at bootstrap
   *   (instead of inside this constructor) lets pure-AI safely use
   *   `state.rng` as `rng` here without contaminating the shared RNG with
   *   construction-time draws that differ between host and watcher when
   *   one peer has an AssistedHuman variant for the same slot.
   */
  constructor(rng: Rng, personality: AiPersonality) {
    this.rng = rng;
    this.archetype = personality.archetype;
    this.buildSkill = personality.buildSkill;
    this.spatialAwareness = personality.spatialAwareness;
    this.aggressiveness = personality.aggressiveness;
    this.defensiveness = personality.defensiveness;
    this.battleTactics = personality.battleTactics;
    this.cursorSkill = personality.cursorSkill;
    this.thinkingSpeed = personality.thinkingSpeed;
    this.caresAboutHouses = personality.caresAboutHouses;
    this.caresAboutBonuses = personality.caresAboutBonuses;
    this.bankHugging = personality.bankHugging;
  }

  /** Castle ring margin for secondary towers (derived from aggressiveness). */
  private get castleMargin(): 2 | 3 {
    return this.aggressiveness >= 3 ? 3 : 2;
  }

  // -----------------------------------------------------------------------
  // Tower selection
  // -----------------------------------------------------------------------

  chooseBestTower(map: GameMap, zone: ZoneId): Tower | null {
    return autoSelectTower(map, zone, this.rng, this.spatialAwareness);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  pickPlacement(
    state: BuildViewState,
    playerId: ValidPlayerId,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null {
    const result = pickPlacement(state, playerId, piece, {
      cursorPos,
      homeWasBroken: this._homeWasBroken,
      castleMargin: this.castleMargin,
      bankHugging: this.bankHugging,
      caresAboutHouses: this.caresAboutHouses,
      caresAboutBonuses: this.caresAboutBonuses,
      buildSkill: this.buildSkill,
      lastTargetTowerIndex: this._lastTargetTowerIndex,
    });
    this._lastTargetTowerIndex = result.chosenTowerIndex;
    return result.placement;
  }

  /** End-of-WALL_BUILD bookkeeping: stash home-broken status for the next
   *  build phase's pickPlacement (consumed as `_homeWasBroken`), and drop the
   *  per-tick target cache so the next build phase recaptures fresh. */
  assessBuildEnd(state: BuildViewState, playerId: ValidPlayerId): void {
    const player = state.players[playerId]!;
    this._homeWasBroken =
      player.homeTower !== null &&
      !player.enclosedTowers.includes(player.homeTower);
    this._lastTargetTowerIndex = undefined;
  }

  // -----------------------------------------------------------------------
  // Cannon placement
  // -----------------------------------------------------------------------

  initCannonPhase(player: Player, count: number): CannonPlacementContext {
    return createCannonPlacementContext(
      player,
      count,
      this.rng,
      this.aggressiveness,
      this.defensiveness,
      this.spatialAwareness,
    );
  }

  nextCannonPlacement(
    player: Player,
    count: number,
    state: CannonViewState,
    ctx: CannonPlacementContext,
  ): CannonPlacement | undefined {
    return nextCannonPlacement(player, count, state, this.rng, ctx);
  }

  // -----------------------------------------------------------------------
  // Battle
  // -----------------------------------------------------------------------

  planBattle(
    state: BattleViewState,
    playerId: ValidPlayerId,
    replanExcludedTactics?: ReadonlySet<TacticId>,
  ): BattlePlan {
    const excludedTactics = replanExcludedTactics ?? EMPTY_TACTICS;
    // Focus-fire is decided once at battle entry (the call that OMITS the
    // exclusion set). Re-plans after each finished chain always pass their
    // set — even an empty one (only OFFENSIVE tactics are recorded, so a
    // battle whose entry chain was defensive re-plans with an empty set) —
    // and keep the entry-time focus: re-rolling it every chain would thrash
    // the per-shot fallback target and consume RNG mid-battle.
    if (replanExcludedTactics === undefined) {
      // Focus fire probability scales with battleTactics
      const focusProb = traitLookup(this.battleTactics, [
        0.2,
        FOCUS_FIRE_PROBABILITY,
        0.8,
      ]);
      if (this.rng.bool(focusProb)) {
        this.focusFirePlayerId = pickWeightedTargetEnemy(
          filterActiveEnemies(state, playerId),
          this.rng,
        )?.id;
      } else {
        this.focusFirePlayerId = undefined;
      }
    }

    // Chain attacks
    let chainTargets: TilePos[] | undefined;
    let chainType: ChainType = CHAIN.WALL;
    // Observability-only: refines the diag origin when a plan collapses into a
    // shared chainType (charity→GRUNT, super_attack→WALL). No behavior effect.
    let originTag: FireOrigin | undefined;
    // The granular tactic chosen — fed back to the next re-plan's exclusion set.
    let tacticId: TacticId | undefined;

    const usableCannonCount = countUsableCannons(state, playerId);

    // Ice trench — highest priority: block grunts crossing frozen river early
    const iceTrenchProb = traitLookup(this.battleTactics, [1 / 3, 2 / 3, 1]);
    if (
      usableCannonCount >= ICE_TRENCH_MIN_CANNONS &&
      this.rng.bool(iceTrenchProb)
    ) {
      const iceTrenchTargets = planIceTrench(state, playerId, this.rng);
      if (iceTrenchTargets) {
        chainTargets = iceTrenchTargets;
        chainType = CHAIN.ICE_TRENCH;
        tacticId = TACTIC.ICE_TRENCH;
      }
    }

    // Grunt sweep: enough grunts targeting us and enough usable cannons
    if (!chainTargets && usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS) {
      const gruntTargets = planGruntSweep(
        state,
        playerId,
        usableCannonCount,
        this.rng,
      );
      if (gruntTargets) {
        chainTargets = gruntTargets;
        chainType = CHAIN.GRUNT;
        tacticId = TACTIC.GRUNT_SWEEP;
      }
    }

    // Charity grunt sweep — controlled by battleTactics
    const charityProb = traitLookup(this.battleTactics, [
      0,
      CHARITY_SWEEP_PROBABILITY,
      1 / 5,
    ]);
    if (
      !chainTargets &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(charityProb)
    ) {
      const charityTargets = planCharitySweep(
        state,
        playerId,
        usableCannonCount,
        this.rng,
      );
      if (charityTargets) {
        chainTargets = charityTargets;
        chainType = CHAIN.GRUNT;
        originTag = "charity";
        tacticId = TACTIC.CHARITY;
      }
    }

    // Rubble siege — maximise the defender's re-enclosure COST (wide open-field
    // breach of their cheapest ring) rather than minimise the cut. Prototype,
    // tier 2/3, placed before deny so both draw comparable samples. Re-selectable
    // (not excluded) so a multi-attack battle keeps raising the repair floor.
    const rubbleProb = traitLookup(this.battleTactics, [
      0,
      MAX_REPAIR_COST_PROBABILITY,
      MAX_REPAIR_COST_PROBABILITY,
    ]);
    if (
      !chainTargets &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(rubbleProb)
    ) {
      const rubbleTargets = planMaxRepairCost(
        state,
        playerId,
        this.focusFirePlayerId,
        usableCannonCount,
        this.rng,
      );
      if (rubbleTargets) {
        chainTargets = rubbleTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "max_repair_cost";
        tacticId = TACTIC.MAX_REPAIR_COST;
      }
    }

    // Enclosure denial — top offensive priority. Concentrate fire on the
    // wall tiles at the min-cut bottleneck of the weakest enemy's cheapest
    // ring, maximising the cost for them to re-enclose any tower (the actual
    // life-loss condition). Re-selectable across re-plans (not excluded), so a
    // multi-attack battle keeps sieging the defender's best fallback ring.
    const denyProb = traitLookup(this.battleTactics, [
      WEAK_DENY_ENCLOSURE_PROBABILITY,
      DENY_ENCLOSURE_PROBABILITY,
      1,
    ]);
    if (
      !chainTargets &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(denyProb)
    ) {
      const denyTargets = planDenyEnclosure(
        state,
        playerId,
        this.focusFirePlayerId,
        usableCannonCount,
        this.rng,
      );
      if (denyTargets) {
        chainTargets = denyTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "deny_enclosure";
        tacticId = TACTIC.DENY_ENCLOSURE;
      }
    }

    // Structural hit — surgical 1–2 shot attack that breaks 2+ large enclosures
    const structuralProb = traitLookup(this.battleTactics, [
      0,
      STRUCTURAL_HIT_PROBABILITY,
      3 / 4,
    ]);
    const structuralMaxHits = traitLookup(this.battleTactics, [0, 1, 3]);
    if (
      !chainTargets &&
      structuralMaxHits > 0 &&
      !excludedTactics.has(TACTIC.STRUCTURAL) &&
      this.rng.bool(structuralProb)
    ) {
      const structuralTargets = planStructuralHit(
        state,
        playerId,
        structuralMaxHits,
      );
      if (structuralTargets) {
        chainTargets = structuralTargets;
        chainType = CHAIN.STRUCTURAL;
        tacticId = TACTIC.STRUCTURAL;
      }
    }

    // Fat-wall breach — drill a diagonal channel through a ≥3-thick enemy wall
    // body. Tried after the surgical structural hit (which handles cheap 1–2
    // tile breaches) as an opportunistic tactic for thick walls a single hit
    // can't cut through. Shares CHAIN.STRUCTURAL behavior; distinct only via
    // the fat_breach origin tag for metrics. The maxAttempts guard (0 at the
    // weak tier) skips the rng roll entirely so the RNG stream is unperturbed
    // for weak AI, mirroring structuralMaxHits.
    const fatBreachProb = traitLookup(this.battleTactics, [
      0,
      FAT_BREACH_PROBABILITY,
      1 / 2,
    ]);
    const fatBreachMaxAttempts = traitLookup(this.battleTactics, [0, 1, 1]);
    if (
      !chainTargets &&
      fatBreachMaxAttempts > 0 &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      !excludedTactics.has(TACTIC.FAT_BREACH) &&
      this.rng.bool(fatBreachProb)
    ) {
      const fatTargets = planFatBreach(
        state,
        playerId,
        usableCannonCount,
        this.rng,
      );
      if (fatTargets) {
        chainTargets = fatTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "fat_breach";
        tacticId = TACTIC.FAT_BREACH;
      }
    }

    // Pocket destruction — gated on the same usable-cannon threshold as
    // wall-demolition / super-attack so trailing or post-life-loss players
    // with <6 firing cannons don't spend their entire round on own-wall
    // cleanup. The 5-target chain dominates a 1-2 cannon round and
    // contributes nothing to immediate score or survival.
    if (!chainTargets && usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS) {
      const pocketTargets = planPocketDestruction(state, playerId);
      if (pocketTargets) {
        chainTargets = pocketTargets;
        chainType = CHAIN.POCKET;
        tacticId = TACTIC.POCKET;
      }
    }

    // Wall demolition — controlled by battleTactics
    const demolitionProb = traitLookup(this.battleTactics, [
      0,
      WALL_DEMOLITION_PROBABILITY,
      1 / 2,
    ]);
    if (
      !chainTargets &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      !excludedTactics.has(TACTIC.WALL_DEMOLITION) &&
      this.rng.bool(demolitionProb)
    ) {
      const demolitionTargets =
        planWallDemolition(state, playerId, usableCannonCount, this.rng) ??
        undefined;
      if (demolitionTargets) {
        chainTargets = demolitionTargets;
        chainType = CHAIN.WALL;
        tacticId = TACTIC.WALL_DEMOLITION;
      }
    }

    // Super attack — controlled by battleTactics
    const superAtkProb = traitLookup(this.battleTactics, [
      0,
      SUPER_ATTACK_PROBABILITY,
      1 / 4,
    ]);
    if (
      !chainTargets &&
      usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS &&
      !excludedTactics.has(TACTIC.SUPER_ATTACK) &&
      this.rng.bool(superAtkProb)
    ) {
      const superTargets =
        planSuperAttack(state, playerId, usableCannonCount, this.rng) ??
        undefined;
      if (superTargets) {
        chainTargets = superTargets;
        chainType = CHAIN.WALL;
        originTag = "super_attack";
        tacticId = TACTIC.SUPER_ATTACK;
      }
    }

    return { chainTargets, chainType, originTag, tacticId };
  }

  pickTarget(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
  ): StrategicPixelPos | null {
    return pickTarget(
      state,
      playerId,
      crosshair,
      this.focusFirePlayerId,
      this.shotCounts,
      this.battleTargetMemory,
      this.rng,
      this.battleTactics,
    );
  }

  trackShot(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
  ): void {
    trackShot(state, playerId, crosshair, this.shotCounts);
  }

  onLifeLost(): void {
    this.focusFirePlayerId = undefined;
    this._homeWasBroken = false;
    this.battleTargetMemory.ownerId = undefined;
    this.battleTargetMemory.anchorTileKey = undefined;
    this.battleTargetMemory.lastWallTileKey = undefined;
  }

  reset(): void {
    this.onLifeLost();
    this.shotCounts = new Map<ShotKey, number>();
    this._lastTargetTowerIndex = undefined;
  }
}
