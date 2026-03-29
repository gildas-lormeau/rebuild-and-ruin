/**
 * Shared phase-transition helpers consumed by both local runtime and online client.
 *
 * Owns the canonical *ordering* and *what* of each phase transition —
 * callers supply the *how* via dependency injection.  This prevents
 * silent drift between the host (runtime-host-phase-ticks / runtime-selection)
 * and the watcher (online-phase-transitions).
 */

import {
  BANNER_BATTLE_SUB,
  BANNER_BUILD_SUB,
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
  type BannerShow,
} from "./phase-banner.ts";

interface BuildEndSequenceDeps {
  readonly needsReselect: readonly number[];
  readonly eliminated: readonly number[];
  /** Display score deltas, then call onDone when animation finishes. */
  showScoreDeltas: (onDone: () => void) => void;
  /** Notify a controller that its player lost a life.
   *  Callers filter to locally-owned controllers (host skips remote, watcher
   *  skips AI — but the *sequence* of iterate-then-dialog is shared). */
  notifyLifeLost: (playerId: number) => void;
  /** Show the life-lost continue/abandon dialog. */
  showLifeLostDialog: (
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) => void;
  /** Advance to next phase when no players need reselection.
   *  Host-only — watchers omit this (they wait for the host's next message). */
  afterLifeLostResolved?: () => void;
}

type TransitionStep =
  | typeof SHOW_BANNER
  | typeof RECONCILE
  | typeof SNAPSHOT
  | typeof INIT_CTRL;

/** Named steps in a phase transition. The recipe declares their ordering;
 *  host and watcher supply different adapter implementations for each step. */
const SHOW_BANNER = "showBanner" as const;
const RECONCILE = "reconcileState" as const;
const SNAPSHOT = "snapshotForBanner" as const;
const INIT_CTRL = "initControllers" as const;
/** Ordered steps for the build→cannon transition (cannon start). */
export const CANNON_START_STEPS = [RECONCILE, INIT_CTRL, SHOW_BANNER] as const;
/** Ordered steps for the cannon→battle transition (battle start). */
export const BATTLE_START_STEPS = [SHOW_BANNER, RECONCILE, SNAPSHOT] as const;
/** Ordered steps for the battle→build transition (build start). */
export const BUILD_START_STEPS = [SHOW_BANNER, RECONCILE, INIT_CTRL] as const;

/** Show the "Place Cannons" banner with its canonical subtitle. */
export function showCannonPhaseBanner(
  show: BannerShow,
  onDone: () => void,
): void {
  show(BANNER_PLACE_CANNONS, onDone, true, undefined, BANNER_PLACE_CANNONS_SUB);
}

/** Show the battle-start banner with its canonical subtitle.
 *  `text` varies by context (e.g. "BATTLE!" vs "Battle!"). */
export function showBattlePhaseBanner(
  show: BannerShow,
  text: string,
  onDone: () => void,
): void {
  show(text, onDone, true, undefined, BANNER_BATTLE_SUB);
}

/** Show the build/repair banner with its canonical subtitle.
 *  `text` varies by context (e.g. "Repair walls" vs "Repair!"). */
export function showBuildPhaseBanner(
  show: BannerShow,
  text: string,
  onDone: () => void,
): void {
  show(text, onDone, true, undefined, BANNER_BUILD_SUB);
}

/** Execute a phase transition recipe: run each named step in declared order.
 *  Host and watcher provide different adapter implementations; the recipe
 *  ensures both follow the same step ordering. */
export function executeTransition<S extends TransitionStep>(
  steps: readonly S[],
  adapters: Readonly<Record<S, () => void>>,
): void {
  for (const step of steps) {
    adapters[step]();
  }
}

/** Canonical post-build-end sequence shared by host and watcher.
 *
 *  1. Show score deltas animation
 *  2. Notify each affected controller via `notifyLifeLost`
 *  3. Show life-lost dialog (if any), else advance directly */
export function runBuildEndSequence(deps: BuildEndSequenceDeps): void {
  deps.showScoreDeltas(() => {
    for (const pid of [...deps.needsReselect, ...deps.eliminated]) {
      deps.notifyLifeLost(pid);
    }

    if (deps.needsReselect.length > 0 || deps.eliminated.length > 0) {
      deps.showLifeLostDialog(deps.needsReselect, deps.eliminated);
      return;
    }

    deps.afterLifeLostResolved?.();
  });
}
