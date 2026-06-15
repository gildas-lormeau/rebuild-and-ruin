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
  /** Fallback A-snapshot: current display pixels copied into a
   *  banner-owned bridge canvas. Used when no primed prev-scene exists
   *  (non-first banners of a chain). `undefined` in headless /
   *  pre-first-frame. */
  readonly rendererCaptureScene: () => HTMLCanvasElement | undefined;
  /** Full pipeline rendered to offscreen-only targets at fullMapVp (FBO
   *  readback 3D / hidden sibling canvas 2D) so the visible canvas never
   *  flashes the captured scene. Each call returns a fresh, caller-owned
   *  snapshot canvas — used for every banner's B-snapshot and, via
   *  `primePrevScene`, the pre-mutation A-snapshot, which the banner holds
   *  side by side for the whole sweep. `undefined` in headless /
   *  pre-first-frame. */
  readonly captureSceneOffscreen: () => HTMLCanvasElement | undefined;
}

interface BannerSystem {
  showBanner: (opts: BannerShowOpts) => void;
  hideBanner: () => void;
  /** Render the current state offscreen at fullMapVp and stash it as the
   *  next `showBanner`'s prev-scene. Called by the phase machine's
   *  `runTransition` BEFORE the mutate: the transition mutate runs at the
   *  dispatch tick (lockstep — it must not wait for the displayed camera
   *  to converge), so the pre-mutation scene has to be captured here
   *  rather than read back from the display pixels, which may still show
   *  a zoomed viewport on a touch peer. Consumed by the first showBanner
   *  of the transition chain; overwritten by the next prime; cleared on
   *  reset. A stale prime left by a bannerless chain is consumed by the
   *  next out-of-chain banner — cosmetic worst case: one sweep starts
   *  from a slightly older scene. */
  primePrevScene: () => void;
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

  // Pre-mutation prev-scene primed by `primePrevScene` (see interface doc).
  let primedPrevScene: HTMLCanvasElement | undefined;

  function primePrevScene(): void {
    // Each `captureSceneOffscreen` returns a fresh canvas, so this
    // pre-mutation snapshot survives the post-mutation new-scene capture
    // taken in the following `showBanner` — both are held for the sweep.
    primedPrevScene = captureSceneOffscreen();
  }

  function showBanner(opts: BannerShowOpts) {
    assertStateInstalled(runtimeState);
    // prevScene = the primed pre-mutation offscreen capture for the first
    // banner of a transition chain; current display pixels (the previous
    // banner's B-snapshot) otherwise. newScene = post-mutation scene
    // rendered offscreen so the user never sees the new state before the
    // sweep reveals it. Both are frozen for the duration of the sweep.
    const prevCanvas = primedPrevScene ?? rendererCaptureScene();
    primedPrevScene = undefined;
    const prevScene = prevCanvas ? { canvas: prevCanvas } : undefined;
    const newCanvas = captureSceneOffscreen();
    const newScene = newCanvas ? { canvas: newCanvas } : undefined;

    // A new transition's banner can replace a previous one still on
    // screen when display chains run back-to-back on this peer. Log +
    // emit BANNER_REPLACED so consumers can trace the transition.
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
    primedPrevScene = undefined;
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

  return { showBanner, hideBanner, primePrevScene, reset, tickBanner };
}
