/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * Contract:
 *
 *   showBanner({ text, kind, onDone, subtitle?, paletteKey? })
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
 *     banner still on screen). Fires synchronously; `onDone` runs on
 *     the same tick.
 *   - BANNER_HIDDEN on `hideBanner()` when status was non-hidden. The
 *     banner left the screen on its own schedule — not because another
 *     banner clobbered it.
 *   - BANNER_REPLACED when `showBanner` overwrites an active banner.
 *     Carries `prev*` + `new*` identity. The two events together cover
 *     every way a banner leaves the screen, so consumers that want the
 *     unified "banner went away" beat subscribe to both.
 *
 * Post-sweep dwell: callers that need a beat between a banner and the
 * next phase (e.g. the modifier-reveal → battle flow) do not delay
 * `onDone` inside the banner system. Instead, the banner is hidden at
 * the end of the display sequence, `onDone` flips the runtime to
 * `Mode.GAME`, and the destination phase runs its own timed tick
 * (see `tickModifierRevealPhase`) over a banner-free screen until
 * the next transition shows its own banner. Keeps the banner system a
 * pure sweep animator.
 */

import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { createFireOnceSlot } from "./fire-once-slot.ts";
import {
  type ActiveBannerState,
  type BannerShowOpts,
  createBannerState,
} from "./runtime-contracts.ts";
import {
  assertStateInstalled,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly requestRender: () => void;
  /** Renderer A-snapshot — copies the current display's game area into a
   *  banner-owned bridge canvas and returns that canvas, or `undefined` in
   *  headless / pre-first-frame. Called inside `showBanner` once before
   *  the state mutation is observed, so the A-snapshot reflects what's on
   *  screen. */
  readonly rendererCaptureScene: () => HTMLCanvasElement | undefined;
  /** Flash-free B-snapshot — rebuilds the overlay from post-mutation
   *  state and renders the full pipeline into offscreen-only targets
   *  (FBO readback in 3D, hidden sibling canvas in 2D), then copies the
   *  composite into a banner-owned bridge canvas and returns it. The
   *  visible canvas is NEVER written, so the user never sees the new
   *  scene before the banner's progressive reveal reaches it. Returns
   *  `undefined` in headless / pre-first-frame. */
  readonly captureSceneOffscreen: () => HTMLCanvasElement | undefined;
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
  const {
    runtimeState,
    log,
    requestRender,
    rendererCaptureScene,
    captureSceneOffscreen,
  } = deps;

  /** Fires once when the sweep reaches 1. `set` overwrites the prior pending
   *  callback (used when one banner replaces another mid-sweep); `clear`
   *  drops a pending callback without firing (used by hide/reset). Same
   *  pattern as the three dialog sub-systems — see fire-once-slot.ts. */
  const pendingOnDone = createFireOnceSlot();

  function showBanner(opts: BannerShowOpts) {
    assertStateInstalled(runtimeState);
    // Two-snapshot model — captured entirely inside `showBanner` so each
    // banner owns its own pair of snapshots:
    //   - `prevScene` (A) = current display pixels at the moment
    //     `showBanner` was called. For the first banner in a transition
    //     this is the pre-mutation scene (the phase machine has not yet
    //     flushed post-mutation pixels). For subsequent banners in the
    //     same transition it is whatever the previous banner's `B`
    //     painted to screen.
    //   - `newScene` (B) = post-mutation scene, rendered offscreen.
    //     Callers may have mutated state between `showBanner` calls
    //     without rendering; `captureSceneOffscreen` rebuilds the
    //     overlay from current state and renders the full pipeline into
    //     offscreen-only targets so B reflects the mutation WITHOUT
    //     painting the visible canvas. This avoids a visible flash of
    //     the post-mutation scene before the banner's progressive
    //     reveal begins.
    // Both snapshots are frozen for the duration of the sweep — the
    // renderer paints them on either side of the sweep line and does
    // not repaint world contents.
    const prevCanvas = rendererCaptureScene();
    const prevScene = prevCanvas ? { canvas: prevCanvas } : undefined;
    const newCanvas = captureSceneOffscreen();
    const newScene = newCanvas ? { canvas: newCanvas } : undefined;

    // Overwrite on re-entry. Watchers legitimately replay banners from
    // checkpoint messages that can arrive during an earlier banner's sweep
    // (retransmits, host-migration recovery). Log so unusual cases surface,
    // then emit BANNER_REPLACED with both identities so consumers that
    // care about the transition can trace it.
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
    }
    const next: ActiveBannerState = {
      status: "sweeping",
      progress: 0,
      text: opts.text,
      subtitle: opts.subtitle,
      kind: opts.kind,
      paletteKey: opts.paletteKey,
      prevScene,
      newScene,
    };
    runtimeState.banner = next;
    pendingOnDone.set(opts.onDone);

    // Restore Mode.TRANSITION so the banner tick runs — subsystem dialogs
    // (life-lost, upgrade-pick) leave mode on their terminal value when
    // handing off to a banner. Banner visibility is tracked via `banner.status`.
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
    if (banner.status === "hidden") return;
    const state = runtimeState.state;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_HIDDEN, {
      bannerKind: banner.kind,
      text: banner.text,
      phase: state.phase,
      round: state.round,
    });
    runtimeState.banner = createBannerState();
    pendingOnDone.clear();
  }

  function resetBannerState(): void {
    runtimeState.banner = createBannerState();
    pendingOnDone.clear();
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
        pendingOnDone.fire();
      }
    }
    requestRender();
  }

  return { showBanner, hideBanner, resetBannerState, tickBanner };
}
