import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";

interface BuildEndSequenceDeps {
  readonly needsReselect: readonly ValidPlayerSlot[];
  readonly eliminated: readonly ValidPlayerSlot[];
  /** Display score deltas, then call onDone when animation finishes. */
  showScoreDeltas: (onDone: () => void) => void;
  /** Notify a controller that its player lost a life. */
  notifyLifeLost: (playerId: ValidPlayerSlot) => void;
  /** Show the life-lost continue/abandon dialog. */
  showLifeLostDialog: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => void;
  /** Advance to next phase when no players need reselection.
   *  Host-only — watchers omit this (they wait for the host's next message). */
  onLifeLostResolved?: () => void;
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

    deps.onLifeLostResolved?.();
  });
}
