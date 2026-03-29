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
