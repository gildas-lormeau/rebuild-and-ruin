/**
 * Animated phase-transition banners with two pixel snapshots. State is
 * `ActiveBannerState | null`; `progress` ramps 0 → 1 across BANNER_DURATION
 * then holds on screen until hideBanner. Emits BANNER_START / SWEEP_END /
 * HIDDEN / REPLACED. Post-sweep dwell is the caller's job — `onDone` flips
 * mode and the destination phase ticks itself, so this system stays a pure
 * sweep animator.
 */

import { BANNER_DURATION } from "../../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../../shared/core/game-event-bus.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import {
  type ActiveBannerState,
  type BannerShowOpts,
  createBannerState,
} from "../banner-state.ts";
import { assertStateInstalled, type RuntimeState, setMode } from "../state.ts";

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly requestRender: () => void;
  /** A-snapshot: current display pixels copied into a banner-owned bridge
   *  canvas. `undefined` in headless / pre-first-frame. */
  readonly rendererCaptureScene: () => HTMLCanvasElement | undefined;
  /** B-snapshot: full pipeline rendered to offscreen-only targets (FBO
   *  readback 3D / hidden sibling canvas 2D) so the visible canvas never
   *  flashes the post-mutation scene before the sweep reveals it.
   *  `undefined` in headless / pre-first-frame. */
  readonly captureSceneOffscreen: () => HTMLCanvasElement | undefined;
}

interface BannerSystem {
  showBanner: (opts: BannerShowOpts) => void;
  hideBanner: () => void;
  /** Silent reset for teardown paths (rematch, quit-to-lobby). Does not
   *  emit BANNER_HIDDEN — teardown isn't a narrative banner-end beat. */
  reset: () => void;
  tickBanner: (dt: number) => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const {
    runtimeState,
    log,
    requestRender,
    rendererCaptureScene,
    captureSceneOffscreen,
  } = deps;

  // onDone fires when progress reaches 1; null-before-call ordering
  // lets a re-entrant showBanner survive (its `onDone = newCb` runs
  // inside the fire path).
  let onDone: (() => void) | undefined;

  function showBanner(opts: BannerShowOpts) {
    assertStateInstalled(runtimeState);
    // prevScene = current display pixels (pre-mutation for the first
    // banner of a transition; previous banner's B-snapshot otherwise).
    // newScene = post-mutation scene rendered offscreen so the user
    // never sees the new state before the sweep reveals it. Both are
    // frozen for the duration of the sweep.
    const prevCanvas = rendererCaptureScene();
    const prevScene = prevCanvas ? { canvas: prevCanvas } : undefined;
    const newCanvas = captureSceneOffscreen();
    const newScene = newCanvas ? { canvas: newCanvas } : undefined;

    // Watchers legitimately replay banners from checkpoint messages
    // mid-sweep (retransmits, host-migration recovery). Log + emit
    // BANNER_REPLACED so consumers can trace the transition.
    const prev = runtimeState.banner;
    if (prev !== null) {
      log(
        `showBanner "${opts.text}" while banner "${prev.text}" progress=${prev.progress}`,
      );
      const state = runtimeState.state;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_REPLACED, {
        prevKind: prev.kind,
        prevText: prev.text,
        newKind: opts.kind,
        newText: opts.text,
        phase: state.phase,
        round: state.round,
      });
    }
    const next: ActiveBannerState = {
      progress: 0,
      text: opts.text,
      subtitle: opts.subtitle,
      kind: opts.kind,
      paletteKey: opts.paletteKey,
      prevScene,
      newScene,
    };
    runtimeState.banner = next;
    onDone = opts.onDone;

    // Subsystem dialogs (life-lost, upgrade-pick) leave mode on their
    // terminal value; restoring TRANSITION is what makes tickBanner run.
    setMode(runtimeState, Mode.TRANSITION);

    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
      bannerKind: next.kind,
      text: next.text,
      subtitle: next.subtitle,
      phase: state.phase,
      round: state.round,
    });
  }

  function hideBanner(): void {
    const banner = runtimeState.banner;
    if (banner === null) return;
    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_HIDDEN, {
      bannerKind: banner.kind,
      text: banner.text,
      phase: state.phase,
      round: state.round,
    });
    runtimeState.banner = createBannerState();
    onDone = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
    onDone = undefined;
  }

  function tickBanner(dt: number) {
    const banner = runtimeState.banner;
    if (banner !== null && banner.progress < 1) {
      banner.progress = Math.min(1, banner.progress + dt / BANNER_DURATION);
      if (banner.progress >= 1) {
        emitGameEvent(runtimeState.state.bus, GAME_EVENT.BANNER_SWEEP_END, {
          bannerKind: banner.kind,
          text: banner.text,
          phase: runtimeState.state.phase,
          round: runtimeState.state.round,
        });
        const callback = onDone;
        onDone = undefined;
        callback?.();
      }
    }
    requestRender();
  }

  return { showBanner, hideBanner, reset, tickBanner };
}
