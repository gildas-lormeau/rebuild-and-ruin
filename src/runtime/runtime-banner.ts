/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * Wraps phase-banner.ts primitives with runtime state access,
 * camera unzoom, haptics, and sound.
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

interface ShowBannerDeps {
  banner: BannerState;
  text: string;
  subtitle?: string;
  onDone: () => void;
  /** When true, consume `banner.pendingSnapshot` → `banner.prevScene`
   *  so the banner can show a before/after visual comparison. */
  preservePrevScene?: boolean;
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] };
  setModeBanner: () => void;
}

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
   *  @param preservePrevScene — If true, consume `pendingSnapshot` → `prevScene` for before/after comparison
   *  @param newBattle — Battle territory/walls snapshot for the "after" scene. Only used when preservePrevScene is true; ignored otherwise.
   *  @param subtitle — Optional smaller text below the main banner */
  showBanner: (
    text: string,
    onDone: () => void,
    preservePrevScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  tickBanner: (dt: number) => void;
  /** Clear pending snapshot — called when selection state is reset
   *  (e.g. after losing a life). */
  clearSnapshots: () => void;
  /** Reset banner state for game restart / rematch. */
  reset: () => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, haptics, sound, render } = deps;
  // True between showBanner() and the first tick. Originally introduced
  // to defer `bannerStart` until a mid-frame `banner.text/modifierDiff`
  // overwrite (host battle transition) had settled — that swap is gone
  // now (the host inspects modifierDiff before calling showBanner, same
  // shape as the watcher), but the deferral is kept as a one-tick dedup
  // so consecutive showBanner calls in the same tick collapse into a
  // single bannerStart event for the final content.
  let pendingStartEvent = false;

  function showBanner(
    text: string,
    onDone: () => void,
    preservePrevScene = false,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) {
    // Unzoom before banner so the full map is visible during transition
    assertStateReady(runtimeState);
    clearPhaseZoom();
    if (runtimeState.banner.active) {
      log(
        `showBanner "${text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    showBannerTransition({
      banner: runtimeState.banner,
      text,
      subtitle,
      onDone,
      preservePrevScene,
      newBattle,
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
    banner.prevScene = undefined;
    banner.newTerritory = undefined;
    banner.newWalls = undefined;
    banner.modifierDiff = undefined;
    banner.active = false;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_END, {
      text: endedText,
      phase: state.phase,
      round: state.round,
    });
    // Invoke the completion callback exactly once, THEN null the field to
    // prevent re-entry if tickBanner runs again this frame. See shared/utils.ts
    // for the fireOnce contract. New dialog subsystems: pick one of the three
    // documented callback patterns (runtime-types.ts above ScoreDeltaSystem):
    // stored-on-state (banner/score delta, this file), method (life-lost), or
    // local closure (upgrade-pick).
    fireOnce(banner, "callback", "banner.callback");
  }

  function clearSnapshots(): void {
    runtimeState.banner.pendingSnapshot = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  return { showBanner, tickBanner, clearSnapshots, reset };
}

/** Set up banner state for a phase transition.
 *  When preservePrevScene is true, atomically consumes `pendingSnapshot`
 *  → `prevScene`. There is no auto-capture fallback — callers must set
 *  `banner.pendingSnapshot` before calling `showBanner`. */
function showBannerTransition(deps: ShowBannerDeps): void {
  const {
    banner,
    text,
    subtitle,
    onDone,
    preservePrevScene = false,
    newBattle,
    setModeBanner,
  } = deps;

  if (preservePrevScene) {
    // Consume pendingSnapshot atomically. No fallback — if it's missing
    // the caller forgot to capture before mutations.
    banner.prevScene = banner.pendingSnapshot;
    banner.pendingSnapshot = undefined;
  } else {
    banner.prevScene = undefined;
  }

  banner.newTerritory = newBattle?.territory;
  banner.newWalls = newBattle?.walls;
  banner.active = true;
  banner.progress = 0;
  banner.text = text;
  banner.subtitle = subtitle;
  banner.callback = onDone;
  setModeBanner();
}
