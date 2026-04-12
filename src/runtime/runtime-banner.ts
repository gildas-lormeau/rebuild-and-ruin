/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * The banner sweep composites a captured pixel snapshot ("old scene") below
 * the sweep line and the live-rendered new scene above it. The snapshot is
 * an ImageData grabbed from the offscreen scene canvas before phase mutations
 * — no state cloning, no re-rendering.
 *
 * Transition orchestration methods (showBattleTransition, showBuildTransition)
 * live here because they are banner-chaining concerns — identical control
 * flow used by both host and watcher. Callers supply the role-specific
 * callbacks (checkpoint apply, controller init, etc.).
 */

import {
  BANNER_DURATION,
  type ModifierDiff,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { modifierDef } from "../shared/core/modifier-defs.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  BANNER_BATTLE,
  BANNER_BATTLE_SUB,
  BANNER_BUILD,
  BANNER_BUILD_SUB,
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
  BANNER_UPGRADE_PICK,
  BANNER_UPGRADE_PICK_SUB,
} from "./banner-messages.ts";
import {
  type BannerState,
  type BannerTransitions,
  createBannerState,
} from "./runtime-contracts.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly clearPhaseZoom: () => void;
  readonly log: (msg: string) => void;
  readonly haptics: { phaseChange: () => void };
  readonly sound: { phaseStart: () => void };
  readonly render: () => void;
  readonly captureScene: () => ImageData | undefined;
}

interface BannerSystem extends BannerTransitions {
  /** Show a phase transition banner. Low-level — prefer the transition
   *  methods below for phase-specific banner chains. */
  showBanner: (text: string, onDone: () => void, subtitle?: string) => void;
  tickBanner: (dt: number) => void;
  /** Clear stale snapshot data (wallsBeforeSweep) — called
   *  when selection state is reset (e.g. after losing a life). */
  clearSnapshots: () => void;
  /** Reset banner state for game restart / rematch. */
  reset: () => void;
  /** Build→cannon transition: captures scene + shows Place Cannons banner. */
  showCannonTransition: (onDone: () => void) => void;
  /** Cannon→battle transition: modifier reveal (if any) → battle banner.
   *  Handles the chained re-capture between modifier and battle banners. */
  showBattleTransition: (
    modifierDiff: ModifierDiff | null,
    onDone: () => void,
  ) => void;
  /** Battle→build transition: upgrade pick (if any) → build banner.
   *  Handles the upgrade-pick dialog gate and banner chaining. */
  showBuildTransition: (
    upgradePick:
      | {
          tryShow: (onDone: () => void) => boolean;
          prepare: () => boolean;
        }
      | undefined,
    hasPendingOffers: boolean,
    onBannerDone: () => void,
    onBuildStart: () => void,
  ) => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, haptics, sound, render } = deps;
  // True between showBanner() and the first tick. Defers `bannerStart` so
  // consecutive showBanner calls in the same tick collapse into a single
  // event for the final content.
  let pendingStartEvent = false;

  function showBanner(text: string, onDone: () => void, subtitle?: string) {
    // Unzoom before banner so the full map is visible during transition
    assertStateReady(runtimeState);
    clearPhaseZoom();
    if (runtimeState.banner.active) {
      log(
        `showBanner "${text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    showBannerTransition(runtimeState.banner, {
      text,
      subtitle,
      onDone,
      setModeBanner: () => {
        setMode(runtimeState, Mode.BANNER);
      },
    });
    pendingStartEvent = true;
    haptics.phaseChange();
    sound.phaseStart();
  }

  function tickBanner(dt: number) {
    const banner = runtimeState.banner;
    const state = runtimeState.state;

    if (pendingStartEvent) {
      pendingStartEvent = false;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
        text: banner.text,
        subtitle: banner.subtitle,
        phase: state.phase,
        round: state.round,
        modifierId: banner.modifierDiff?.id,
        changedTiles: banner.modifierDiff?.changedTiles,
      });
    }

    banner.progress = Math.min(1, banner.progress + dt / BANNER_DURATION);
    render();

    if (banner.progress < 1) return;

    const endedText = banner.text;
    banner.prevSceneImageData = undefined;
    banner.modifierDiff = undefined;
    banner.active = false;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_END, {
      text: endedText,
      phase: state.phase,
      round: state.round,
    });
    fireOnce(banner, "callback", "banner.callback");
  }

  function clearSnapshots(): void {
    runtimeState.banner.wallsBeforeSweep = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  /** "Place Cannons" banner with scene capture. */
  function showCannonTransition(onDone: () => void): void {
    runtimeState.banner.prevSceneImageData = deps.captureScene();
    showBanner(BANNER_PLACE_CANNONS, onDone, BANNER_PLACE_CANNONS_SUB);
  }

  /** Modifier reveal (if any) → "Prepare for Battle" banner chain. */
  function showBattleTransition(
    diff: ModifierDiff | null,
    onDone: () => void,
  ): void {
    const { banner } = runtimeState;
    if (diff) {
      banner.modifierDiff = diff;
      showBanner(modifierDef(diff.id).label, () => {
        // Re-capture post-modifier scene for the chained battle banner.
        banner.prevSceneImageData = deps.captureScene();
        showBanner(BANNER_BATTLE, onDone, BANNER_BATTLE_SUB);
      });
    } else {
      showBanner(BANNER_BATTLE, onDone, BANNER_BATTLE_SUB);
    }
  }

  /** Upgrade pick gate (if any) → "Build & Repair" banner chain. */
  function showBuildTransition(
    upgradePick:
      | { tryShow: (onDone: () => void) => boolean; prepare: () => boolean }
      | undefined,
    hasPendingOffers: boolean,
    onDone: () => void,
    onBuildStart: () => void,
  ): void {
    const enterBuild = () => {
      showBanner(BANNER_BUILD, onDone, BANNER_BUILD_SUB);
      onBuildStart();
    };
    if (upgradePick && hasPendingOffers) {
      upgradePick.prepare();
      showBanner(
        BANNER_UPGRADE_PICK,
        () => {
          if (!upgradePick.tryShow(enterBuild)) enterBuild();
        },
        BANNER_UPGRADE_PICK_SUB,
      );
      return;
    }
    enterBuild();
  }

  return {
    showBanner,
    tickBanner,
    clearSnapshots,
    reset,
    showCannonTransition,
    showBattleTransition,
    showBuildTransition,
  };
}

/** Set up banner state for a phase transition. */
function showBannerTransition(
  banner: BannerState,
  opts: {
    text: string;
    subtitle?: string;
    onDone: () => void;
    setModeBanner: () => void;
  },
): void {
  banner.wallsBeforeSweep = undefined;
  banner.active = true;
  banner.progress = 0;
  banner.text = opts.text;
  banner.subtitle = opts.subtitle;
  banner.callback = opts.onDone;
  opts.setModeBanner();
}
