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
import { orderByNearest, pxToTile } from "../shared/core/spatial.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import type { FireOrigin } from "./ai-battle-diag.ts";
import type { AiPlacement } from "./ai-build-types.ts";
import { CHAIN, type ChainType, TACTIC, type TacticId } from "./ai-chain.ts";
import { planCharitySweep } from "./ai-plan-charity-sweep.ts";
import { planDeclutter } from "./ai-plan-declutter.ts";
import {
  pickTargetEnemy,
  planDenyEnclosure,
} from "./ai-plan-deny-enclosure.ts";
import { planFatBreach } from "./ai-plan-fat-breach.ts";
import { planFinishIt } from "./ai-plan-finish-it.ts";
import { planGruntBreach } from "./ai-plan-grunt-breach.ts";
import { planGruntSweep } from "./ai-plan-grunt-sweep.ts";
import { planIceTrench } from "./ai-plan-ice-trench.ts";
import { planMaxRepairCost } from "./ai-plan-max-repair-cost.ts";
import { planPinchKill } from "./ai-plan-pinch-kill.ts";
import { planPocketDestruction } from "./ai-plan-pocket-destruction.ts";
import { planStructuralHit } from "./ai-plan-structural-hit.ts";
import { planSuperAttack } from "./ai-plan-super-attack.ts";
import { planSustainedPressure } from "./ai-plan-sustained-pressure.ts";
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
import { secondsToTicks, traitLookup } from "./ai-utils.ts";

/** Shared empty exclusion set `planBattle` falls back to when the entry call
 *  omits the param (no allocation per battle). Entry-vs-replan is flagged by
 *  the param being omitted, NOT by set emptiness — a re-plan after a
 *  defensive-only chain legitimately passes an empty set. */
const EMPTY_TACTICS: ReadonlySet<TacticId> = new Set();
/** Chance to focus all fire on one uniformly-chosen enemy for the whole battle. */
const FOCUS_FIRE_PROBABILITY = 0.5;
/** Default minimum usable cannons to attempt a chain attack. Individual
 *  tactics override this with their own gate (see `FAT_BREACH_MIN_CANNONS`,
 *  `ICE_TRENCH_MIN_CANNONS`) when their cost/value profile differs. */
const CHAIN_ATTACK_MIN_CANNONS = 6;
/** Minimum usable cannons to attempt a fat-wall min-cut breach — lower than
 *  the general chain threshold. The breach (`findMinBreach`) caps its own cost
 *  at the cannon budget, so 4–5 cannons can still open a thin or partly-damaged
 *  ring; and at 4–5 cannons `deny_enclosure` (gated at 6) is OFF, so this is the
 *  ONLY breach tactic firing there — making the any-player fat-breach the
 *  low-cannon enclosure-denial lever instead of leaving those battles passive. */
const FAT_BREACH_MIN_CANNONS = 4;
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
/** Chance per re-plan to fall back to a sustained-pressure grind of the
 *  victim's remaining walls instead of downshifting to the per-shot loop for
 *  the battle's tail. Scales with battleTactics; a miss is permanent for the
 *  battle (the per-shot loop never re-enters chains). */
const SUSTAINED_PRESSURE_PROBABILITY = 1 / 2;
/** Per-tier chance to spray a large messy castle's outer wall (weak tier 0 —
 *  the gate skips the draw so that tier's rng stream is unperturbed, mirroring
 *  fat_breach / sustained_pressure). Kept high where enabled: the >=14-cannon +
 *  large-messy-target precondition is already rare, so a low probability would
 *  make it near-dead. Scales with battleTactics. */
const FINISH_IT_PROBABILITY: readonly [number, number, number] = [0, 0.6, 0.9];
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
/** Chance to take a guaranteed pinch kill this chain. A pinch breach is a pure
 *  function of the TARGET's geometry — the firing player's cannons/zone never
 *  enter `findMinBreach` — so a deterministic, un-gated pinch made every
 *  attacker of the same enemy compute the IDENTICAL cut and dogpile the same
 *  walls (the AI may not read opponents' ball targets, so it can't dedup across
 *  players). Gating it per-player desyncs the attackers: each independently rolls
 *  whether to pinch this chain, and a miss falls through to its own varied
 *  focus-fire / sweep / deny tactics. Kept high (a sure kill is the highest-value
 *  action) but below 1 so two attackers no longer mirror. Scales with
 *  battleTactics so stronger AI takes the kill more often. */
const PINCH_KILL_PROBABILITY: readonly [number, number, number] = [
  1 / 2,
  2 / 3,
  5 / 6,
];
/** Chance to open the target's ring at the seam nearest its in-zone grunts —
 *  the corridor bet: grunts through the gap block the reseal (placement rejects
 *  grunt tiles) and threaten the tower (only grunts kill towers). Its planner
 *  precondition (≥2 grunts within one build-phase walk of a tower ring) is
 *  already rare, so the probability is kept high where the tactic is enabled;
 *  the weak tier mirrors WEAK_DENY_ENCLOSURE_PROBABILITY (its rng.bool always
 *  draws, so stream alignment is preserved). Per-player roll + uniform enemy
 *  pick + the cursor-seeded `orderByNearest` firing order desync two attackers
 *  of the same defender (different crosshairs, different entry ends). */
const GRUNT_BREACH_PROBABILITY: readonly [number, number, number] = [
  WEAK_DENY_ENCLOSURE_PROBABILITY,
  0.65,
  0.85,
];
/** Minimum usable cannons for a grunt breach — the drill is capped at 4 walls,
 *  so like fat_breach it stays affordable below the general chain threshold. */
const GRUNT_BREACH_MIN_CANNONS = 4;
/** Minimum usable cannons to attempt an ice trench (lower than general chain threshold). */
const ICE_TRENCH_MIN_CANNONS = 4;
/** Delay multiplier by thinkingSpeed (1=slow 1.4×, 2=normal 1×, 3=fast 0.65×). */
const DELAY_SCALE_BY_THINKING_SPEED = [1.4, 1.0, 0.65] as const;
/** Tile-cursor boost-distance threshold (tiles) by cursorSkill
 *  (1=8 rarely boosts, 2=5 default, 3=3 boosts early). */
const TILE_BOOST_THRESHOLD_BY_CURSOR_SKILL = [8, 5, 3] as const;
/** Minimum usable cannons to launch a "finish it" perimeter spray. Well above
 *  the general chain gate: the spray is a finishing move spent from a dominant
 *  battery, not a staple. (Started at 17 = top ~7.3% of measured battle-states;
 *  lowered to 14 to surface the move more often — the cannon gate is the single
 *  biggest frequency lever, far more than the messy-wall threshold.) */
export const FINISH_IT_MIN_CANNONS = 14;

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
  /** The ONE enemy castle this battle's chains attack. Rolled once at battle
   *  entry (the focus target when focus fired, else a uniform pick); every
   *  enemy-choosing chain tactic (deny, max-repair, pinch, fat-breach) leads
   *  with it. Without this each finished chain re-rolled its victim uniformly,
   *  so a 3-player battle ping-ponged the crosshair between two enemy castles
   *  — the dominant cross-map glide. Uniform at BATTLE granularity keeps the
   *  anti-weakest-bias property (leaders get attacked across battles). */
  private battleVictimId: ValidPlayerId | undefined;
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

  // ── Trait-derived timing/movement tuning (moved off AiController so the
  //    brain reads it from the strategy directly instead of round-tripping
  //    through the host). ──

  /** Delay multiplier derived from thinkingSpeed. */
  private get delayScale(): number {
    return DELAY_SCALE_BY_THINKING_SPEED[this.thinkingSpeed - 1]!;
  }

  scaledDelay(base: number, spread: number): number {
    return secondsToTicks((base + this.rng.next() * spread) * this.delayScale);
  }

  get boostThreshold(): number {
    return TILE_BOOST_THRESHOLD_BY_CURSOR_SKILL[this.cursorSkill - 1]!;
  }

  get anticipatesTarget(): boolean {
    return this.cursorSkill >= 2;
  }

  get battleBoostDist(): number {
    return this.cursorSkill === 1 ? Number.POSITIVE_INFINITY : 0;
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
    crosshair: PixelPos,
    replanExcludedTactics?: ReadonlySet<TacticId>,
  ): BattlePlan {
    const excludedTactics = replanExcludedTactics ?? EMPTY_TACTICS;
    // Travel-order-free planners seed their nearest-neighbour walk here so a
    // fresh chain's first shot is near the cursor, not a cross-map jump (the
    // crosshair glides at bounded speed — long hops directly cost shots).
    const cursor: TilePos = {
      row: pxToTile(crosshair.y),
      col: pxToTile(crosshair.x),
    };
    // Focus-fire and the battle victim are decided once at battle entry (the
    // call that OMITS the exclusion set). Re-plans after each finished chain
    // always pass their set — even an empty one (only OFFENSIVE tactics are
    // recorded, so a battle whose entry chain was defensive re-plans with an
    // empty set) — and keep the entry-time targets: re-rolling every chain
    // would thrash the per-shot fallback target and ping-pong the crosshair
    // between enemy castles.
    if (replanExcludedTactics === undefined) {
      this.rollBattleTargets(state, playerId);
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
    const iceTrenchTargets = this.rollIceTrench(
      state,
      playerId,
      usableCannonCount,
      cursor,
    );
    if (iceTrenchTargets) {
      chainTargets = iceTrenchTargets;
      chainType = CHAIN.ICE_TRENCH;
      tacticId = TACTIC.ICE_TRENCH;
    }

    // Grunt sweep: enough grunts targeting us and enough usable cannons
    if (!chainTargets && usableCannonCount >= CHAIN_ATTACK_MIN_CANNONS) {
      const gruntTargets = planGruntSweep(
        state,
        playerId,
        usableCannonCount,
        cursor,
      );
      if (gruntTargets) {
        chainTargets = gruntTargets;
        chainType = CHAIN.GRUNT;
        tacticId = TACTIC.GRUNT_SWEEP;
      }
    }

    // Finish it — the perimeter spray, and the signature move of a dominant
    // player. From a dominant battery (>=14 usable cannons — ramparts /
    // balloons don't count, they can't fire) against a large messy castle,
    // punch single holes spaced AROUND the outer wall: a demoralising repair
    // tax (every hole a separate refill) plus modern demolition combos. Placed
    // ABOVE pinch (but below defence: ice_trench / grunt_sweep still come
    // first) so the dominant player LEADS with the spray, then kills / grinds.
    // It must sit above pinch: pinch is re-selectable and fires most chains of
    // a dominant battle, so any lower rung starves the spray (measured: ~1
    // spray / 24 games below pinch vs ~2.6% of shots here). Once per battle via
    // the exclusion set (the shell doesn't regenerate mid-battle), so it only
    // costs pinch ONE chain — pinch reclaims the rest and its share is unchanged.
    if (!chainTargets) {
      const finishItTargets = this.rollFinishIt(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
      );
      if (finishItTargets) {
        chainTargets = finishItTargets;
        chainType = CHAIN.WALL;
        originTag = "finish_it";
        tacticId = TACTIC.FINISH_IT;
      }
    }

    // Pinch kill — top offensive priority (no min-cannon gate): a min-cut breach
    // whose reseal we've verified lands in a buildable island too small for a
    // tetromino, so the defender can only re-enclose the opened tower with a rare
    // small piece. A guaranteed kill is the highest-value action, so it sits above
    // the deny / fat_breach cascade. But the breach is a pure function of the
    // TARGET's geometry, so an un-gated pinch made every attacker of one enemy fire
    // the IDENTICAL cut; the per-player `PINCH_KILL_PROBABILITY` roll desyncs them
    // (a miss falls through to that player's own varied tactics). The rng.bool is
    // drawn unconditionally here so the RNG stream stays aligned across mirrored
    // sims. Re-selectable across re-plans (not excluded) so successive chains keep
    // opening fresh kills; once a ring's walls are gone `findMinBreach` no longer
    // returns them.
    if (!chainTargets) {
      const pinchTargets = this.rollPinchKill(
        state,
        playerId,
        usableCannonCount,
        cursor,
      );
      if (pinchTargets) {
        chainTargets = pinchTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "pinch_kill";
        tacticId = TACTIC.PINCH_KILL;
      }
    }

    // Declutter — clear the player's own redundant "fat" walls once they've
    // accumulated past `planDeclutter`'s trigger threshold (fat boxes in the
    // piece bag and leaves no ground for new cannons, and the build-phase
    // sweep can never remove it). Deliberately ABOVE the probabilistic siege
    // cascade: deny_enclosure alone claims most re-plans, so a lower rung
    // starves and bloated castles never clean up (measured: 60-98 fat, 10+
    // guns, zero declutter fires). Below defense and the guaranteed pinch
    // kill. Once per battle via the exclusion set — the trigger stays true
    // all battle, so without it a fat castle would never fire at an enemy.
    // RE-PLANS ONLY: a battle must never OPEN with own-wall cleanup — the
    // entry chain goes to an enemy (or real defense), and the once-per-battle
    // cleanup rides a later re-plan slot. Shares pocket destruction's own-wall
    // chain semantics (CHAIN.POCKET: own-wall target checks, super-gun
    // bail-out).
    if (!chainTargets && replanExcludedTactics !== undefined) {
      const declutterTargets = this.gateDeclutter(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
        cursor,
      );
      if (declutterTargets) {
        chainTargets = declutterTargets;
        chainType = CHAIN.POCKET;
        originTag = "declutter";
        tacticId = TACTIC.DECLUTTER;
      }
    }

    // Grunt breach — above the min-cut sieges when the defender has grunts
    // massed near a tower ring: open the seam NEAREST the grunts so the march
    // through the gap blocks the reseal and threatens the tower next build
    // (a corridor the pacing grunts actually find, unlike the global min-cut).
    // Excluded after firing (one corridor per battle — the marchers only march
    // once); the per-player roll keeps two attackers from drilling in lockstep.
    if (!chainTargets) {
      const gruntBreachTargets = this.rollGruntBreach(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
        cursor,
      );
      if (gruntBreachTargets) {
        chainTargets = gruntBreachTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "grunt_breach";
        tacticId = TACTIC.GRUNT_BREACH;
      }
    }

    // Charity grunt sweep — controlled by battleTactics
    if (!chainTargets) {
      const charityTargets = this.rollCharitySweep(
        state,
        playerId,
        usableCannonCount,
        cursor,
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
    if (!chainTargets) {
      const rubbleTargets = this.rollMaxRepairCost(
        state,
        playerId,
        usableCannonCount,
        cursor,
      );
      if (rubbleTargets) {
        chainTargets = rubbleTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "max_repair_cost";
        tacticId = TACTIC.MAX_REPAIR_COST;
      }
    }

    // Enclosure denial — top offensive priority. Concentrate fire on the
    // wall tiles at the min-cut bottleneck of a uniformly-chosen enemy's
    // cheapest ring, maximising the cost for them to re-enclose any tower (the actual
    // life-loss condition). Re-selectable across re-plans (not excluded), so a
    // multi-attack battle keeps sieging the defender's best fallback ring.
    if (!chainTargets) {
      const denyTargets = this.rollDenyEnclosure(
        state,
        playerId,
        usableCannonCount,
        cursor,
      );
      if (denyTargets) {
        chainTargets = denyTargets;
        chainType = CHAIN.STRUCTURAL;
        originTag = "deny_enclosure";
        tacticId = TACTIC.DENY_ENCLOSURE;
      }
    }

    // Structural hit — surgical 1–2 shot attack that breaks 2+ large enclosures
    if (!chainTargets) {
      const structuralTargets = this.rollStructuralHit(
        state,
        playerId,
        excludedTactics,
        cursor,
      );
      if (structuralTargets) {
        chainTargets = structuralTargets;
        chainType = CHAIN.STRUCTURAL;
        tacticId = TACTIC.STRUCTURAL;
      }
    }

    // Fat-wall breach — the minimum-cut breach: drill the fewest walls (a
    // diagonal staircase, since the flood is 8-connected) that open a large
    // enclosure, through a fat ring of ANY thickness. Tried after the surgical
    // structural hit (which handles cheap 1–2 tile breaches) for thick walls a
    // single hit can't cut through. Shares CHAIN.STRUCTURAL behavior; distinct
    // only via the fat_breach origin tag for metrics.
    if (!chainTargets) {
      const fatTargets = this.rollFatBreach(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
        cursor,
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
      const pocketTargets = planPocketDestruction(state, playerId, cursor);
      if (pocketTargets) {
        chainTargets = pocketTargets;
        chainType = CHAIN.POCKET;
        tacticId = TACTIC.POCKET;
      }
    }

    // Wall demolition — controlled by battleTactics
    if (!chainTargets) {
      const demolitionTargets = this.rollWallDemolition(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
      );
      if (demolitionTargets) {
        chainTargets = demolitionTargets;
        chainType = CHAIN.WALL;
        tacticId = TACTIC.WALL_DEMOLITION;
      }
    }

    // Super attack — controlled by battleTactics
    if (!chainTargets) {
      const superTargets = this.rollSuperAttack(
        state,
        playerId,
        usableCannonCount,
        excludedTactics,
      );
      if (superTargets) {
        chainTargets = superTargets;
        chainType = CHAIN.WALL;
        originTag = "super_attack";
        tacticId = TACTIC.SUPER_ATTACK;
      }
    }

    // Sustained pressure — the tail fallback. Once the surgical tactics stop
    // planning (rings min-cut open, once-per-battle attacks spent), a failed
    // re-plan used to drop the battery to the per-shot loop for the REST of
    // the battle — the measured "few holes then quiet" downshift. Instead,
    // grind a contiguous slice of the victim's remaining walls: visible
    // pressure plus next-build repair tax. Re-selectable every re-plan (not in
    // OFFENSIVE_TACTICS); the trait-scaled roll keeps weak tiers passive and
    // lets mid tiers sometimes stay surgical (a miss falls through to the
    // per-shot loop, which never re-enters chains this battle).
    if (!chainTargets) {
      const pressureTargets = this.rollSustainedPressure(
        state,
        playerId,
        usableCannonCount,
        cursor,
      );
      if (pressureTargets) {
        chainTargets = pressureTargets;
        chainType = CHAIN.WALL;
        originTag = "sustained_pressure";
        tacticId = TACTIC.SUSTAINED_PRESSURE;
      }
    }

    return { chainTargets, chainType, originTag, tacticId };
  }

  /** Battle-entry target roll: focus-fire (trait-scaled probability) and the
   *  battle-long victim castle (focus target when focus fired, else a uniform
   *  draw among active enemies — see `battleVictimId`). Both draws read only
   *  synced sim state, so the sequence is identical on every peer. */
  private rollBattleTargets(
    state: BattleViewState,
    playerId: ValidPlayerId,
  ): void {
    const focusProb = traitLookup(this.battleTactics, [
      0.2,
      FOCUS_FIRE_PROBABILITY,
      0.8,
    ]);
    if (this.rng.bool(focusProb)) {
      this.focusFirePlayerId = pickTargetEnemy(
        state,
        playerId,
        undefined,
        this.rng,
      )?.id;
    } else {
      this.focusFirePlayerId = undefined;
    }
    this.battleVictimId =
      this.focusFirePlayerId ??
      pickTargetEnemy(state, playerId, undefined, this.rng)?.id;
  }

  /** Declutter gate: cannon threshold (same rationale as pocket destruction —
   *  a player with <6 firing cannons shouldn't spend their whole round on
   *  own-wall cleanup) and the once-per-battle exclusion, then the
   *  deterministic fat-threshold plan. No rng draw — the trigger is a pure
   *  function of the player's own synced walls, and self-cleanup has no
   *  cross-attacker cloning to desync. */
  private gateDeclutter(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.DECLUTTER)) return null;
    return planDeclutter(state, playerId, usableCannonCount, cursor);
  }

  /** Enclosure-denial gate: cannon threshold then the trait-scaled roll. Same
   *  parity argument as `rollIceTrench` — both gate conditions read only
   *  synced sim state, so the draw sequence is identical on every peer. */
  private rollDenyEnclosure(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    const take = this.rng.bool(
      traitLookup(this.battleTactics, [
        WEAK_DENY_ENCLOSURE_PROBABILITY,
        DENY_ENCLOSURE_PROBABILITY,
        1,
      ]),
    );
    if (!take) return null;
    return planDenyEnclosure(
      state,
      playerId,
      this.battleVictimId,
      usableCannonCount,
      this.rng,
      cursor,
    );
  }

  /** Structural-hit gate: trait-scaled max-hits + probability roll, then the
   *  surgical plan. The maxHits > 0 check runs before the rng draw so the
   *  weak tier's stream is unperturbed (mirrors fat_breach's maxAttempts). */
  private rollStructuralHit(
    state: BattleViewState,
    playerId: ValidPlayerId,
    excludedTactics: ReadonlySet<TacticId>,
    cursor: TilePos,
  ): TilePos[] | null {
    const structuralProb = traitLookup(this.battleTactics, [
      0,
      STRUCTURAL_HIT_PROBABILITY,
      3 / 4,
    ]);
    const structuralMaxHits = traitLookup(this.battleTactics, [0, 1, 3]);
    if (structuralMaxHits <= 0) return null;
    if (excludedTactics.has(TACTIC.STRUCTURAL)) return null;
    if (!this.rng.bool(structuralProb)) return null;
    return planStructuralHit(state, playerId, structuralMaxHits, cursor);
  }

  /** Sustained-pressure gate: cannon threshold, then the trait-scaled roll
   *  (0 at the weak tier — the gate skips the draw entirely so that tier's
   *  rng stream is unperturbed), then the victim-wall grind. Same parity
   *  argument as `rollIceTrench` — gate conditions read only synced sim
   *  state, so the draw sequence is identical on every peer. */
  private rollSustainedPressure(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    // Gated at the LOW fat-breach threshold, not the general chain one: the
    // fallback exists precisely for battles the ≥6-cannon tactics sat out,
    // and a 4–5 cannon battery grinding 8–10 walls is the difference between
    // a passive tail and visible pressure. Strong tier always grinds (a
    // single miss is permanent — the per-shot loop never re-enters chains).
    if (usableCannonCount < FAT_BREACH_MIN_CANNONS) return null;
    const prob = traitLookup(this.battleTactics, [
      0,
      SUSTAINED_PRESSURE_PROBABILITY,
      1,
    ]);
    if (prob <= 0) return null;
    if (!this.rng.bool(prob)) return null;
    return planSustainedPressure(
      state,
      playerId,
      usableCannonCount,
      this.rng,
      cursor,
      this.battleVictimId,
    );
  }

  /** Fat-breach gate: trait-scaled max-attempts + probability roll, cannon
   *  threshold and once-per-battle exclusion, then the min-cut breach plan. The
   *  maxAttempts > 0 check runs before the rng draw so the weak tier's stream
   *  is unperturbed (mirrors structuralMaxHits). */
  private rollFatBreach(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
    cursor: TilePos,
  ): TilePos[] | null {
    const maxAttempts = traitLookup(this.battleTactics, [0, 1, 1]);
    if (maxAttempts <= 0) return null;
    if (usableCannonCount < FAT_BREACH_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.FAT_BREACH)) return null;
    const prob = traitLookup(this.battleTactics, [
      0,
      FAT_BREACH_PROBABILITY,
      1 / 2,
    ]);
    if (!this.rng.bool(prob)) return null;
    return planFatBreach(
      state,
      playerId,
      usableCannonCount,
      this.rng,
      cursor,
      this.battleVictimId,
    );
  }

  /** Wall-demolition gate: cannon threshold and once-per-battle exclusion, then
   *  the trait-scaled roll. Behaviour-preserving extraction of the former inline
   *  block: the roll is drawn whenever the cannon + exclusion gates pass (weak
   *  tier draws `bool(0)` too, matching the original compound condition), so the
   *  rng stream is unchanged. Same parity argument as the other gates. */
  private rollWallDemolition(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.WALL_DEMOLITION)) return null;
    const prob = traitLookup(this.battleTactics, [
      0,
      WALL_DEMOLITION_PROBABILITY,
      1 / 2,
    ]);
    if (!this.rng.bool(prob)) return null;
    return (
      planWallDemolition(state, playerId, usableCannonCount, this.rng) ?? null
    );
  }

  /** Super-attack gate: cannon threshold and once-per-battle exclusion, then
   *  the trait-scaled roll, then the super-gun demolition plan. Behaviour-
   *  preserving extraction of the former inline block: the roll is drawn
   *  whenever the cannon + exclusion gates pass (weak tier draws `bool(0)` too,
   *  matching the original compound condition), so the rng stream is unchanged.
   *  Same parity argument as the other gates. */
  private rollSuperAttack(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.SUPER_ATTACK)) return null;
    const prob = traitLookup(this.battleTactics, [
      0,
      SUPER_ATTACK_PROBABILITY,
      1 / 4,
    ]);
    if (!this.rng.bool(prob)) return null;
    return (
      planSuperAttack(state, playerId, usableCannonCount, this.rng) ?? null
    );
  }

  /** Finish-it gate: the dominant-firepower threshold (>=14 cannons) and the
   *  once-per-battle exclusion, then the trait-scaled roll (0 at the weak tier —
   *  the gate skips the draw so that tier's rng stream is unperturbed, mirroring
   *  fat_breach), then the perimeter-spray plan (which itself returns null unless
   *  an enemy is large AND messy). Same parity argument as the other gates —
   *  every condition reads only synced sim state. */
  private rollFinishIt(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
  ): TilePos[] | null {
    if (usableCannonCount < FINISH_IT_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.FINISH_IT)) return null;
    const prob = traitLookup(this.battleTactics, FINISH_IT_PROBABILITY);
    if (prob <= 0) return null;
    if (!this.rng.bool(prob)) return null;
    return planFinishIt(state, playerId);
  }

  /** Rubble-siege gate: cannon threshold then the trait-scaled roll. Same
   *  parity argument as `rollIceTrench` — both gate conditions read only
   *  synced sim state, so the draw sequence is identical on every peer. */
  private rollMaxRepairCost(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    const take = this.rng.bool(
      traitLookup(this.battleTactics, [
        0,
        MAX_REPAIR_COST_PROBABILITY,
        MAX_REPAIR_COST_PROBABILITY,
      ]),
    );
    if (!take) return null;
    return planMaxRepairCost(
      state,
      playerId,
      this.battleVictimId,
      usableCannonCount,
      this.rng,
      cursor,
    );
  }

  /** Per-player pinch-kill gate. Draws the `PINCH_KILL_PROBABILITY` roll
   *  UNCONDITIONALLY (so the RNG stream stays aligned across mirrored sims) and
   *  returns the breach only on a hit — see the call-site comment for why the
   *  deterministic pinch had to be gated. */
  private rollPinchKill(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    const take = this.rng.bool(
      traitLookup(this.battleTactics, PINCH_KILL_PROBABILITY),
    );
    if (!take) return null;
    const breach = planPinchKill(
      state,
      playerId,
      usableCannonCount,
      this.rng,
      cursor,
      this.battleVictimId,
    );
    return breach && orderByNearest(breach, undefined, cursor);
  }

  /** Ice-trench gate: cannon threshold then the trait-scaled roll. The gate
   *  reads only synced sim state, so conditioning the draw on it is
   *  parity-safe (the draw sequence is identical on every peer). */
  private rollIceTrench(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < ICE_TRENCH_MIN_CANNONS) return null;
    const take = this.rng.bool(
      traitLookup(this.battleTactics, [1 / 3, 2 / 3, 1]),
    );
    if (!take) return null;
    return planIceTrench(state, playerId, this.rng, cursor);
  }

  /** Charity-sweep gate: cannon threshold then the trait-scaled roll. Same
   *  parity argument as `rollIceTrench`. */
  private rollCharitySweep(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < CHAIN_ATTACK_MIN_CANNONS) return null;
    const take = this.rng.bool(
      traitLookup(this.battleTactics, [0, CHARITY_SWEEP_PROBABILITY, 1 / 5]),
    );
    if (!take) return null;
    return planCharitySweep(
      state,
      playerId,
      usableCannonCount,
      this.rng,
      cursor,
    );
  }

  /** Per-player grunt-breach gate: cannon threshold, once-per-battle
   *  exclusion, then the `GRUNT_BREACH_PROBABILITY` roll. Both gate conditions
   *  derive from synced sim state (identical on every peer), so conditioning
   *  the draw on them is parity-safe — unlike controller-local state. */
  private rollGruntBreach(
    state: BattleViewState,
    playerId: ValidPlayerId,
    usableCannonCount: number,
    excludedTactics: ReadonlySet<TacticId>,
    cursor: TilePos,
  ): TilePos[] | null {
    if (usableCannonCount < GRUNT_BREACH_MIN_CANNONS) return null;
    if (excludedTactics.has(TACTIC.GRUNT_BREACH)) return null;
    const take = this.rng.bool(
      traitLookup(this.battleTactics, GRUNT_BREACH_PROBABILITY),
    );
    if (!take) return null;
    return planGruntBreach(
      state,
      playerId,
      this.battleVictimId,
      usableCannonCount,
      this.rng,
      cursor,
    );
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
    this.battleVictimId = undefined;
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
