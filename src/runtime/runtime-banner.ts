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
 *   - BANNER_END on `* → hidden` (banner removed from screen, either by
 *     `hideBanner` or by a subsequent `showBanner` overwriting it). A
 *     replaced banner with a pending hold has its BANNER_END fire
 *     without the corresponding callback invocation — consumers detect
 *     a dropped hold by observing BANNER_END before the expected
 *     post-hold effect.
 *
 * Hold: when `holdMs` is set on a banner, the `swept → onDone` edge is
 * deferred by that many sim-ms. The banner sits in `swept` state until
 * the hold expires. A new `showBanner` or `hideBanner` during the hold
 * cancels the pending timer (and emits BANNER_END for the clobbered
 * banner so the drop is observable).
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  type BannerShowOpts,
  type BannerState,
  createBannerState,
  type TimingApi,
} from "./runtime-contracts.ts";
import {
  assertStateReady,
  isStateReady,
  type RuntimeState,
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
    // then emit BANNER_END for the banner being replaced so consumers that
    // key on the user-visible-end beat observe it (including dropped holds).
    const banner = runtimeState.banner;
    if (banner.status !== "hidden") {
      log(
        `showBanner "${opts.text}" while banner "${banner.text}" status=${banner.status}`,
      );
      emitBannerEnd(banner.text, banner.kind);
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

    const state = runtimeState.state;
    // Last battle in a finite game. Infinity-mode ("to the death")
    // carries maxRounds=Infinity, so this predicate is always false.
    const isFinalBattle =
      state.phase === Phase.BATTLE &&
      state.maxRounds !== Infinity &&
      state.round === state.maxRounds;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
      bannerKind: banner.kind,
      text: banner.text,
      subtitle: banner.subtitle,
      phase: state.phase,
      round: state.round,
      isFinalBattle,
      modifierId: banner.modifierDiff?.id,
      changedTiles: banner.modifierDiff?.changedTiles,
    });
  }

  function hideBanner(): void {
    const banner = runtimeState.banner;
    clearHoldTimer(banner);
    // Gate the emit on state-ready so lifecycle teardown (returnToLobby,
    // rematch) can call hideBanner before a fresh GameState exists.
    if (banner.status !== "hidden" && isStateReady(runtimeState)) {
      emitBannerEnd(banner.text, banner.kind);
    }
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

  function emitBannerEnd(text: string, kind: BannerState["kind"]): void {
    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_END, {
      bannerKind: kind,
      text,
      phase: state.phase,
      round: state.round,
    });
  }

  return { showBanner, hideBanner, tickBanner };
}
