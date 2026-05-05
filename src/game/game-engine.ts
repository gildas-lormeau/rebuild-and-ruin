/**
 * Game Engine — state machine and state factory.
 *
 * Phases (in order):
 *   1. CASTLE_SELECT  — each player picks a home castle (tower)
 *   2. WALL_BUILD     — first round: auto-build walls; later: repair with pieces (25s timer)
 *   3. CANNON_PLACE   — place cannons inside walled territory
 *   4. BATTLE         — fire cannons at enemies (10s timer)
 *   → back to WALL_BUILD (repair phase)
 *
 * A player loses if they fail to surround at least one castle during WALL_BUILD.
 *
 * Phase transition recipes live in phase-setup.ts.
 */

import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { EMPTY_FEATURES } from "../shared/core/feature-defs.ts";
import {
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_ROUND_CANNONS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  MODIFIER_REVEAL_TIMER,
  type ModifierDiff,
  STARTING_LIVES,
} from "../shared/core/game-constants.ts";
import { createGameEventBus } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  emptyFreshInterior,
  type Player,
} from "../shared/core/player-types.ts";
import {
  type GameState,
  type SelectionState,
  setGameMode,
} from "../shared/core/types.ts";
import { Rng } from "../shared/platform/rng.ts";
import { resolveBalloons } from "./battle-system.ts";
import {
  prepareCannonPhase,
  prepareControllerCannonPhase,
} from "./cannon-system.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";
import { prepareBattleState, setPhase } from "./phase-setup.ts";
import { initSelectionTimer, initTowerSelection } from "./selection.ts";
import { buildTimerBonus } from "./upgrade-system.ts";

/** Result of `prepareBattle` — what the caller needs to wire up the
 *  modifier-reveal banner, balloon animation, and online broadcast.
 *  The phase flag is NOT yet flipped to BATTLE here — that happens later
 *  via `enterBattlePhase` after the modifier-reveal banner finishes.
 *  battleAnim territory / wall snapshots are rebuilt from `state` by the
 *  machine's `postMutate: syncBattleAnim`, so they're not threaded here. */
interface BattlePrep {
  /** Modifier rolled for this battle, or null if classic mode / no roll. */
  modifierDiff: ModifierDiff | null;
  /** Balloons launched this battle (empty if no balloon cannons). */
  flights: BalloonFlight[];
}

/** Per-player init data for the cannon placement phase.
 *  Null for eliminated players (no cannons to place). */
interface PlayerCannonInit {
  maxSlots: number;
  cursorPos: { row: number; col: number };
}

/** Result of `enterCannonPhase` — per-player init data the caller uses to
 *  initialize local controllers in the initControllers step.
 *  Index = playerId; null entries are eliminated players or empty slots. */
interface CannonPhaseEntry {
  playerInit: readonly (PlayerCannonInit | null)[];
}

/** Create a game from a seed: generate map, pick zones, create state.
 *  Pass an existing map to reuse it (avoids regeneration + keeps terrain cache warm). */
export function createGameFromSeed(
  seed: number,
  maxPlayers: number,
  existingMap?: GameMap,
): { map: GameMap; state: GameState; zones: number[]; playerCount: number } {
  const map = existingMap ?? generateMap(seed);
  const zones = topZonesBySize(map, maxPlayers).map(({ zone }) => zone);
  const playerCount = Math.min(zones.length, maxPlayers);
  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones.slice();
  return { map, state, zones, playerCount };
}

/** Apply per-match game configuration to a freshly created GameState.
 *  Called by bootstrapGame after createGameFromSeed. Keeps all game-config
 *  mutation inside the game domain. */
export function applyGameConfig(
  state: GameState,
  config: {
    maxRounds: number;
    cannonMaxHp: number;
    buildTimer: number;
    cannonPlaceTimer: number;
    firstRoundCannons: number;
    gameMode: GameMode;
  },
): void {
  state.maxRounds = config.maxRounds > 0 ? config.maxRounds : Infinity;
  state.cannonMaxHp = config.cannonMaxHp;
  state.buildTimer = config.buildTimer;
  state.cannonPlaceTimer = config.cannonPlaceTimer;
  state.firstRoundCannons = config.firstRoundCannons;
  setGameMode(
    state,
    config.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
  );
}

/** Flip the phase flag to CASTLE_RESELECT and zero the timer.
 *  Narrow primitive — does NOT init per-player selection state.
 *  Use `enterReselectPhase` for the full enter-with-init when starting
 *  a reselection round; this helper exists for the rare case where the
 *  flag needs flipping in isolation (mid-game watcher join). */
export function setReselectPhase(state: GameState): void {
  setPhase(state, Phase.CASTLE_RESELECT);
  state.timer = 0;
}

/** Pre-battle setup: roll the modifier and resolve balloon flights in
 *  RNG-load-bearing order. Returns the data the caller needs to react
 *  (banner palette, balloon animation, online broadcast). Does NOT flip
 *  the phase flag — `enterBattlePhase` does that later, after the
 *  modifier-reveal banner finishes. Every peer runs this in lockstep so
 *  state.rng draws stay aligned. */
export function prepareBattle(state: GameState): BattlePrep {
  const modifierDiff = prepareBattleState(state);
  const flights = resolveBalloons(state);
  return { modifierDiff, flights };
}

/** Flip to MODIFIER_REVEAL and prime the dwell timer. The reveal banner
 *  uses `state.activeModifier` already populated by `prepareBattle`. */
export function enterModifierRevealPhase(state: GameState): void {
  setPhase(state, Phase.MODIFIER_REVEAL);
  state.timer = MODIFIER_REVEAL_TIMER;
}

/** Flip to BATTLE. No timer prime — `tickBattlePhase`'s first frame
 *  re-anchors `state.timer` from `accum.battle` against `BATTLE_TIMER`,
 *  and `prepareBattle` (run earlier in the same chain) already set the
 *  cannon-place-display value defensively. */
export function enterBattlePhase(state: GameState): void {
  setPhase(state, Phase.BATTLE);
}

/** Flip to UPGRADE_PICK. The pick UI prepare hook is runtime-side and
 *  fires from the transition mutate immediately after this. */
export function enterUpgradePickPhase(state: GameState): void {
  setPhase(state, Phase.UPGRADE_PICK);
}

/** Flip to WALL_BUILD and anchor the entry-time timer. Anchoring runs here
 *  AFTER `applyUpgradePicks` and `resetPlayerUpgrades` have settled the
 *  upgrade set for this round — anchoring earlier would reflect the
 *  PREVIOUS round's bonuses and diverge host vs watcher on phase length. */
export function enterWallBuildPhase(state: GameState): void {
  setPhase(state, Phase.WALL_BUILD);
  state.timer = state.buildTimer + buildTimerBonus(state);
}

/** Enter the cannon placement phase. Sets the phase flag, computes cannon
 *  limits and default facings, resets the timer, and returns per-player
 *  init data (max slots + starting cursor position) for every active slot.
 *
 *  Replaces the runtime's manual sequence of `enterCannonPlacePhase` +
 *  `prepareCannonPhase` + per-player `prepareControllerCannonPhase`. The
 *  engine owns the order; the runtime consumes the returned struct to
 *  initialize its local controllers. */
export function enterCannonPhase(state: GameState): CannonPhaseEntry {
  enterCannonPlacePhase(state);
  prepareCannonPhase(state);
  const playerInit = state.players.map((_, idx) =>
    prepareControllerCannonPhase(idx as ValidPlayerSlot, state),
  );
  return { playerInit };
}

/** Enter the CASTLE_SELECT / CASTLE_RESELECT phase: clear any stale
 *  per-player selection tracking, initialize each active player's
 *  selection entry (with a default highlight on their zone's first tower
 *  or their current home tower), and start the selection timer.
 *
 *  Replaces the runtime's manual sequence of `selectionStates.clear()` +
 *  per-player `initTowerSelection` loop + `initSelectionTimer`. The
 *  engine owns the order; the runtime runs its own per-player camera +
 *  controller setup loop afterwards.
 *
 *  Note: `selectionStates` is a runtime-owned Map (not part of GameState)
 *  because it's transient UI-tracking state that only exists during the
 *  selection phase. The engine mutates it through the passed reference. */
export function enterSelectionPhase(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
): void {
  selectionStates.clear();
  for (let i = 0; i < state.players.length; i++) {
    const pid = i as ValidPlayerSlot;
    const zone = state.playerZones[i] ?? 0;
    initTowerSelection(state, selectionStates, pid, zone);
  }
  initSelectionTimer(state);
}

/** Enter the CASTLE_RESELECT phase for players who lost a life. Sets the
 *  phase flag, clears any stale per-player selection tracking, initializes
 *  a fresh selection entry for each player in the reselect queue (with a
 *  default highlight on their zone's first tower), and starts the
 *  selection timer.
 *
 *  Replaces the runtime's manual sequence of `setReselectPhase` +
 *  `selectionStates.clear()` + per-player init via `processReselectionQueue`
 *  callback + `initSelectionTimer`. The engine owns the order; the runtime
 *  runs its own per-player controller (`selectReplacementTower`) + camera
 *  setup loop afterwards. */
export function enterReselectPhase(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  reselectQueue: readonly ValidPlayerSlot[],
): void {
  setPhase(state, Phase.CASTLE_RESELECT);
  state.timer = 0;
  selectionStates.clear();
  for (const pid of reselectQueue) {
    const zone = state.playerZones[pid] ?? 0;
    initTowerSelection(state, selectionStates, pid, zone);
  }
  initSelectionTimer(state);
}

/** Transition game state to CANNON_PLACE. This only sets the phase flag and
 *  timer; callers should prefer `enterCannonPhase` which additionally runs
 *  preparation (limits, facings) and returns per-player init data.
 *  Private — internal helper for enterCannonPhase. */
function enterCannonPlacePhase(state: GameState): void {
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = 0;
  // Reset per-slot done tracking. Populated by local controllers' done
  // detection + wire signal for remote-driven slots; consulted by the
  // phase-exit predicate to wait for every active slot before advancing.
  state.cannonPlaceDone.clear();
  state.pendingCannonPlaceDone.clear();
}

function createGameState(
  map: GameMap,
  playerCount: number,
  seed?: number,
): GameState {
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i as ValidPlayerSlot,
      homeTower: null,
      castle: null,
      ownedTowers: [],
      walls: new Set(),
      interior: emptyFreshInterior(),
      cannons: [],
      lives: STARTING_LIVES,
      eliminated: false,
      score: 0,
      defaultFacing: 0,
      castleWallTiles: new Set(),
      upgrades: new Map(),
      damagedWalls: new Set(),
      freshCastle: false,
      bag: undefined,
      currentPiece: undefined,
    });
  }

  return {
    rng: new Rng(seed),
    map,
    bus: createGameEventBus(),
    phase: Phase.CASTLE_SELECT,
    round: 1,
    maxRounds: Infinity,
    cannonMaxHp: CANNON_MAX_HP,
    buildTimer: BUILD_TIMER,
    cannonPlaceTimer: CANNON_PLACE_TIMER,
    firstRoundCannons: FIRST_ROUND_CANNONS,
    players,
    timer: 0,
    cannonballs: [],
    shotsFired: 0,
    grunts: [],
    towerAlive: map.towers.map(() => true),
    towerPendingRevive: new Set(),
    burningPits: [],
    capturedCannons: [],
    bonusSquares: [],
    battleCountdown: 0,
    reselectedPlayers: new Set(),
    playerZones: [],
    cannonLimits: [],
    cannonPlaceDone: new Set(),
    salvageSlots: [],
    gameMode: GAME_MODE_CLASSIC,
    activeFeatures: EMPTY_FEATURES,
    modern: null,
    simTick: 0,
    pendingCannonFires: new Set(),
    pendingCannonSlotCost: players.map(() => 0),
    pendingCannonPlaceDone: new Set(),
  };
}
