import type { BannerKind } from "../core/game-event-bus.ts";

/** A renderer-produced scene snapshot used for the banner prev/new-scene
 *  sweep. Wraps a dedicated offscreen canvas owned by the renderer — not
 *  raw pixels — so the banner sweep can drawImage from it directly at
 *  display resolution without a getImageData/putImageData round-trip. */
export interface SceneCapture {
  readonly canvas: HTMLCanvasElement;
}

/** Display content carried by a banner unchanged across its three layers
 *  (request → runtime state → render output). Each layer extends this with
 *  layer-specific extras (caller adds `onDone`; runtime adds animation
 *  state; renderer adds geometry). */
export interface BannerContent {
  /** Banner identity — threaded onto every BANNER_* event so consumers
   *  (music, SFX, tests) can discriminate without reading `phase` (which
   *  lies during the upgrade-pick flow) or matching text. */
  kind: BannerKind;
  text: string;
  subtitle?: string;
  /** Opaque accent-palette key. The renderer indexes this into its
   *  palette table to recolor the banner chrome (border + title).
   *  Undefined = default palette. The banner system treats this as an
   *  uninterpreted string. */
  paletteKey?: string;
}
