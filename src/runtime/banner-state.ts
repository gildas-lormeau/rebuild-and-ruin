import type {
  BannerContent,
  SceneCapture,
} from "../shared/ui/banner-content.ts";

/** Banner is either active or absent. `null` is the "no banner on
 *  screen" state; `ActiveBannerState` carries everything else. */
export type BannerState = ActiveBannerState | null;

/** Active banner — text/subtitle/kind from `BannerContent`, plus the
 *  sweep `progress` (0 → 1) and two scene snapshots composited on
 *  either side of the sweep line. `progress >= 1` means the sweep has
 *  ended; the banner remains visible (text/subtitle still readable)
 *  until a caller explicitly hides it. In practice `runDisplay` calls
 *  `hideBanner()` at the end of every display sequence. */
export interface ActiveBannerState extends BannerContent {
  progress: number;
  /** Pixel snapshot of the scene composited below the sweep line —
   *  the old scene, captured before the phase mutation that the
   *  banner is announcing. Supplied by the caller (`showBanner` opts)
   *  because the mutation has not yet run at banner-show time. */
  prevScene?: SceneCapture;
  /** Pixel snapshot of the scene revealed above the sweep line — the
   *  new scene, captured by `showBanner` itself after the phase
   *  mutation + `postMutate` + one forced `render()`. Both snapshots
   *  are frozen for the duration of the sweep; the live renderer does
   *  not repaint world contents during a banner. */
  newScene?: SceneCapture;
}

/** Callback signature for showing phase-transition banners. */
export type BannerShow = (opts: BannerShowOpts) => void;

export interface BannerShowOpts extends BannerContent {
  readonly onDone: () => void;
}

export function createBannerState(): BannerState {
  return null;
}
