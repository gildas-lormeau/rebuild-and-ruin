/**
 * Phase Entry — per-phase entry helpers + pre-battle composer.
 *
 * Each `enter*Phase` helper is the single way to flip `state.phase` to its
 * target value. Helpers also prime any entry-time `state.timer` value and
 * run any per-phase init that must happen before the first tick. Runtime
 * transitions (in `runtime-phase-machine.ts`) call these from their
 * `mutate` step — they do NOT call `setPhase` directly or write
 * `state.phase` / entry-time `state.timer` inline.
 *
 * `prepareBattle` is a pre-phase composer: it runs `prepareBattleState`
 * and `resolveBalloons` in RNG-load-bearing order before the phase flag
 * is flipped. The result feeds `enterModifierRevealPhase` (then later
 * `enterBattlePhase` after the reveal banner finishes).
 *
 * Match-lifecycle setup (createGameFromSeed, applyGameConfig) lives in
 * `game-init.ts`. Multi-step transition recipes (prepareNextRound,
 * finalizeRound, etc.) live in `phase-setup.ts`.
 */

import type { BalloonFlight } from "../shared/core/battle-types.ts";
import {
  MODIFIER_REVEAL_TIMER,
  type ModifierDiff,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { GameState, SelectionState } from "../shared/core/types.ts";
import { resolveBalloons } from "./battle-system.ts";
import {
  prepareCannonPhase,
  prepareControllerCannonPhase,
} from "./cannon-system.ts";
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

/** Enter CASTLE_SELECT for the initial-selection cycle (round 1):
 *  flip the phase flag, clear any stale per-player selection tracking,
 *  initialize each active player's selection entry, and start the
 *  selection timer. The reselect-cycle counterpart (round > 1, only the
 *  queued players participate) is `enterReselectPhase`.
 *
 *  Note: `selectionStates` is a runtime-owned Map (not part of GameState)
 *  because it's transient UI-tracking state that only exists during the
 *  selection phase. The engine mutates it through the passed reference. */
export function enterSelectionPhase(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
): void {
  setPhase(state, Phase.CASTLE_SELECT);
  selectionStates.clear();
  for (let i = 0; i < state.players.length; i++) {
    const pid = i as ValidPlayerSlot;
    const zone = state.playerZones[i] ?? 0;
    initTowerSelection(state, selectionStates, pid, zone);
  }
  initSelectionTimer(state);
}

/** Enter CASTLE_SELECT for the reselect cycle (round > 1, players who
 *  lost a life). Flips the phase flag, clears any stale per-player
 *  selection tracking, initializes a fresh selection entry for each
 *  player in the reselect queue, and starts the selection timer.
 *
 *  The cycle type (initial vs reselect) is derived from `state.round`
 *  by consumers — the phase tag is the same as `enterSelectionPhase`. */
export function enterReselectPhase(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  reselectQueue: readonly ValidPlayerSlot[],
): void {
  setPhase(state, Phase.CASTLE_SELECT);
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
