/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * Contract (the only one, kept deliberately small):
 *
 *   showBanner({ text, onDone, prevScene?, subtitle?, modifierId? })
 *
 * Callers hand in a pre-captured `prevScene` (or nothing). The banner
 * never captures on its own — that used to be three different implicit
 * behaviours across the mutate fns / recaptureAfter / upgrade-pick
 * chain, and every renderer change had a different way to regress it.
 *
 * The `startTick` stamped on `BannerState` comes from the shared
 * monotonic `bannerClock` counter (also stamped on `SceneCapture` at
 * capture time). The render path enforces `prevScene.capturedAtTick <
 * startTick`, which is a hard fence: snapshots captured AFTER show()
 * simply aren't painted. No pop. The worst case is "no fade this
 * frame," which is graceful.
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import type { SceneCapture } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { type BannerShowOpts, createBannerState } from "./runtime-contracts.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly clearPhaseZoom: () => void;
  readonly log: (msg: string) => void;
  readonly render: () => void;
  /** Allocate the next monotonic tick from the shared banner clock. The
   *  same counter stamps `SceneCapture.capturedAtTick` inside
   *  `runtime.captureScene()`, so the fence "capture happened-before
   *  show" reduces to a straight integer compare. */
  readonly nextBannerTick: () => number;
}

interface BannerSystem {
  showBanner: (opts: BannerShowOpts) => void;
  tickBanner: (dt: number) => void;
  /** Drop any stashed prev-scene (e.g. on selection reset after life
   *  lost — the zone mutation would have invalidated the pixels). */
  clearSnapshots: () => void;
  reset: () => void;
  /** Capture the current scene into a `SceneCapture` stamped with the
   *  next banner-clock tick. Callers pass the result to `showBanner`
   *  as `prevScene`. Returns `undefined` in headless mode / before the
   *  first frame (no canvas to read from). */
  capture: (
    rendererCaptureScene: () => ImageData | undefined,
  ) => SceneCapture | undefined;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, render, nextBannerTick } = deps;
  // True between showBanner() and the first tick. Defers `bannerStart` so
  // consecutive showBanner calls in the same tick collapse into a single
  // event for the final content.
  let pendingStartEvent = false;

  function showBanner(opts: BannerShowOpts) {
    assertStateReady(runtimeState);
    // Unzoom before banner so the full map is visible during transition
    clearPhaseZoom();
    // Re-entry isn't a bug on its own: watchers replay banners from
    // checkpoint messages that can arrive during an earlier banner's sweep
    // (retransmits, host-migration recovery). Log so we notice unexpected
    // cases, then overwrite — `runTransition` owns ordering for host-driven
    // banners, and watchers take the latest host intent.
    if (runtimeState.banner.active) {
      log(
        `showBanner "${opts.text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    const banner = runtimeState.banner;
    banner.active = true;
    banner.progress = 0;
    banner.text = opts.text;
    banner.subtitle = opts.subtitle;
    banner.modifierId = opts.modifierId;
    banner.callback = opts.onDone;
    banner.prevScene = opts.prevScene;
    banner.startTick = nextBannerTick();
    setMode(runtimeState, Mode.BANNER);
    pendingStartEvent = true;
  }

  function tickBanner(dt: number) {
    const banner = runtimeState.banner;
    const state = runtimeState.state;

    if (pendingStartEvent) {
      pendingStartEvent = false;
      // Last battle in a finite game. Infinity-mode ("to the death")
      // carries maxRounds=Infinity, so this predicate is always false.
      const isFinalBattle =
        state.phase === Phase.BATTLE &&
        state.maxRounds !== Infinity &&
        state.round === state.maxRounds;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
        text: banner.text,
        subtitle: banner.subtitle,
        phase: state.phase,
        round: state.round,
        isFinalBattle,
        modifierId: banner.modifierId,
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
    runtimeState.banner.prevScene = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  function capture(
    rendererCaptureScene: () => ImageData | undefined,
  ): SceneCapture | undefined {
    const image = rendererCaptureScene();
    if (!image) return undefined;
    return { image, capturedAtTick: nextBannerTick() };
  }

  return { showBanner, tickBanner, clearSnapshots, reset, capture };
}
