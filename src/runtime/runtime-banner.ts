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
import type { GameState } from "../shared/core/types.ts";
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
  readonly sound: { phaseStart: () => void };
  readonly render: () => void;
}

interface BannerSystem {
  /** Show a phase transition banner.
   *  @param text — Banner text
   *  @param onDone — Called once when banner animation completes
   *  @param subtitle — Optional smaller text below the main banner */
  showBanner: (text: string, onDone: () => void, subtitle?: string) => void;
  tickBanner: (dt: number) => void;
  /** Clear stale snapshot data (wallsBeforeSweep) — called
   *  when selection state is reset (e.g. after losing a life). */
  clearSnapshots: () => void;
  /** Reset banner state for game restart / rematch. */
  reset: () => void;
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
    showBannerTransition(runtimeState.banner, runtimeState.state, {
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

    // Emit bannerStart on the first tick after showBanner — content may have
    // been mutated mid-frame (e.g. battle banner → modifier reveal), so we
    // read the final state here.
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
    // Invoke the completion callback exactly once, THEN null the field to
    // prevent re-entry if tickBanner runs again this frame.
    fireOnce(banner, "callback", "banner.callback");
  }

  function clearSnapshots(): void {
    runtimeState.banner.wallsBeforeSweep = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  return { showBanner, tickBanner, clearSnapshots, reset };
}

/** Set up banner state for a phase transition. */
function showBannerTransition(
  banner: BannerState,
  _state: GameState,
  opts: {
    text: string;
    subtitle?: string;
    onDone: () => void;
    setModeBanner: () => void;
  },
): void {
  // Clear wallsBeforeSweep — live scene no longer needs the wall override
  // once the banner is active (the old scene comes from prevSceneImageData).
  banner.wallsBeforeSweep = undefined;

  banner.active = true;
  banner.progress = 0;
  banner.text = opts.text;
  banner.subtitle = opts.subtitle;
  banner.callback = opts.onDone;
  opts.setModeBanner();
}
