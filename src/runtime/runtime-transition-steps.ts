import {
  BANNER_BATTLE_SUB,
  BANNER_BUILD_SUB,
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
  BANNER_UPGRADE_PICK,
  BANNER_UPGRADE_PICK_SUB,
} from "../game/phase-banner.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { BannerShow } from "../shared/ui-contracts.ts";

interface BuildEndSequenceDeps {
  readonly needsReselect: readonly ValidPlayerSlot[];
  readonly eliminated: readonly ValidPlayerSlot[];
  /** Display score deltas, then call onDone when animation finishes. */
  showScoreDeltas: (onDone: () => void) => void;
  /** Notify a controller that its player lost a life.
   *  Callers filter to locally-owned controllers (host skips remote, watcher
   *  skips AI — but the *sequence* of iterate-then-dialog is shared). */
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

type TransitionStep =
  | "showBanner"
  | "applyCheckpoint"
  | "snapshotForBanner"
  | "initControllers";

/** Named steps in a phase transition. The recipe declares their ordering;
 *  host and watcher supply different adapter implementations for each step.
 *
 *  - applyCheckpoint: Apply server checkpoint data to reconcile game state.
 *    Must run before any logic that reads the updated state.
 *  - initControllers: Prepare controllers for the new phase (cannon setup, build init).
 *  - showBanner: Display the phase-transition banner animation.
 *  - snapshotForBanner: Capture post-transition territory/walls for the banner overlay. */
const SHOW_BANNER = "showBanner";
const APPLY_CHECKPOINT = "applyCheckpoint";
const SNAPSHOT = "snapshotForBanner";
const INIT_CTRL = "initControllers";
/** Ordered steps for the build→cannon transition: banner first (hides new houses/bonus), then checkpoint, then controllers. */
export const CANNON_START_STEPS = [
  SHOW_BANNER,
  APPLY_CHECKPOINT,
  INIT_CTRL,
] as const;
/** Ordered steps for the cannon→battle transition: banner first (snapshots old scene), then checkpoint, then snapshot. */
export const BATTLE_START_STEPS = [
  SHOW_BANNER,
  APPLY_CHECKPOINT,
  SNAPSHOT,
] as const;
/** Ordered steps for the battle→build transition: banner first, then checkpoint, then controllers. */
export const BUILD_START_STEPS = [
  SHOW_BANNER,
  APPLY_CHECKPOINT,
  INIT_CTRL,
] as const;
/** Explicit no-op adapter for transition steps already handled before the
 *  recipe runs.  Prefer this over an inline `() => {}` so the intent is clear
 *  and grep-able. */
export const NOOP_STEP = (): void => {};

/** Show the "Place Cannons" banner with its canonical subtitle.
 *  When `modifierText` is provided, it replaces the default subtitle. */
export function showCannonPhaseBanner(
  show: BannerShow,
  onDone: () => void,
  modifierText?: string,
): void {
  const subtitle = modifierText ?? BANNER_PLACE_CANNONS_SUB;
  show(BANNER_PLACE_CANNONS, onDone, true, undefined, subtitle);
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
 *  `text` varies by context (e.g. "Repair walls" vs "Repair!").
 *  When `modifierText` is provided, it replaces the default subtitle. */
export function showBuildPhaseBanner(
  show: BannerShow,
  text: string,
  onDone: () => void,
  modifierText?: string,
): void {
  const subtitle = modifierText ?? BANNER_BUILD_SUB;
  show(text, onDone, true, undefined, subtitle);
}

/** Execute a phase transition recipe: run each named step in declared order.
 *  Host and watcher provide different adapter implementations; the recipe
 *  ensures both follow the same step ordering.
 *
 *  All steps in the recipe MUST have an adapter — this is enforced at compile
 *  time so that adding a new step without a handler is a type error.  When a
 *  step was already performed before the transition, pass `NOOP_STEP`. */
export function executeTransition<S extends TransitionStep>(
  steps: readonly S[],
  adapters: Readonly<Record<S, () => void>>,
): void {
  for (const step of steps) {
    adapters[step]();
  }
}

/** Gate a callback behind the upgrade-pick dialog (modern mode).
 *  If there are pending offers and the dialog is shown, `onDone` runs after
 *  all picks resolve. Otherwise `onDone` runs immediately.
 *  Used by both host (runtime-phase-ticks) and watcher (online-phase-transitions)
 *  to share the banner → dialog → proceed sequence.
 *  When `prepare` is provided, the dialog is pre-created before the banner
 *  so the upgrade overlay can be progressively revealed during the sweep. */
export function gateUpgradePick(
  show: BannerShow,
  tryShow: ((onDone: () => void) => boolean) | undefined,
  hasPendingOffers: boolean,
  onDone: () => void,
  prepare?: () => boolean,
): void {
  if (tryShow && hasPendingOffers) {
    prepare?.();
    showUpgradePickBanner(show, () => {
      if (!tryShow(onDone)) onDone();
    });
    return;
  }
  onDone();
}

/** Show the modifier reveal banner with the modifier label as the title.
 *  The banner sweeps across the screen, revealing the post-modifier map state
 *  while tile highlights pulse on changed tiles (driven by banner.modifierDiff). */
export function showModifierRevealBanner(
  show: BannerShow,
  label: string,
  onDone: () => void,
): void {
  show(label, onDone, true);
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

/** Show the upgrade pick banner with its canonical subtitle. */
function showUpgradePickBanner(show: BannerShow, onDone: () => void): void {
  show(BANNER_UPGRADE_PICK, onDone, true, undefined, BANNER_UPGRADE_PICK_SUB);
}
