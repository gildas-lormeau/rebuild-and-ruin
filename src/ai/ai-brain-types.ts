/**
 * AiBrain interface — the seam between AiController and a concrete AI
 * implementation. The controller owns animation timing, cursor state, and
 * lifecycle hooks; the brain owns phase state machines and decision
 * dispatch. Swapping in an alternate brain lets new AI experiments coexist
 * with the default one without touching the controller.
 */

import type {
  LifeLostEntry,
  ResolvedChoice,
  UpgradePickEntry,
} from "../shared/core/dialog-state.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  GameViewState,
  PlaceCannonIntent,
  UpgradePickViewState,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type {
  BattleHost,
  BattleTickResult,
  BuildHost,
  BuildTickResult,
  CannonHost,
  CannonTickResult,
  SelectionHost,
} from "./ai-strategy-types.ts";

interface AiBrainSelection {
  init(host: SelectionHost, state: GameViewState, zone: ZoneId): void;
  tick(host: SelectionHost, state?: GameViewState): boolean;
  reset(): void;
}

interface AiBrainBuild {
  init(host: BuildHost, state: BuildViewState): void;
  tick(host: BuildHost, state: BuildViewState): BuildTickResult;
  /** Resolve the DWELLING state after the controller commits the intent
   *  returned by `tick`. On success → THINKING with POST_PLACE delay.
   *  On first failure → stay in DWELLING with BLOCKED_RETRY (lets a
   *  passing grunt clear). On second failure → THINKING with
   *  QUICK_RETHINK (pivot to a different placement). */
  onPlaceResult(host: BuildHost, state: BuildViewState, success: boolean): void;
  finalize(host: BuildHost, state: BuildViewState): void;
  reset(): void;
  /** Cursor speed (tiles/sec) for a given strategy cursorSkill (1..3). */
  cursorSpeedFor(cursorSkill: 1 | 2 | 3): number;
}

interface AiBrainCannon {
  init(host: CannonHost, state: CannonViewState, maxSlots: number): void;
  tick(host: CannonHost, state: CannonViewState): CannonTickResult;
  /** Plan all remaining placements at end-of-phase. Yields intents one
   *  at a time — caller commits each intent BEFORE pulling the next, so
   *  the brain's slot-accounting reads include the caller's per-yield
   *  mutations. Caller is expected to break on the first commit failure.
   *  The generator's `finally` clears the brain's flush context even
   *  when the caller exits the loop early. */
  flush(
    host: CannonHost,
    state: CannonViewState,
  ): Generator<PlaceCannonIntent, void>;
  isDone(): boolean;
  reset(): void;
  /** maxSlots captured at init — assisted-human reads this when scheduling
   *  cannon placements through the wire path. */
  readonly maxSlots: number;
  /** Cursor speed (tiles/sec) for a given strategy cursorSkill (1..3). */
  cursorSpeedFor(cursorSkill: 1 | 2 | 3): number;
}

interface AiBrainBattle {
  init(host: BattleHost, state?: BattleViewState): void;
  tick(host: BattleHost, state: BattleViewState): BattleTickResult;
  /** Resolve the (CHAIN_)DWELLING state after the controller commits the
   *  intent returned by `tick`. On success → trackShot + advance to the
   *  next chain step / re-pick. On failure → hold the dwell with
   *  CANNON_RETRY_WAIT so the same aim is retried once a cannon is
   *  ready. Dispatches off `phase.state.step` (CHAIN_DWELLING vs
   *  DWELLING) which is preserved across the commit. */
  onFireResult(
    host: BattleHost,
    state: BattleViewState,
    success: boolean,
  ): void;
  /** Reset all battle state except orbit angle (preserved across countdown). */
  resetKeepOrbit(): void;
  /** Seed the pre-battle orbit angle — called by the controller from
   *  `onResetBattle` so each battle re-rolls a fresh orbit from `strategy.rng`. */
  setOrbitAngle(angle: number): void;
}

export interface AiBrain {
  readonly selection: AiBrainSelection;
  readonly build: AiBrainBuild;
  readonly cannon: AiBrainCannon;
  readonly battle: AiBrainBattle;

  /** Auto-resolve the AI's life-lost dialog choice given the entry + state.
   *  Returns CONTINUE or ABANDON — never PENDING; the brain owes a decision. */
  chooseLifeLost(entry: LifeLostEntry, state: GameViewState): ResolvedChoice;

  /** Advance the AI's upgrade-pick animation + commit when ready. */
  tickUpgradePick(
    entry: UpgradePickEntry,
    entryIdx: number,
    autoDelayTicks: number,
    dialogTimer: number,
    state: UpgradePickViewState,
  ): void;
}
