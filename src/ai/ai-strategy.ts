/**
 * AI Strategy — pluggable interface for AI decision-making.
 *
 * Separates strategy (what to do) from mechanics (how to execute it).
 * The AiController in player-controller.ts handles timers, cursors,
 * animation, and execution; the AiStrategy handles all decisions.
 *
 * DefaultStrategy contains the current/original AI behavior.
 * Phase-specific logic lives in:
 *   - ai-strategy-build.ts   — piece placement scoring
 *   - ai-strategy-cannon.ts  — cannon placement & tower selection
 *   - ai-strategy-battle.ts  — battle planning & target picking
 */

import { filterActiveEnemies } from "../shared/core/board-occupancy.ts";
import {
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  DIFFICULTY_VERY_HARD,
} from "../shared/core/game-constants.ts";
import type {
  GameMap,
  PixelPos,
  TilePos,
  Tower,
} from "../shared/core/geometry-types.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  isTowerEnclosed,
  waterKeys,
} from "../shared/core/spatial.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  GameViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import type { AiPlacement, StrategicPixelPos } from "./ai-build-types.ts";
import { traitLookup } from "./ai-constants.ts";
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
  trackShot,
} from "./ai-strategy-battle.ts";
import { pickPlacement } from "./ai-strategy-build.ts";
import {
  autoSelectTower,
  type CannonPlacement,
  type CannonPlacementContext,
  createCannonPlacementContext,
  nextCannonPlacement,
} from "./ai-strategy-cannon.ts";

export type { CannonPlacement, CannonPlacementContext };

export type ChainType = (typeof CHAIN)[keyof typeof CHAIN];

/** Result of planBattle — tells the controller what chain attack to execute. */
export interface BattlePlan {
  chainTargets: TilePos[] | undefined;
  chainType: ChainType;
}

export interface AiStrategy {
  /** Seeded PRNG for reproducible AI behavior. */
  readonly rng: Rng;

  /** Pick a home tower for the AI player. Returns the chosen tower or null. */
  chooseBestTower(map: GameMap, zone: ZoneId): Tower | null;

  /** Pick the best placement for the current piece. */
  pickPlacement(
    state: BuildViewState,
    playerId: ValidPlayerSlot,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null;

  /** Called at the end of the build phase — assess home tower status. */
  assessBuildEnd(state: GameViewState, playerId: ValidPlayerSlot): void;

  /** Whether home tower was not enclosed at the end of last build phase. */
  readonly homeWasBroken: boolean;

  /** Initialize per-phase cannon-placement context — pre-rolls the
   *  probabilistic super/rampart/balloon decisions so subsequent
   *  per-cannon queries are deterministic. Called once at phase start. */
  initCannonPhase(
    player: Player,
    count: number,
    state: CannonViewState,
  ): CannonPlacementContext;

  /** Decide the next single cannon placement. Returns `undefined` when
   *  the AI has run out of slots or legal positions. Called each time
   *  the animation loop is ready for the next placement. */
  nextCannonPlacement(
    player: Player,
    count: number,
    state: CannonViewState,
    ctx: CannonPlacementContext,
  ): CannonPlacement | undefined;

  /** Plan the battle: pick focus target, decide chain attacks. */
  planBattle(state: BattleViewState, playerId: ValidPlayerSlot): BattlePlan;

  /** Pick a target to fire at. strategic = wall between obstacles. wallsOnly = skip cannon targets. */
  pickTarget(
    state: BattleViewState,
    playerId: ValidPlayerSlot,
    crosshair: PixelPos,
    wallsOnly?: boolean,
  ): StrategicPixelPos | null;

  /** Record a shot at whatever cannon is at the crosshair position. */
  trackShot(
    state: BattleViewState,
    playerId: ValidPlayerSlot,
    crosshair: PixelPos,
  ): void;

  /** Reset stale state after losing a life. */
  onLifeLost(): void;

  /** Reset all state for a new game. */
  reset(): void;

  /** When true, castle rects hug the river bank and seal diagonal leaks with
   *  interior plug walls.  When false (default), rects shrink away from bank
   *  corners for a tighter ring with fewer gaps to fill. */
  bankHugging: boolean;

  /** Thinking speed 1–3.  Multiplier on dwell/think delays.
   *  1 = slow and deliberate, 3 = snappy reactions. */
  thinkingSpeed: 1 | 2 | 3;

  /** Cursor control skill 1–3.  Affects 2× speed-boost threshold
   *  and ability to pre-pick the next target while firing.
   *  1 = clumsy cursor, 3 = fluid aim. */
  cursorSkill: 1 | 2 | 3;
}

type ArchetypeType = (typeof Archetype)[keyof typeof Archetype];

interface ArchetypeProfile {
  buildSkill: [number, number]; // [lo, hi] for 1–5
  spatialAwareness: [number, number]; // [lo, hi] for 1–3
  aggressiveness: [number, number];
  defensiveness: [number, number];
  battleTactics: [number, number];
  cursorSkill: [number, number];
  thinkingSpeed: [number, number];
  caresAboutHouses: number; // probability of true
  caresAboutBonuses: number;
  bankHugging: number; // probability of true
}

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
/** AI personality archetype. Determines correlated base trait values. */
const Archetype = {
  BUILDER: "builder",
  AGGRESSIVE: "aggressive",
  TACTICIAN: "tactician",
  CHAOTIC: "chaotic",
  BALANCED: "balanced",
} as const;
/**
 * Archetype trait profiles — tuned via playtesting for 3-player AI games.
 *
 * Each trait range [lo, hi] is rolled uniformly at AI creation, producing
 * varied play styles within each archetype. Key design goals:
 *
 * - BUILDER:     Prioritizes wall repair over attacking. High build skill
 *                ensures clean walls; low aggressiveness means fewer super
 *                guns and passive targeting. Slow, deliberate cursor.
 * - AGGRESSIVE:  Maximizes damage output. Always picks super guns, fires
 *                chain attacks, ignores houses/bonuses to save time for
 *                demolition. Mediocre walls but fast, accurate aim.
 * - TACTICIAN:   Strategic targeting (flanked walls, grunt-blocking walls).
 *                Good at everything but not extreme. Balloons deployed
 *                reactively. Moderate bank-hugging for territorial balance.
 * - CHAOTIC:     Unpredictable — low build skill creates messy walls, but
 *                fast cursor and high aggressiveness make battle dangerous.
 *                No tactical chains; fires at random targets rapidly.
 * - BALANCED:    All traits at midpoint. The "average" AI — competent but
 *                not specialized. Used as the baseline for difficulty tuning.
 */
const ARCHETYPE_PROFILES: Record<ArchetypeType, ArchetypeProfile> = {
  [Archetype.BUILDER]: {
    buildSkill: [3, 4],
    spatialAwareness: [2, 3],
    aggressiveness: [1, 1],
    defensiveness: [2, 3],
    battleTactics: [1, 2],
    cursorSkill: [1, 2],
    thinkingSpeed: [1, 2],
    caresAboutHouses: 0.8,
    caresAboutBonuses: 0.8,
    bankHugging: 0.2,
  },
  [Archetype.AGGRESSIVE]: {
    buildSkill: [1, 2],
    spatialAwareness: [2, 3],
    aggressiveness: [3, 3],
    defensiveness: [1, 1],
    battleTactics: [2, 3],
    cursorSkill: [2, 3],
    thinkingSpeed: [2, 3],
    caresAboutHouses: 0.2,
    caresAboutBonuses: 0.2,
    bankHugging: 0.8,
  },
  [Archetype.TACTICIAN]: {
    buildSkill: [2, 3],
    spatialAwareness: [3, 3],
    aggressiveness: [2, 2],
    defensiveness: [2, 2],
    battleTactics: [3, 3],
    cursorSkill: [2, 3],
    thinkingSpeed: [2, 3],
    caresAboutHouses: 0.7,
    caresAboutBonuses: 0.7,
    bankHugging: 0.5,
  },
  [Archetype.CHAOTIC]: {
    buildSkill: [1, 1],
    spatialAwareness: [1, 1],
    aggressiveness: [2, 3],
    defensiveness: [1, 2],
    battleTactics: [1, 1],
    cursorSkill: [2, 3],
    thinkingSpeed: [3, 3],
    caresAboutHouses: 0.2,
    caresAboutBonuses: 0.2,
    bankHugging: 0.8,
  },
  [Archetype.BALANCED]: {
    buildSkill: [2, 2],
    spatialAwareness: [2, 2],
    aggressiveness: [2, 2],
    defensiveness: [2, 2],
    battleTactics: [2, 2],
    cursorSkill: [2, 2],
    thinkingSpeed: [2, 2],
    caresAboutHouses: 0.5,
    caresAboutBonuses: 0.5,
    bankHugging: 0.5,
  },
};
const ARCHETYPE_LIST = Object.values(Archetype);
/** The kind of chain attack the AI executes during battle. */
export const CHAIN = {
  WALL: "wall",
  GRUNT: "grunt",
  POCKET: "pocket",
  STRUCTURAL: "structural",
  ICE_TRENCH: "ice_trench",
} as const;

export class DefaultStrategy implements AiStrategy {
  /** Shot count per cannon — tracks hits to know when to stop targeting.
   *  Keyed by (playerId << 8 | cannonIdx) to survive checkpoint cannon replacement. */
  private shotCounts = new Map<number, number>();
  /** Focus fire on this player during battle. */
  private focusFirePlayerId: ValidPlayerSlot | undefined;
  /** Sticky enclosure target — prevents per-shot oscillation between
   *  enclosures. Invalidated when the anchor tile leaves any eligible
   *  enemy's interior (breach, enemy eliminated, focus-fire switch). */
  private battleTargetMemory: BattleTargetMemory = {
    ownerId: undefined,
    anchorTileKey: undefined,
  };
  /** Whether home tower was not enclosed at the end of last build phase. */
  private _homeWasBroken = false;

  /** Seeded PRNG — log rng.seed to reproduce this AI's behavior. */
  readonly rng: Rng;
  /** The archetype that shaped this AI's personality. */
  readonly archetype: ArchetypeType;
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
   * @param archetype — force a specific archetype, or undefined to roll randomly
   * @param seed — PRNG seed for reproducibility
   * @param difficulty — DIFFICULTY_EASY..DIFFICULTY_VERY_HARD; clamps trait ranges
   */
  constructor(
    archetype?: ArchetypeType,
    seed?: number,
    difficulty: number = DIFFICULTY_NORMAL,
  ) {
    this.rng = new Rng(seed);
    this.archetype = archetype ?? rollArchetype(this.rng);
    const profile = ARCHETYPE_PROFILES[this.archetype];

    // Difficulty biases trait rolls within archetype ranges:
    //   Easy(0):      lo end minus 1 (floor 1) — noticeably weaker than archetype baseline
    //   Normal(1):    always lo end of range — competent but beatable
    //   Hard(2):      roll uniformly in [lo, hi] — original behavior, varied and strong
    //   Very Hard(3): hi end plus 1 (capped) — exceeds archetype limits
    const bias = (range: [number, number], cap: number): number => {
      if (difficulty <= DIFFICULTY_EASY) return Math.max(1, range[0] - 1);
      if (difficulty === DIFFICULTY_NORMAL) return range[0];
      if (difficulty === DIFFICULTY_HARD) return this.rng.int(...range);
      if (difficulty >= DIFFICULTY_VERY_HARD)
        return Math.min(cap, range[1] + 1);
      return this.rng.int(...range);
    };

    this.buildSkill = bias(profile.buildSkill, 5) as 1 | 2 | 3 | 4 | 5;
    this.spatialAwareness = bias(profile.spatialAwareness, 3) as 1 | 2 | 3;
    this.aggressiveness = bias(profile.aggressiveness, 3) as 1 | 2 | 3;
    this.defensiveness = bias(profile.defensiveness, 3) as 1 | 2 | 3;
    this.battleTactics = bias(profile.battleTactics, 3) as 1 | 2 | 3;
    this.cursorSkill = bias(profile.cursorSkill, 3) as 1 | 2 | 3;
    this.thinkingSpeed = bias(profile.thinkingSpeed, 3) as 1 | 2 | 3;
    this.caresAboutHouses = this.rng.bool(profile.caresAboutHouses);
    this.caresAboutBonuses = this.rng.bool(profile.caresAboutBonuses);
    this.bankHugging = this.rng.bool(profile.bankHugging);
  }

  /** Castle ring margin for secondary towers (derived from aggressiveness). */
  private get castleMargin(): 2 | 3 {
    return this.aggressiveness >= 3 ? 3 : 2;
  }

  get homeWasBroken(): boolean {
    return this._homeWasBroken;
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
    playerId: ValidPlayerSlot,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null {
    return pickPlacement(state, playerId, piece, {
      cursorPos,
      homeWasBroken: this._homeWasBroken,
      castleMargin: this.castleMargin,
      bankHugging: this.bankHugging,
      caresAboutHouses: this.caresAboutHouses,
      caresAboutBonuses: this.caresAboutBonuses,
      buildSkill: this.buildSkill,
    });
  }

  /** Assess home tower enclosure at END of build phase. The result is stale
   *  by design — `_homeWasBroken` is consumed during the NEXT build phase's
   *  pickPlacement(), reflecting last round's outcome, not real-time state. */
  assessBuildEnd(state: GameViewState, playerId: ValidPlayerSlot): void {
    const player = state.players[playerId]!;
    this._homeWasBroken = false;
    if (player.homeTower) {
      const outside = computeOutside(player.walls, waterKeys(state.map.tiles));
      this._homeWasBroken = !isTowerEnclosed(player.homeTower, outside);
    }
  }

  // -----------------------------------------------------------------------
  // Cannon placement
  // -----------------------------------------------------------------------

  initCannonPhase(
    player: Player,
    count: number,
    _state: CannonViewState,
  ): CannonPlacementContext {
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

  planBattle(state: BattleViewState, playerId: ValidPlayerSlot): BattlePlan {
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
    if (usableCannonCount > CHAIN_ATTACK_MIN_CANNONS) {
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
      usableCannonCount > CHAIN_ATTACK_MIN_CANNONS &&
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
    playerId: ValidPlayerSlot,
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
      wallsOnly,
      this.battleTactics,
      this.rng,
    );
  }

  trackShot(
    state: BattleViewState,
    playerId: ValidPlayerSlot,
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
    this.shotCounts = new Map();
  }
}

/** Standalone pickPlacement wrapper for headless tests / external callers. */
export function pickPlacementStandalone(
  state: BuildViewState,
  playerId: ValidPlayerSlot,
  piece: PieceShape,
  cursorPos?: TilePos,
): AiPlacement | null {
  return pickPlacement(
    state,
    playerId,
    piece,
    cursorPos ? { cursorPos } : undefined,
  );
}

function rollArchetype(rng: Rng): ArchetypeType {
  return rng.pick(ARCHETYPE_LIST);
}
