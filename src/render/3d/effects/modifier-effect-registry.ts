/**
 * Registry of all per-modifier 3D effect managers.
 *
 * Three lifecycle shapes coexist in the same registry — each effect
 * owns its lifecycle internally via `update(ctx)`:
 *   - one-shot reveal bursts (gate on banner.swept + paletteKey,
 *     animate for ~1.1s, dispose hosts)
 *   - persistent overlays (gate on a state flag, render continuously
 *     while active; fog reads `overlay.battle.fogRevealOpacity` for
 *     the runtime-driven progressive reveal)
 *   - event-driven bursts (consume `overlay.entities.X[]` entries with
 *     `.age` fields, dispose when the set empties)
 *
 * Adding a new modifier effect (any lifecycle): write the effect file,
 * add one entry here. No other touchpoints in scene.ts / renderer.ts.
 */

import type * as THREE from "three";
import type { EffectManager } from "./fire-burst.ts";
import { createFogManager } from "./fog.ts";
import { createGrassEmergenceManager } from "./grass-emergence.ts";
import { createGroundCollapseManager } from "./ground-collapse.ts";
import { createIceFormationManager } from "./ice-formation.ts";
import { createLightningBurstManager } from "./lightning-burst.ts";
import { createThawingManager } from "./thawing.ts";
import { createWallCrumbleManager } from "./wall-crumble.ts";
import { createWaterSurgeManager } from "./water-surge.ts";
import { createWildfireBurstManager } from "./wildfire-burst.ts";

type ModifierEffectFactory = (scene: THREE.Scene) => EffectManager;

export const MODIFIER_EFFECT_FACTORIES: readonly ModifierEffectFactory[] = [
  // One-shot reveal bursts (post-banner, ~1.1s window).
  createIceFormationManager,
  createGrassEmergenceManager,
  createWaterSurgeManager,
  createGroundCollapseManager,
  createWallCrumbleManager,
  // (frostbite, rubble_clearing, sapper, grunt_surge have NO factory
  // entry here — their runtime-derived overlay multipliers piggyback
  // on the existing entity managers (grunts.ts / walls.ts / debris.ts /
  // pits.ts). See `src/runtime/*-overlay.ts` for the derive functions.
  // crumbling_walls layers BOTH: the cross-fade (overlay-driven) AND a
  // disc-burst on the destroyed wall tiles for visibility.
  // Owned-sinkhole bank tinting is now a fragment-shader override on the
  // terrain mesh — see `terrain.ts` + `effects/terrain-sdf-texture.ts` +
  // `effects/terrain-tile-data.ts`. No registry entry needed.)
  createWildfireBurstManager,
  createLightningBurstManager,
  // Persistent overlays (run while gating flag holds). fog_of_war
  // is also overlay-driven (`overlay.battle.fogRevealOpacity` is the
  // multiplier), but via this dedicated manager rather than an
  // existing entity one.
  createFogManager,
  // Event-driven bursts (per-entry in overlay.entities.X[]).
  createThawingManager,
];
