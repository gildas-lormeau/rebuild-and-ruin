/**
 * DefaultStrategy class — production implementation of `AiStrategy`.
 * The interface lives in ai-strategy-types.ts so phase modules can
 * import it without pulling in this file's dep tree. Personality
 * rolling lives in ai-personality-roll.ts.
 */

import type { AiPersonality } from "../shared/core/ai-personality.ts";
import { filterActiveEnemies } from "../shared/core/board-occupancy.ts";
import type {
  GameMap,
  PixelPos,
  TilePos,
  Tower,
} from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  GameViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import type { AiPlacement } from "./ai-build-types.ts";
import { CHAIN, type ChainType } from "./ai-chain.ts";
import {
  type BattleTargetMemory,
  countUsableCannons,
  pickTarget,
  planCharitySweep,
  planGruntSweep,
  planIceTrench,
  planPocketDestruction,
  planStructuralHit,
  planSuperAttack,
  planWallDemolition,
  type ShotKey,
  trackShot,
} from "./ai-strategy-battle.ts";
import { findOuterRingHoles, pickPlacement } from "./ai-strategy-build.ts";
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
/** Minimum usable cannons to attempt an ice trench (lower than general chain threshold). */
const ICE_TRENCH_MIN_CANNONS = 4;

export class DefaultStrategy implements AiStrategy {
  /** Shot count per cannon — tracks hits to know when to stop targeting.
   *  Keyed by (playerId << 8 | cannonIdx) to survive checkpoint cannon replacement. */
  private shotCounts = new Map<ShotKey, number>();
  /** Focus fire on this player during battle. */
  private focusFirePlayerId: ValidPlayerId | undefined;
  /** Sticky enclosure target — prevents per-shot oscillation between
   *  enclosures. Invalidated when the anchor tile leaves any eligible
   *  enemy's interior (breach, enemy eliminated, focus-fire switch). */
  private battleTargetMemory: BattleTargetMemory = {
    ownerId: undefined,
    anchorTileKey: undefined,
  };
  /** Whether home tower was not enclosed at the end of last build phase. */
  private _homeWasBroken = false;
  /** Phase-stable snapshot of outer-ring hole tiles for repair targeting.
   *  Captured on the first pickPlacement() call of each build phase and
   *  reused for every subsequent call until `state.round` ticks over,
   *  preventing pseudo-gaps formed by newly-placed walls from polluting
   *  the target set and dispersing the AI's focus. */
  private _outerRingHolesSnapshot:
    | { round: number; holes: ReadonlySet<TileKey> }
    | undefined = undefined;

  /** Seeded PRNG — log rng.seed to reproduce this AI's behavior. */
  readonly rng: Rng;
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
    const snapshot = this.ensureOuterRingHolesSnapshot(state, playerId);
    return pickPlacement(state, playerId, piece, {
      cursorPos,
      homeWasBroken: this._homeWasBroken,
      castleMargin: this.castleMargin,
      bankHugging: this.bankHugging,
      caresAboutHouses: this.caresAboutHouses,
      caresAboutBonuses: this.caresAboutBonuses,
      buildSkill: this.buildSkill,
      outerRingHolesSnapshot: snapshot,
    });
  }

  /** Lazily snapshot outer-ring breach tiles on the first build-phase tick
   *  of each round. Invalidates when state.round changes. Empty set when
   *  the player has no walls/castle yet — findOuterRingHoles is cheap on
   *  an empty wall set, so we always return a real set rather than
   *  threading an undefined sentinel through the build pipeline. */
  private ensureOuterRingHolesSnapshot(
    state: BuildViewState,
    playerId: ValidPlayerId,
  ): ReadonlySet<TileKey> {
    if (this._outerRingHolesSnapshot?.round === state.round) {
      return this._outerRingHolesSnapshot.holes;
    }
    const player = state.players[playerId]!;
    const holes = findOuterRingHoles(player.walls, state, getInterior(player));
    this._outerRingHolesSnapshot = { round: state.round, holes };
    return holes;
  }

  /** Assess home tower enclosure at END of build phase. The result is stale
   *  by design — `_homeWasBroken` is consumed during the NEXT build phase's
   *  pickPlacement(), reflecting last round's outcome, not real-time state. */
  assessBuildEnd(state: GameViewState, playerId: ValidPlayerId): void {
    const player = state.players[playerId]!;
    this._homeWasBroken =
      player.homeTower !== null &&
      !player.ownedTowers.includes(player.homeTower);
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

  planBattle(state: BattleViewState, playerId: ValidPlayerId): BattlePlan {
    // Focus fire probability scales with battleTactics
    const focusProb = traitLookup(this.battleTactics, [
      0.2,
      FOCUS_FIRE_PROBABILITY,
      0.8,
    ]);
    if (this.rng.bool(focusProb)) {
      const enemies = filterActiveEnemies(state, playerId);
      if (enemies.length > 0) {
        enemies.sort(
          (a, b) =>
            a.ownedTowers.length - b.ownedTowers.length || a.score - b.score,
        );
        this.focusFirePlayerId = enemies[0]!.id;
      } else {
        this.focusFirePlayerId = undefined;
      }
    } else {
      this.focusFirePlayerId = undefined;
    }

    // Chain attacks
    let chainTargets: TilePos[] | undefined;
    let chainType: ChainType = CHAIN.WALL;

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
      }
    }

    // Pocket destruction
    if (!chainTargets) {
      const pocketTargets = planPocketDestruction(state, playerId);
      if (pocketTargets) {
        chainTargets = pocketTargets;
        chainType = CHAIN.POCKET;
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
      this.rng.bool(demolitionProb)
    ) {
      chainTargets =
        planWallDemolition(state, playerId, usableCannonCount, this.rng) ??
        undefined;
      chainType = CHAIN.WALL;
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
      this.rng.bool(superAtkProb)
    ) {
      chainTargets =
        planSuperAttack(state, playerId, usableCannonCount, this.rng) ??
        undefined;
      chainType = CHAIN.WALL;
    }

    return { chainTargets, chainType };
  }

  pickTarget(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
    wallsOnly?: boolean,
  ): StrategicPixelPos | null {
    return pickTarget(
      state,
      playerId,
      crosshair,
      this.focusFirePlayerId,
      this.shotCounts,
      this.battleTargetMemory,
      this.rng,
      wallsOnly,
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
  }

  reset(): void {
    this.onLifeLost();
    this.shotCounts = new Map<ShotKey, number>();
    this._outerRingHolesSnapshot = undefined;
  }
}
