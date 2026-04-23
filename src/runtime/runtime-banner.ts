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
 *     banner clobbered it.
 *   - BANNER_REPLACED when `showBanner` overwrites an active banner.
 *     Carries `prev*` + `new*` identity. The two events together cover
 *     every way a banner leaves the screen, so consumers that want the
 *     unified "banner went away" beat subscribe to both.
 *
 * Hold: when `holdMs` is set on a banner, the `swept → onDone` edge is
 * deferred by that many sim-ms. The banner sits in `swept` state until
 * the hold expires. A new `showBanner` or `hideBanner` during the hold
 * cancels the pending timer.
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  type ActiveBannerState,
  type BannerShowOpts,
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
  /** Clear banner pixels + pending hold timer without emitting events.
   *  For lifecycle teardown paths (rematch, quit-to-lobby) where the
   *  caller already owns the terminal mode (STOPPED / LOBBY). Does NOT
   *  emit BANNER_HIDDEN — teardown is not a narrative banner-end beat. */
  resetBannerState: () => void;
  tickBanner: (dt: number) => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, log, render, timing, rendererCaptureScene } = deps;

  function clearHoldTimer(banner: ActiveBannerState): void {
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
    const prev = runtimeState.banner;
    if (prev.status !== "hidden") {
      log(
        `showBanner "${opts.text}" while banner "${prev.text}" status=${prev.status}`,
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
      clearHoldTimer(prev);
    }
    const next: ActiveBannerState = {
      status: "sweeping",
      progress: 0,
      text: opts.text,
      subtitle: opts.subtitle,
      kind: opts.kind,
      modifierDiff: opts.modifierDiff,
      callback: opts.onDone,
      prevScene,
      holdMs: opts.holdMs ?? 0,
    };
    runtimeState.banner = next;

    // Restore Mode.TRANSITION so the banner tick runs — subsystem dialogs
    // (life-lost, upgrade-pick) leave mode on their terminal value when
    // chaining into a banner. Banner visibility is tracked via `banner.status`.
    setMode(runtimeState, Mode.TRANSITION);

    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
      bannerKind: next.kind,
      text: next.text,
      subtitle: next.subtitle,
      phase: state.phase,
      round: state.round,
      modifierId: next.modifierDiff?.id,
      changedTiles: next.modifierDiff?.changedTiles,
    });
  }

  function hideBanner(): void {
    const banner = runtimeState.banner;
    if (banner.status === "hidden") return;
    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_HIDDEN, {
      bannerKind: banner.kind,
      text: banner.text,
      phase: state.phase,
      round: state.round,
    });
    clearHoldTimer(banner);
    runtimeState.banner = createBannerState();
  }

  function resetBannerState(): void {
    const banner = runtimeState.banner;
    if (banner.status !== "hidden") clearHoldTimer(banner);
    runtimeState.banner = createBannerState();
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

  return { showBanner, hideBanner, resetBannerState, tickBanner };
}
