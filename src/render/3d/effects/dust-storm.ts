/**
 * Dust-storm overlay — full-map shader plane (sand haze + 3 oscillating
 * streaks) that telegraphs the ±15° launch jitter as L/R wind sway.
 * Gates on `overlay.battle.dustStorm`. Reveal previews the battle motion:
 * deriver scalars (synced via `revealTimeMs`) ramp amplitude from a breeze
 * floor to the reveal peak (~0.5); battle then eases peak→1.0 and advances
 * phase locally (battle speed throughout) for a continuous full-swing handoff.
 */

import * as THREE from "three";
import { MAP_PX_H, MAP_PX_W } from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import type { EffectManager } from "./fire-burst.ts";

/** Y elevation of the dust sheet — between wall tops (~26) and tower
 *  tops (~56). Reads as airborne dust without burying ground entities
 *  or crowning the tallest geometry. */
const DUST_STORM_Y = 36;
/** Pinned draw order so the transparent dust sheet always composites
 *  above terrain + entity effects but below fog (FOG = 1100). The two
 *  modifiers can't co-occur, but fog's pinned order is the precedent
 *  for transparent ground-plane sheets and we follow it. */
const DUST_STORM_RENDER_ORDER = 1050;
/** Base haze color — warm tan. */
const DUST_HAZE_R = 0.86;
const DUST_HAZE_G = 0.72;
const DUST_HAZE_B = 0.46;
/** Brighter streak color — a touch lighter and yellower than the haze
 *  so streaks feel like sand catching the sun. */
const DUST_STREAK_R = 0.96;
const DUST_STREAK_G = 0.86;
const DUST_STREAK_B = 0.58;
/** Base haze alpha at full reveal. Kept low so the playfield stays
 *  legible — the streak peaks are what carry the visual energy. */
const DUST_HAZE_ALPHA = 0.1;
/** Streak peak alpha at full reveal — additive to the haze base. Kept
 *  low so the rivers read as faint wind-borne hints rather than stripes. */
const DUST_STREAK_ALPHA = 0.12;
/** Battle steady-state oscillation period in seconds. The wind reverses
 *  direction every PERIOD/2 seconds; one full back-and-forth cycle takes
 *  PERIOD seconds. Slow + ominous, not a frantic shake. Mirrored in
 *  `runtime/modifier-effects/dust-storm.ts` (reveal sweeps phase at the
 *  same angular speed for a continuous handoff) — keep in sync. */
const DUST_STORM_SWAY_PERIOD_SEC = 3.2;
/** Peak X-displacement applied to streak peaks at full sway amplitude
 *  (sway = 1), in pixels. Matches the band-wander scale so X and Y
 *  motion read as one coherent gust. */
const DUST_SWAY_AMPLITUDE_PX = 60;
/** Y-band wander amplitude at full sway (sway = 1), in pixels. Bands
 *  drift up/down by this much; scaled by `currentSwayAmp` so wander
 *  rises with the reveal ramp and tracks the gust through battle (no
 *  zero-out — reveal ends at the peak amplitude, not flat). */
const DUST_BAND_WANDER_PX = 28;
/** Per-second exponential lerp rate when easing `currentSwayAmp`
 *  toward its target. Smooths the reveal→battle transition where the
 *  scalar jumps from ~0 to 1 in one frame. ~3 ≈ 95% of the way in 1s. */
const DUST_SWAY_LERP_RATE = 3;
const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
/** 3-layer streak pattern oscillating L/R. `swayOffsetPx = sin(swayPhase)
 *  · DUST_SWAY_AMPLITUDE_PX · currentSwayAmp` is added to each layer's
 *  X coordinate so the streak peaks slide in unison with the gust. The
 *  Y-band wander multiplier (`bandWanderPx`) is also scaled by sway
 *  amplitude — at sway=0 the bands sit at fixed centres and the streak
 *  peaks at fixed positions (the dead-still look only the OFF state
 *  shows; the reveal opens at a breeze floor and climbs from there). */
const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform float swayOffsetPx;
uniform float bandWanderPx;
uniform float swayPhaseRad;
uniform vec2  mapPxSize;
uniform vec3  hazeColor;
uniform vec3  streakColor;
uniform float hazeAlpha;
uniform float streakAlpha;

varying vec2 vUv;

void main() {
  vec2 worldPx = vUv * mapPxSize;

  // Constant translucent sand haze across the whole sheet.
  float alpha = hazeAlpha;
  vec3  color = hazeColor;

  for (int layer = 0; layer < 3; layer++) {
    float lf = float(layer);

    // Band centre + Y wander. Wander uses worldX so neighbouring
    // columns see slightly different band heights (gives the band a
    // soft sinuous edge under sway). Multiplied by bandWanderPx so it
    // shrinks to 0 along with the X sway when amp = 0.
    float bandCentre = mapPxSize.y * (0.22 + lf * 0.30);
    float wander = sin(worldPx.x * 0.018 + swayPhaseRad * (0.4 + lf * 0.12) + lf * 1.7) * bandWanderPx;
    float dy = abs(worldPx.y - bandCentre - wander);

    float thickness = 22.0 + lf * 10.0;
    float yFalloff = 1.0 - clamp(dy / thickness, 0.0, 1.0);

    // X-streak phase. The shared swayOffsetPx slides every layer's
    // peaks in unison; per-layer multipliers stagger the peak frequency
    // so streaks don't perfectly align across layers.
    float xPhase = (worldPx.x + swayOffsetPx) * (0.07 + lf * 0.015)
                 + lf * 2.3
                 + worldPx.y * 0.012;
    float streak = sin(xPhase) * 0.5 + 0.5;
    streak = pow(streak, 6.0);

    float layerStrength = streak * yFalloff;
    float layerAlpha = layerStrength * streakAlpha;

    color = mix(color, streakColor, clamp(layerAlpha / max(alpha + layerAlpha, 1e-4), 0.0, 1.0));
    alpha += layerAlpha;
  }

  alpha = clamp(alpha, 0.0, 0.55);
  gl_FragColor = vec4(color, alpha);
}
`;

export function createDustStormManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "dust-storm";
  scene.add(root);

  const geometry = new THREE.PlaneGeometry(MAP_PX_W, MAP_PX_H);
  geometry.rotateX(-Math.PI / 2);

  const uniforms = {
    swayOffsetPx: { value: 0 },
    bandWanderPx: { value: 0 },
    swayPhaseRad: { value: 0 },
    mapPxSize: { value: new THREE.Vector2(MAP_PX_W, MAP_PX_H) },
    hazeColor: {
      value: new THREE.Color(DUST_HAZE_R, DUST_HAZE_G, DUST_HAZE_B),
    },
    streakColor: {
      value: new THREE.Color(DUST_STREAK_R, DUST_STREAK_G, DUST_STREAK_B),
    },
    hazeAlpha: { value: DUST_HAZE_ALPHA },
    streakAlpha: { value: DUST_STREAK_ALPHA },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(MAP_PX_W / 2, DUST_STORM_Y, MAP_PX_H / 2);
  mesh.frustumCulled = false;
  mesh.renderOrder = DUST_STORM_RENDER_ORDER;
  mesh.visible = false;
  root.add(mesh);

  // Phase advances at a constant battle rate; sway amplitude is what
  // varies (climbs from a breeze floor to the reveal peak during reveal,
  // then eases to 1 once battle is live). Both are manager-owned so the
  // streaks animate continuously without depending on wall-clock time.
  const swayAngularSpeed = (2 * Math.PI) / DUST_STORM_SWAY_PERIOD_SEC;

  let swayPhaseRad = 0;
  let currentSwayAmp = 0;
  let lastNowMs: number | undefined;

  function update(ctx: FrameCtx): void {
    const battle = ctx.overlay?.battle;
    if (!battle?.dustStorm) {
      mesh.visible = false;
      lastNowMs = undefined;
      return;
    }
    mesh.visible = true;

    const dtSec = lastNowMs === undefined ? 0 : (ctx.now - lastNowMs) / 1000;
    lastNowMs = ctx.now;

    const revealAmp = battle.dustStormSwayAmplitude;
    const revealPhase = battle.dustStormSwayPhaseRad;

    if (revealAmp !== undefined) {
      currentSwayAmp = revealAmp;
    } else {
      const lerpAlpha = 1 - Math.exp(-DUST_SWAY_LERP_RATE * dtSec);
      currentSwayAmp += (1 - currentSwayAmp) * lerpAlpha;
    }

    if (revealPhase !== undefined) {
      swayPhaseRad = revealPhase;
    } else {
      swayPhaseRad += dtSec * swayAngularSpeed;
    }

    uniforms.swayPhaseRad.value = swayPhaseRad;
    uniforms.swayOffsetPx.value =
      Math.sin(swayPhaseRad) * DUST_SWAY_AMPLITUDE_PX * currentSwayAmp;
    uniforms.bandWanderPx.value = DUST_BAND_WANDER_PX * currentSwayAmp;
  }

  function dispose(): void {
    root.remove(mesh);
    geometry.dispose();
    material.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
