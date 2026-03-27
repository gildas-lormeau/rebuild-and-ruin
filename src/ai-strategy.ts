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

import type { AiPlacement } from "./ai-build-types.ts";
import { traitLookup } from "./ai-constants.ts";
import {
  countUsableCannons,
  pickTarget,
  planCharitySweep,
  planGruntSweep,
  planPocketDestruction,
  planSuperAttack,
  planWallDemolition,
  trackShot,
} from "./ai-strategy-battle.ts";
import { pickPlacement as pickPlacementCore } from "./ai-strategy-build.ts";
import {
  autoPlaceCannons as autoPlaceCannonsCore,
  autoSelectTower,
} from "./ai-strategy-cannon.ts";
import { getActiveEnemies } from "./board-occupancy.ts";
import type { GameMap, PixelPos, StrategicPixelPos, TilePos, Tower } from "./geometry-types.ts";
import type { PieceShape } from "./pieces.ts";
import { MAX_UINT32, Rng } from "./rng.ts";
import { computeOutside, isTowerEnclosed, waterKeys } from "./spatial.ts";
import { type Cannon, CannonMode, type GameState, type Player } from "./types.ts";

export type ChainType = (typeof Chain)[keyof typeof Chain];

/** Result of planBattle — tells the controller what chain attack to execute. */
export interface BattlePlan {
  chainTargets: TilePos[] | null;
  chainType: ChainType;
}

/** A single cannon placement decision. */
export interface CannonPlacement {
  row: number;
  col: number;
  mode?: CannonMode.SUPER | CannonMode.BALLOON;
}

export interface AiStrategy {
  /** Seeded PRNG for reproducible AI behavior. */
  readonly rng: Rng;

  /** Pick a home tower for the AI player. Returns the chosen tower or null. */
  selectTower(map: GameMap, zone: number): Tower | null;

  /** Pick the best placement for the current piece. */
  pickPlacement(
    state: GameState,
    playerId: number,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null;

  /** Called at the end of the build phase — assess home tower status. */
  assessBuildEnd(state: GameState, playerId: number): void;

  /** Whether home tower was not enclosed at the end of last build phase. */
  readonly homeWasBroken: boolean;

  /** Decide cannon placements inside the player"s territory. */
  placeCannons(
    player: Player,
    count: number,
    state: GameState,
  ): CannonPlacement[];

  /** Plan the battle: pick focus target, decide chain attacks. */
  planBattle(state: GameState, playerId: number): BattlePlan;

  /** Pick a target to fire at. strategic = wall between obstacles. wallsOnly = skip cannon targets. */
  pickTarget(
    state: GameState,
    playerId: number,
    crosshair: PixelPos,
    wallsOnly?: boolean,
  ): StrategicPixelPos | null;

  /** Record a shot at whatever cannon is at the crosshair position. */
  trackShot(state: GameState, playerId: number, crosshair: PixelPos): void;

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
export const Chain = {
  WALL: "wall",
  GRUNT: "grunt",
  POCKET: "pocket",
} as const;

export class DefaultStrategy implements AiStrategy {
  /** Shot count per cannon — tracks hits to know when to stop targeting. */
  private shotCounts = new WeakMap<Cannon, number>();
  /** Focus fire on this player during battle. */
  private focusPlayerId: number | null = null;
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
   * @param difficulty — 0=Easy, 1=Normal, 2=Hard, 3=Very Hard; clamps trait ranges
   */
  constructor(archetype?: ArchetypeType, seed?: number, difficulty: number = 1) {
    this.rng = new Rng(seed);
    this.archetype = archetype ?? rollArchetype(this.rng);
    const p = ARCHETYPE_PROFILES[this.archetype];

    // Difficulty biases trait rolls within archetype ranges:
    //   Easy(0):      lo end minus 1 (floor 1) — noticeably weaker than archetype baseline
    //   Normal(1):    always lo end of range — competent but beatable
    //   Hard(2):      roll uniformly in [lo, hi] — original behavior, varied and strong
    //   Very Hard(3): hi end plus 1 (capped) — exceeds archetype limits
    const bias = (range: [number, number], cap: number): number => {
      if (difficulty <= 0) return Math.max(1, range[0] - 1);
      if (difficulty === 1) return range[0];
      if (difficulty >= 3) return Math.min(cap, range[1] + 1);
      return this.rng.int(...range);
    };

    this.buildSkill = bias(p.buildSkill, 5) as 1 | 2 | 3 | 4 | 5;
    this.spatialAwareness = bias(p.spatialAwareness, 3) as 1 | 2 | 3;
    this.aggressiveness = bias(p.aggressiveness, 3) as 1 | 2 | 3;
    this.defensiveness = bias(p.defensiveness, 3) as 1 | 2 | 3;
    this.battleTactics = bias(p.battleTactics, 3) as 1 | 2 | 3;
    this.cursorSkill = bias(p.cursorSkill, 3) as 1 | 2 | 3;
    this.thinkingSpeed = bias(p.thinkingSpeed, 3) as 1 | 2 | 3;
    this.caresAboutHouses = this.rng.bool(p.caresAboutHouses);
    this.caresAboutBonuses = this.rng.bool(p.caresAboutBonuses);
    this.bankHugging = this.rng.bool(p.bankHugging);
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

  selectTower(map: GameMap, zone: number): Tower | null {
    return autoSelectTower(map, zone, this.rng, this.spatialAwareness);
  }

  // -----------------------------------------------------------------------
  // Build phase
  // -----------------------------------------------------------------------

  pickPlacement(
    state: GameState,
    playerId: number,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null {
    return pickPlacementCore(state, playerId, piece, {
      cursorPos,
      homeWasBroken: this._homeWasBroken,
      castleMargin: this.castleMargin,
      bankHugging: this.bankHugging,
      caresAboutHouses: this.caresAboutHouses,
      caresAboutBonuses: this.caresAboutBonuses,
      buildSkill: this.buildSkill,
    });
  }

  assessBuildEnd(state: GameState, playerId: number): void {
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

  placeCannons(
    player: Player,
    count: number,
    state: GameState,
  ): CannonPlacement[] {
    const planningPlayer: Player = {
      ...player,
      ownedTowers: [...player.ownedTowers],
      walls: new Set(player.walls),
      interior: new Set(player.interior),
      cannons: [...player.cannons],
    };
    const placed = autoPlaceCannonsCore(
      planningPlayer,
      count,
      state,
      this.rng,
      this.aggressiveness,
      this.defensiveness,
      this.spatialAwareness,
    );
    return placed.map((c) => ({
      row: c.row,
      col: c.col,
      mode: c.kind === CannonMode.NORMAL ? undefined : c.kind,
    }));
  }

  // -----------------------------------------------------------------------
  // Battle
  // -----------------------------------------------------------------------

  planBattle(state: GameState, playerId: number): BattlePlan {
    // Focus fire probability scales with battleTactics
    const focusProb = traitLookup(this.battleTactics, [
      0.2,
      FOCUS_FIRE_PROBABILITY,
      0.8,
    ]);
    if (this.rng.bool(focusProb)) {
      const enemies = getActiveEnemies(state, playerId);
      if (enemies.length > 0) {
        enemies.sort(
          (a, b) =>
            a.ownedTowers.length - b.ownedTowers.length || a.score - b.score,
        );
        this.focusPlayerId = enemies[0]!.id;
      } else {
        this.focusPlayerId = null;
      }
    } else {
      this.focusPlayerId = null;
    }

    // Chain attacks
    let chainTargets: TilePos[] | null = null;
    let chainType: ChainType = Chain.WALL;

    const readyCount = countUsableCannons(state, playerId);

    // Grunt sweep: enough grunts targeting us and enough usable cannons
    if (readyCount > CHAIN_ATTACK_MIN_CANNONS) {
      const gruntTargets = planGruntSweep(
        state,
        playerId,
        readyCount,
        this.rng,
      );
      if (gruntTargets) {
        chainTargets = gruntTargets;
        chainType = Chain.GRUNT;
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
      readyCount > CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(charityProb)
    ) {
      const charityTargets = planCharitySweep(
        state,
        playerId,
        readyCount,
        this.rng,
      );
      if (charityTargets) {
        chainTargets = charityTargets;
        chainType = Chain.GRUNT;
      }
    }

    // Pocket destruction
    if (!chainTargets) {
      const pocketTargets = planPocketDestruction(state, playerId);
      if (pocketTargets) {
        chainTargets = pocketTargets;
        chainType = Chain.POCKET;
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
      readyCount >= CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(demolitionProb)
    ) {
      chainTargets = planWallDemolition(state, playerId, readyCount, this.rng);
      chainType = Chain.WALL;
    }

    // Super attack — controlled by battleTactics
    const superAtkProb = traitLookup(this.battleTactics, [
      0,
      SUPER_ATTACK_PROBABILITY,
      1 / 4,
    ]);
    if (
      !chainTargets &&
      readyCount >= CHAIN_ATTACK_MIN_CANNONS &&
      this.rng.bool(superAtkProb)
    ) {
      chainTargets = planSuperAttack(state, playerId, readyCount, this.rng);
      chainType = Chain.WALL;
    }

    return { chainTargets, chainType };
  }

  pickTarget(
    state: GameState,
    playerId: number,
    crosshair: PixelPos,
    wallsOnly?: boolean,
  ): StrategicPixelPos | null {
    return pickTarget(
      state,
      playerId,
      crosshair,
      this.focusPlayerId,
      this.shotCounts,
      wallsOnly,
      this.battleTactics,
      this.rng,
    );
  }

  trackShot(state: GameState, playerId: number, crosshair: PixelPos): void {
    trackShot(state, playerId, crosshair, this.shotCounts);
  }

  onLifeLost(): void {
    this.focusPlayerId = null;
    this._homeWasBroken = false;
  }

  reset(): void {
    this.onLifeLost();
    this.shotCounts = new WeakMap();
  }
}

/** Auto-place cannons directly on the player at scored positions inside their castle.
 *  Uses balanced traits (no personality variance) for deterministic fallback behavior. */
export function autoPlaceCannons(
  player: Player,
  count: number,
  state: GameState,
): void {
  autoPlaceCannonsCore(player, count, state, new Rng(state.rng.int(0, MAX_UINT32)));
}

/** Standalone pickPlacement wrapper for headless tests / external callers. */
export function pickPlacement(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  cursorPos?: TilePos,
): AiPlacement | null {
  return pickPlacementCore(state, playerId, piece, cursorPos ? { cursorPos } : undefined);
}

function rollArchetype(rng: Rng): ArchetypeType {
  return rng.pick(ARCHETYPE_LIST);
}
