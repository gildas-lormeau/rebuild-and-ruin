/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * Wraps phase-banner.ts primitives with runtime state access,
 * camera unzoom, haptics, and sound.
 */

import {
  createBannerState,
  showBannerTransition,
  tickBannerTransition,
} from "../game/phase-banner.ts";
import { BANNER_DURATION } from "../shared/game-constants.ts";
import { Mode } from "../shared/game-phase.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";

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
   *  @param preservePrevScene — If true, render old scene behind the banner (for before/after comparison)
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
  /** Reset banner state for game restart / rematch. */
  reset: () => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, haptics, sound, render } = deps;

  function showBanner(
    text: string,
    onDone: () => void,
    preservePrevScene = false,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) {
    // Unzoom before banner so the full map is visible during transition
    clearPhaseZoom();
    if (runtimeState.banner.active) {
      log(
        `showBanner "${text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    showBannerTransition({
      banner: runtimeState.banner,
      state: runtimeState.state,
      battleAnim: runtimeState.battleAnim,
      text,
      subtitle,
      onDone,
      preservePrevScene,
      newBattle,
      setModeBanner: () => {
        setMode(runtimeState, Mode.BANNER);
      },
    });
    haptics.phaseChange();
    sound.phaseStart();
  }

  function tickBanner(dt: number) {
    tickBannerTransition(runtimeState.banner, dt, BANNER_DURATION, render);
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  return { showBanner, tickBanner, reset };
}
