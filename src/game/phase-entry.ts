/**
 * Per-phase entry helpers + pre-battle composer. Each `enter*Phase` is
 * the single way to flip `state.phase` and prime entry-time `timer` —
 * runtime transitions call these from `mutate` rather than touching
 * `setPhase` directly. `prepareBattle` sequences `prepareBattleState`
 * then `resolveBalloons` in RNG-load-bearing order before the phase
 * flips. Match setup is in `game-init.ts`; recipes in `phase-setup.ts`.
 */

import type { BalloonFlight } from "../shared/core/battle-types.ts";
import {
  BATTLE_TIMER,
  BUILD_LOCKOUT_BONUS_SECONDS,
  MODIFIER_REVEAL_TIMER,
  SELECT_TIMER,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ModifierDiff } from "../shared/core/modifier-defs.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { GameState, SelectionState } from "../shared/core/types.ts";
import { resolveBalloons } from "./battle-system.ts";
import { prepareCannonPhase } from "./cannon-system.ts";
import { drainSupplyBuildLockoutEarners } from "./modifiers/supply-ship.ts";
import { prepareBattleState, setPhase } from "./phase-setup.ts";
import { initTowerSelection } from "./selection.ts";
import { buildTimerBonus, onBuildPhaseStart } from "./upgrade-system.ts";

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

/** Flip to BATTLE and prime the battle timer. The prime matters during
 *  the countdown: AI's `pickTarget` reads `state.timer` to detect "second
 *  half of battle", and without this prime modern-with-modifier would
 *  enter countdown with `state.timer ≈ 0` (decayed by MODIFIER_REVEAL).
 *  `tickBattlePhase`'s first frame re-anchors against BATTLE_TIMER from
 *  `accum.battle` once weapons go active. */
export function enterBattlePhase(state: GameState): void {
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
}

/** Flip to ROUND_END — the self-driving round-close window. Primes no
 *  entry-time game state: the window has no `state.timer` (its score-overlay
 *  + life-lost beats are runtime-driven by `tickRoundEndPhase`), and the
 *  round-close engine work (`finalizeRound`) ran in the same `enter-round-end`
 *  mutate just before this flip. The helper exists as the sole sanctioned
 *  `setPhase` caller for this phase. The round number stays at the closing
 *  value through the whole window — the advance is deferred to the exit. */
export function enterRoundEndPhase(state: GameState): void {
  setPhase(state, Phase.ROUND_END);
}

/** Flip to UPGRADE_PICK. Unlike the other enter helpers this primes no
 *  entry-time game state, because UPGRADE_PICK has none: its countdown is a
 *  runtime dialog timer (not `state.timer`), its offers were generated a
 *  phase earlier in `prepareNextRound` (battle-done, before the BUILD_START
 *  checkpoint), and its pick dialog is built runtime-side by
 *  `ctx.upgradePick.prepare()` immediately after this. The helper still
 *  exists as the sole sanctioned `setPhase` caller for this phase. */
export function enterUpgradePickPhase(state: GameState): void {
  setPhase(state, Phase.UPGRADE_PICK);
}

/** Flip to WALL_BUILD and anchor the entry-time timer + upgrade build-phase
 *  setup. Both run here AFTER `applyUpgradePicks` and `resetPlayerUpgrades`
 *  have settled the upgrade set for this round — running them earlier (e.g.
 *  in `prepareNextRound` at battle-done, before the upgrade pick) would
 *  reflect the PREVIOUS round's picks: phase length would diverge host vs
 *  watcher, and Master Builder's exclusive-build lockout (`onBuildPhaseStart`)
 *  would be computed from last round's owners, granting no exclusive window
 *  to a player who bought it this round. */
export function enterWallBuildPhase(state: GameState): void {
  setPhase(state, Phase.WALL_BUILD);
  onBuildPhaseStart(state);
  // Drain the supply-ship `extra_build_time` queue ONCE per build entry
  // and union the earners into the SAME exclusive build-lockout state
  // Master Builder just configured above — either source seats a player
  // in the one shared head-start window (see `drainSupplyBuildLockoutEarners`).
  // A consuming drain can't be part of a per-tick recomputation, so this
  // must run here rather than inside `wallBuildTimerMax`.
  if (state.modern) {
    const supplyEarners = drainSupplyBuildLockoutEarners(state);
    if (supplyEarners.size > 0) {
      const owners = state.modern.masterBuilderOwners;
      state.modern.masterBuilderOwners = owners
        ? new Set([...owners, ...supplyEarners])
        : supplyEarners;
      state.modern.masterBuilderLockout = Math.max(
        state.modern.masterBuilderLockout,
        BUILD_LOCKOUT_BONUS_SECONDS,
      );
    }
  }
  state.timer = wallBuildTimerMax(state);
}

/** Max value of the WALL_BUILD phase timer for the CURRENT round: config
 *  base + the exclusive build-lockout bonus (Master Builder ownership
 *  and/or a sunk supply-ship `extra_build_time` bonus — both feed the
 *  same `masterBuilderOwners` set, so `buildTimerBonus` covers either
 *  source without a separate additive term). Single source of truth for
 *  the entry prime above, the per-tick `advancePhaseTimer` max in
 *  `tickBuildPhase`, and the FULL_STATE accumulator resync
 *  (`syncAccumulatorsFromTimer`) — the bug this replaces was a two-term
 *  copy of this sum in the tick path silently clobbering the entry
 *  prime's third term. */
export function wallBuildTimerMax(state: GameState): number {
  return state.buildTimer + buildTimerBonus(state);
}

/** Enter the cannon placement phase: set the phase flag, prime the
 *  entry-time timer, reset per-slot done tracking, and run preparation
 *  (cannon limits, default facings). Controller init is runtime-owned —
 *  the banner postDisplay loop primes each local controller via
 *  `primeControllerForCannonPhase`, which re-derives per-player prep
 *  from the state populated here. */
export function enterCannonPhase(state: GameState): void {
  enterCannonPlacePhase(state);
  prepareCannonPhase(state);
}

/** Enter CASTLE_SELECT: flip the phase flag, clear any stale per-player
 *  selection tracking, initialize a selection entry for each participating
 *  player, and start the selection timer.
 *
 *  `pids` selects the cycle type:
 *  - omitted → initial cycle (round 1): every slot in `state.players`.
 *  - provided → reselect cycle (round > 1): only the queued players who
 *    lost a life. The cycle type is derived from `state.round` by
 *    consumers — the phase tag is the same in both cases.
 *
 *  Note: `selectionStates` is a runtime-owned Map (not part of GameState)
 *  because it's transient UI-tracking state that only exists during the
 *  selection phase. The engine mutates it through the passed reference. */
export function enterSelectionPhase(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
  pids?: readonly ValidPlayerId[],
): void {
  setPhase(state, Phase.CASTLE_SELECT);
  selectionStates.clear();
  const slots = pids ?? state.players.map((_, i) => i as ValidPlayerId);
  for (const pid of slots) {
    const zone = state.playerZones[pid];
    if (zone === undefined) continue;
    initTowerSelection(state, selectionStates, pid, zone);
  }
  state.timer = SELECT_TIMER;
}

/** Transition game state to CANNON_PLACE: set the phase flag, prime the
 *  entry-time timer, and reset per-slot done tracking. Callers should
 *  prefer `enterCannonPhase`, which additionally runs preparation
 *  (limits, facings). Private — internal helper for enterCannonPhase. */
function enterCannonPlacePhase(state: GameState): void {
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = state.cannonPlaceTimer;
  // Reset per-slot done tracking. Populated by local controllers' done
  // detection + wire signal for remote-driven slots; consulted by the
  // phase-exit predicate to wait for every active slot before advancing.
  state.cannonPlaceDone.clear();
  state.pendingCannonPlaceDone.clear();
}
