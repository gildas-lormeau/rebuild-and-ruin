/**
 * Registry of all per-modifier 3D effect managers. Each effect owns its
 * lifecycle via `update(ctx)`; three shapes coexist (one-shot reveal
 * bursts, persistent overlays, event-driven bursts) and each gates
 * itself on the relevant `overlay.*` slice. Adding a new effect: write
 * the file, add one entry here — no other touchpoints in scene.ts /
 * renderer.ts.
 */

import type * as THREE from "three";
import { createDustStormManager } from "./dust-storm.ts";
import type { EffectManager } from "./fire-burst.ts";
import { createFogManager } from "./fog.ts";
import { createGrassEmergenceManager } from "./grass-emergence.ts";
import { createGroundCollapseManager } from "./ground-collapse.ts";
import { createIceFormationManager } from "./ice-formation.ts";
import { createLightningBurstManager } from "./lightning-burst.ts";
import { createShieldFlashManager } from "./shield-flash.ts";
import { createSupplyShipManager } from "./supply-ship.ts";
import { createThawingManager } from "./thawing.ts";
import { createWaterSurgeManager } from "./water-surge.ts";
import { createWildfireBurstManager } from "./wildfire-burst.ts";

type ModifierEffectFactory = (scene: THREE.Scene) => EffectManager;

export const MODIFIER_EFFECT_FACTORIES: readonly ModifierEffectFactory[] = [
  // One-shot reveal bursts (post-banner, ~1.1s window).
  createIceFormationManager,
  createGrassEmergenceManager,
  createWaterSurgeManager,
  createGroundCollapseManager,
  // (frostbite, rubble_clearing, sapper, grunt_surge have NO factory
  // entry here — their runtime-derived overlay multipliers piggyback on
  // the existing entity managers (grunts.ts / walls.ts / debris.ts /
  // pits.ts). See `src/runtime/*-overlay.ts` for the derive functions.
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
  createDustStormManager,
  createSupplyShipManager,
  // Event-driven bursts (per-entry in overlay.entities.X[] / battle.X[]).
  createThawingManager,
  createShieldFlashManager,
];
