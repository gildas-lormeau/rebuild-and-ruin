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

import type { GameState, Player, Cannon } from "./types.ts";
import { CannonMode } from "./types.ts";
import { computeOutside, waterKeys, isTowerEnclosed } from "./spatial.ts";
import type { GameMap, Tower } from "./map-generation.ts";
import type { PieceShape } from "./pieces.ts";
import type { TilePos, PixelPos, StrategicPixelPos } from "./geometry-types.ts";
import { Rng } from "./rng.ts";
import { pickPlacementImpl } from "./ai-strategy-build.ts";
import type { AiPlacement } from "./ai-strategy-build.ts";
export type { AiPlacement } from "./ai-strategy-build.ts";
import {
  autoSelectTowerImpl,
  autoPlaceCannonsImpl,
} from "./ai-strategy-cannon.ts";
import { placeCannon } from "./cannon-system.ts";
import {
  countUsableCannons,
  getActiveEnemies,
  planGruntSweep,
  planCharitySweep,
  planPocketDestruction,
  planWallDemolition,
  planSuperAttack,
  pickTargetImpl,
  trackShotImpl,
} from "./ai-strategy-battle.ts";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Look up a value from a 3-element table indexed by a 1-3 trait level. */
export function traitLookup<T>(level: number, values: readonly [T, T, T]): T {
  return values[level - 1]!;
}

// ---------------------------------------------------------------------------
// AI strategy tuning constants
// ---------------------------------------------------------------------------

/** Interior pockets smaller than this are targeted for wall destruction / penalized in placement. */
export const SMALL_POCKET_MAX_SIZE = 4;
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of chain attack the AI executes during battle. */
export const Chain = {
  WALL: "wall",
  GRUNT: "grunt",
  POCKET: "pocket",
} as const;
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

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Archetypes — correlated trait profiles
// ---------------------------------------------------------------------------

/** AI personality archetype. Determines correlated base trait values. */
export const Archetype = {
  BUILDER: "builder",
  AGGRESSIVE: "aggressive",
  TACTICIAN: "tactician",
  CHAOTIC: "chaotic",
  BALANCED: "balanced",
} as const;
export type ArchetypeType = (typeof Archetype)[keyof typeof Archetype];

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
    buildSkill: [4, 5],
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
    buildSkill: [2, 3],
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
    buildSkill: [3, 4],
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
    buildSkill: [1, 2],
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
    buildSkill: [3, 3],
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

function rollArchetype(rng: Rng): ArchetypeType {
  return rng.pick(ARCHETYPE_LIST);
}

// ---------------------------------------------------------------------------
// DefaultStrategy
// ---------------------------------------------------------------------------

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

  constructor(archetype?: ArchetypeType, seed?: number) {
    this.rng = new Rng(seed);
    this.archetype = archetype ?? rollArchetype(this.rng);
    const p = ARCHETYPE_PROFILES[this.archetype];
    this.buildSkill = this.rng.int(...p.buildSkill) as 1 | 2 | 3 | 4 | 5;
    this.spatialAwareness = this.rng.int(...p.spatialAwareness) as 1 | 2 | 3;
    this.aggressiveness = this.rng.int(...p.aggressiveness) as 1 | 2 | 3;
    this.defensiveness = this.rng.int(...p.defensiveness) as 1 | 2 | 3;
    this.battleTactics = this.rng.int(...p.battleTactics) as 1 | 2 | 3;
    this.cursorSkill = this.rng.int(...p.cursorSkill) as 1 | 2 | 3;
    this.thinkingSpeed = this.rng.int(...p.thinkingSpeed) as 1 | 2 | 3;
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
    return autoSelectTowerImpl(map, zone, this.rng, this.spatialAwareness);
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
    return pickPlacementImpl(
      state,
      playerId,
      piece,
      cursorPos,
      this._homeWasBroken,
      this.castleMargin,
      this.bankHugging,
      this.caresAboutHouses,
      this.caresAboutBonuses,
      this.buildSkill,
    );
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
    const beforeCount = planningPlayer.cannons.length;
    autoPlaceCannonsImpl(
      planningPlayer,
      count,
      state,
      this.rng,
      this.aggressiveness,
      this.defensiveness,
      this.spatialAwareness,
    );
    const newCannons = planningPlayer.cannons.slice(beforeCount);
    return newCannons.map((c) => ({
      row: c.row,
      col: c.col,
      mode: c.balloon
        ? (CannonMode.BALLOON as const)
        : c.super
          ? (CannonMode.SUPER as const)
          : undefined,
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
    return pickTargetImpl(
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
    trackShotImpl(state, playerId, crosshair, this.shotCounts);
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

// ---------------------------------------------------------------------------
// Standalone helpers (for callers without a strategy instance)
// ---------------------------------------------------------------------------

/** Auto-select a home tower for an AI player. */
export function autoSelectTower(
  player: Player,
  map: GameMap,
  zone: number,
  rng?: Rng,
): void {
  const strategy = new DefaultStrategy(undefined, rng?.int(0, 0xffffffff));
  const tower = strategy.selectTower(map, zone);
  if (tower) {
    player.homeTower = tower;
    player.ownedTowers = [tower];
  }
}

/** Auto-place cannons for an AI player at scored positions inside their castle. */
export function autoPlaceCannons(
  player: Player,
  count: number,
  state: GameState,
): void {
  const strategy = new DefaultStrategy(undefined, state.rng.int(0, 0xffffffff));
  const placements = strategy.placeCannons(player, count, state);
  for (const p of placements) {
    placeCannon(player, p.row, p.col, count, p.mode, state);
  }
}

/** Standalone pickPlacement wrapper for headless tests / external callers. */
export function pickPlacement(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  cursorPos?: TilePos,
): AiPlacement | null {
  return pickPlacementImpl(state, playerId, piece, cursorPos);
}
