/**
 * Registry of all per-modifier 3D effect managers.
 *
 * Four lifecycle shapes coexist in the same registry — each effect
 * owns its lifecycle internally via `update(ctx)`:
 *   - one-shot reveal bursts (gate on banner.swept + paletteKey,
 *     animate for ~1.1s, dispose hosts)
 *   - persistent overlays (gate on a state flag like fogOfWar, run
 *     continuously while active)
 *   - event-driven bursts (consume `overlay.entities.X[]` entries with
 *     `.age` fields, dispose when the set empties)
 *   - service-driven effects (drive a service-style manager via deps,
 *     own no meshes — the manager handles all rendering, the effect
 *     owns the modifier/banner orchestration; e.g. fog-reveal)
 *
 * Adding a new modifier effect (any lifecycle): write the effect file,
 * add one entry here. No other touchpoints in scene.ts / renderer.ts —
 * unless the effect needs a service-style manager, in which case
 * scene.ts wires the manager into `ModifierEffectDeps`.
 *
 * Factories take `(scene, deps)`. Most ignore `deps`; the few that need
 * shared dependencies (e.g. sinkhole overlay needs the
 * `getSinkholeOverlayBitmap` accessor, fog-reveal needs the fog
 * manager itself) pluck what they want.
 */

import type * as THREE from "three";
import type { EffectManager } from "./fire-burst.ts";
import type { FogManager } from "./fog.ts";
import { createFogRevealManager } from "./fog-reveal.ts";
import { createGrassEmergenceManager } from "./grass-emergence.ts";
import { createGroundCollapseManager } from "./ground-collapse.ts";
import { createGruntFrostManager } from "./grunt-frost.ts";
import { createIceFormationManager } from "./ice-formation.ts";
import { createLightningBurstManager } from "./lightning-burst.ts";
import { createRubbleClearedManager } from "./rubble-cleared.ts";
import {
  createSinkholeOverlayManager,
  type GetSinkholeOverlayBitmap,
} from "./sinkhole-overlay.ts";
import { createSpawnBurstManager } from "./spawn-burst.ts";
import { createThawingManager } from "./thawing.ts";
import { createWallCrumbleManager } from "./wall-crumble.ts";
import { createWallThreatManager } from "./wall-threat.ts";
import { createWaterSurgeManager } from "./water-surge.ts";
import { createWildfireBurstManager } from "./wildfire-burst.ts";

/** Shared dependencies passed to every modifier-effect factory. Most
 *  factories ignore this; add fields here when a new factory needs
 *  scene-construction-time dependencies it can't read from `FrameCtx`.
 *
 *  Service-style managers (fog, sinkhole) are constructed in scene.ts
 *  outside this registry and exposed here so registry-side effects
 *  (`fog-reveal.ts` etc.) can drive them via small APIs without owning
 *  the rendering. */
interface ModifierEffectDeps {
  readonly getSinkholeOverlayBitmap: GetSinkholeOverlayBitmap;
  readonly fogManager: FogManager;
}

type ModifierEffectFactory = (
  scene: THREE.Scene,
  deps: ModifierEffectDeps,
) => EffectManager;

export const MODIFIER_EFFECT_FACTORIES: readonly ModifierEffectFactory[] = [
  // One-shot reveal bursts (post-banner, ~1.1s window).
  createIceFormationManager,
  createGrassEmergenceManager,
  createWaterSurgeManager,
  createGroundCollapseManager,
  createWallThreatManager,
  createGruntFrostManager,
  createWallCrumbleManager,
  createSpawnBurstManager,
  createWildfireBurstManager,
  createLightningBurstManager,
  createRubbleClearedManager,
  // Persistent overlays (run while gating flag holds).
  (scene, deps) =>
    createSinkholeOverlayManager(scene, deps.getSinkholeOverlayBitmap),
  // Service-driven effects (drive a manager via deps, no own meshes).
  (_scene, deps) => createFogRevealManager(deps.fogManager),
  // Event-driven bursts (per-entry in overlay.entities.X[]).
  createThawingManager,
];
