/**
 * Banner sub-system — phase transition banners (show + tick + hold).
 *
 * Contract:
 *
 *   showBanner({ text, kind, onDone, subtitle?, modifierDiff?, holdMs? })
 *   hideBanner()
 *
 * State machine (see `BannerStatus` in runtime-contracts.ts):
 *
 *   hidden ─showBanner→ sweeping ─progress=1→ swept ─hideBanner→ hidden
 *                         │                       │
 *                         └─showBanner (overwrite)┘
 *
 * Events:
 *   - BANNER_START on `showBanner` (synchronous).
 *   - BANNER_SWEEP_END on `sweeping → swept` (sweep animation done,
 *     banner still on screen). Fires synchronously; the banner's
 *     `onDone` callback runs either on the same tick (no hold) or
 *     after the `holdMs` timer expires.
 *   - BANNER_HIDDEN on `hideBanner()` when status was non-hidden. The
 *     banner left the screen on its own schedule — not because another
 *     banner clobbered it. Carries `holdCompleted`: false only if a
 *     pending `holdMs` callback was dropped by the hide.
 *   - BANNER_REPLACED when `showBanner` overwrites an active banner.
 *     Carries `prev*` + `new*` identity + `holdCompleted`. The two
 *     events together cover every way a banner leaves the screen, so
 *     consumers that want the unified "banner went away" beat subscribe
 *     to both.
 *
 * Hold: when `holdMs` is set on a banner, the `swept → onDone` edge is
 * deferred by that many sim-ms. The banner sits in `swept` state until
 * the hold expires. A new `showBanner` or `hideBanner` during the hold
 * cancels the pending timer (and the emitted BANNER_REPLACED / BANNER_HIDDEN
 * carries `holdCompleted=false` so the drop is observable).
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  type BannerShowOpts,
  type BannerState,
  createBannerState,
  type TimingApi,
} from "./runtime-contracts.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly render: () => void;
  /** Injected timing — used to schedule the post-sweep `holdMs` timer so
   *  headless tests on the mock clock observe the same timing as
   *  production. */
  readonly timing: TimingApi;
  /** Renderer scene capture — returns the current display pixels or
   *  `undefined` in headless / pre-first-frame. Called internally from
   *  `showBanner` as its first operation so the captured frame is the
   *  one the user was last shown. */
  readonly rendererCaptureScene: () => ImageData | undefined;
}

interface BannerSystem {
  showBanner: (opts: BannerShowOpts) => void;
  hideBanner: () => void;
  tickBanner: (dt: number) => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, log, render, timing, rendererCaptureScene } = deps;

  function clearHoldTimer(banner: BannerState): void {
    if (banner.holdTimerId !== undefined) {
      timing.clearTimeout(banner.holdTimerId);
      banner.holdTimerId = undefined;
    }
  }

  function showBanner(opts: BannerShowOpts) {
    assertStateReady(runtimeState);
    // Capture FIRST, before touching banner state — the snapshot is
    // whatever the user was last shown.
    const image = rendererCaptureScene();
    const prevScene = image ? { image } : undefined;

    // Overwrite on re-entry. Watchers legitimately replay banners from
    // checkpoint messages that can arrive during an earlier banner's sweep
    // (retransmits, host-migration recovery). Log so unusual cases surface,
    // then emit BANNER_REPLACED with both identities so consumers that
    // care about the chain can trace it.
    const banner = runtimeState.banner;
    if (banner.status !== "hidden") {
      log(
        `showBanner "${opts.text}" while banner "${banner.text}" status=${banner.status}`,
      );
      const state = runtimeState.state;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_REPLACED, {
        prevKind: banner.kind,
        prevText: banner.text,
        newKind: opts.kind,
        newText: opts.text,
        phase: state.phase,
        round: state.round,
        holdCompleted: banner.holdTimerId === undefined,
      });
    }
    clearHoldTimer(banner);
    banner.status = "sweeping";
    banner.progress = 0;
    banner.text = opts.text;
    banner.subtitle = opts.subtitle;
    banner.kind = opts.kind;
    banner.modifierDiff = opts.modifierDiff;
    banner.callback = opts.onDone;
    banner.prevScene = prevScene;
    banner.holdMs = opts.holdMs ?? 0;

    // Banner-on-screen ⇔ Mode.BANNER. Subsystem dialogs (life-lost,
    // upgrade-pick) set their own mode; when their callback chains back
    // into a new banner step, this call flips the mode back.
    setMode(runtimeState, Mode.BANNER);

    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
      bannerKind: banner.kind,
      text: banner.text,
      subtitle: banner.subtitle,
      phase: state.phase,
      round: state.round,
      modifierId: banner.modifierDiff?.id,
      changedTiles: banner.modifierDiff?.changedTiles,
    });
  }

  function hideBanner(): void {
    const banner = runtimeState.banner;
    const wasVisible = banner.status !== "hidden";
    if (wasVisible) {
      const state = runtimeState.state;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_HIDDEN, {
        bannerKind: banner.kind,
        text: banner.text,
        phase: state.phase,
        round: state.round,
        holdCompleted: banner.holdTimerId === undefined,
      });
    }
    clearHoldTimer(banner);
    runtimeState.banner = createBannerState();
    // Banner left the screen mid-transition. Flip back to Mode.TRANSITION
    // so the gap between display steps is honestly "transition, no banner"
    // rather than lying about a prior gameplay mode. Only do this if the
    // mode is currently BANNER — lifecycle teardown / mode-replacement
    // callers (life-lost close, upgrade-pick close) set their own mode.
    if (wasVisible && runtimeState.mode === Mode.BANNER) {
      setMode(runtimeState, Mode.TRANSITION);
    }
  }

  function tickBanner(dt: number) {
    const banner = runtimeState.banner;
    if (banner.status === "sweeping") {
      banner.progress = Math.min(1, banner.progress + dt / BANNER_DURATION);
      if (banner.progress >= 1) {
        banner.status = "swept";
        emitGameEvent(runtimeState.state.bus, GAME_EVENT.BANNER_SWEEP_END, {
          bannerKind: banner.kind,
          text: banner.text,
          phase: runtimeState.state.phase,
          round: runtimeState.state.round,
        });
        const callback = banner.callback;
        banner.callback = null;
        const holdMs = banner.holdMs;
        banner.holdMs = 0;
        if (callback) {
          if (holdMs > 0) {
            banner.holdTimerId = timing.setTimeout(() => {
              banner.holdTimerId = undefined;
              callback();
            }, holdMs);
          } else {
            callback();
          }
        }
      }
    }
    render();
  }

  return { showBanner, hideBanner, tickBanner };
}
