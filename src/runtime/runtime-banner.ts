/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * The banner sweep composites a captured pixel snapshot ("old scene") below
 * the sweep line and the live-rendered new scene above it. The snapshot is
 * an ImageData grabbed from the offscreen scene canvas before phase mutations
 * — no state cloning, no re-rendering.
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { type BannerState, createBannerState } from "./runtime-contracts.ts";
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
  readonly render: () => void;
}

interface BannerSystem {
  showBanner: (text: string, onDone: () => void, subtitle?: string) => void;
  tickBanner: (dt: number) => void;
  clearSnapshots: () => void;
  reset: () => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, haptics, render } = deps;
  // True between showBanner() and the first tick. Defers `bannerStart` so
  // consecutive showBanner calls in the same tick collapse into a single
  // event for the final content.
  let pendingStartEvent = false;

  function showBanner(text: string, onDone: () => void, subtitle?: string) {
    // Unzoom before banner so the full map is visible during transition
    assertStateReady(runtimeState);
    clearPhaseZoom();
    // Re-entry isn't a bug on its own: watchers replay banners from
    // checkpoint messages that can arrive during an earlier banner's sweep
    // (retransmits, host-migration recovery). Log so we notice unexpected
    // cases, then overwrite — `runTransition` owns ordering for host-driven
    // banners, and watchers take the latest host intent.
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
      });
    }

    banner.progress = Math.min(1, banner.progress + dt / BANNER_DURATION);
    render();

    if (banner.progress < 1) return;

    const endedText = banner.text;
    banner.active = false;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_END, {
      text: endedText,
      phase: state.phase,
      round: state.round,
    });
    fireOnce(banner, "callback", "banner.callback");
  }

  function clearSnapshots(): void {
    runtimeState.banner.prevSceneImageData = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  return { showBanner, tickBanner, clearSnapshots, reset };
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
  banner.active = true;
  banner.progress = 0;
  banner.text = opts.text;
  banner.subtitle = opts.subtitle;
  banner.callback = opts.onDone;
  opts.setModeBanner();
}
