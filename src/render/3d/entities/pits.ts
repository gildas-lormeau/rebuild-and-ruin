/**
 * 3D burning-pit meshes — Phase 4 of the 3D renderer migration.
 *
 * Burning pits are 1×1 tile, ownerless hazards created by mortar /
 * super-gun (fire) cannonball impacts. Each pit lives 3 battle rounds,
 * fading through three authored variants as its `roundsLeft` counter
 * ticks down:
 *
 *   roundsLeft = 3 → `pit_fresh`  (tall flames + hot lava)
 *   roundsLeft = 2 → `pit_dim`    (shorter flames + warm lava)
 *   roundsLeft = 1 → `pit_embers` (no flames, cool embers only)
 *
 * This mirrors the 2D renderer's stage picker in
 * `drawBurningPits` (render-effects.ts), which uses sprites named
 * `burning_pit_3` / `_2` / `_1` keyed on the same counter.
 *
 * Reconciliation: a composite fingerprint of `col:row:variant` per pit
 * covers everything worth rebuilding for. A pit enters the set, its
 * variant swaps on a round decrement, or the set shrinks when the
 * counter hits zero — each of those flips the fingerprint and triggers
 * a full rebuild. Pit counts are bounded (only mortar/fire impacts
 * create them) so tear-down + rebuild is cheap enough here; Phase 8
 * can revisit if profiling warrants.
 *
 * Transparent background: the sprite's charred disc is a narrow ring
 * that does NOT fill the whole tile, so the terrain mesh underneath
 * (including the `PIT_COLOR` brown marker painted by `terrain.ts`)
 * shows through the tile corners. That brown tile-wide tint is kept to
 * frame the pit — the sprite provides the center detail (lava, flames,
 * rim debris).
 */

import * as THREE from "three";
import type { BurningPit } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildPit, getPitVariant } from "../sprites/pit-scene.ts";
import { disposeGroupSubtree } from "./entity-helpers.ts";

export interface PitsManager {
  /** Reconcile pit meshes with the overlay. Cheap no-op when the
   *  composite fingerprint (per-pit col:row:variant) hasn't changed. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Pit scenes are authored in a ±1 frustum spanning a 1-tile footprint.
 *  Scaling by TILE_SIZE / 2 maps 1 authored unit = half a tile, so the
 *  full ±1 sprite fits inside the 1×1 tile cell. Matches the grunt /
 *  cannonball scale convention. */
const PIT_SCALE = TILE_SIZE / 2;
/** 1×1 pits anchor at their single tile; center sits half a tile
 *  inward (identical to the grunts manager convention). */
const TILE_1X1_CENTER_OFFSET = TILE_SIZE / 2;
/** Slow lava-pulse cadence (full sine cycle). 2200 ms reads as a calm
 *  breathing rhythm — fast enough to feel alive, slow enough not to
 *  distract from gameplay. */
const LAVA_PULSE_PERIOD_MS = 2200;
/** Multiplier oscillates between `CENTER - AMPLITUDE` and `CENTER +
 *  AMPLITUDE`. Centered at 0.65 with ±0.35 = visible dim→bright breath
 *  without clipping the brightest peaks. Applied to BOTH base `color`
 *  and `emissive` so the pulse shows regardless of how strongly the
 *  scene lighting saturates the diffuse channel. */
const LAVA_PULSE_CENTER = 0.65;
const LAVA_PULSE_AMPLITUDE = 0.35;

export function createPitsManager(scene: THREE.Scene): PitsManager {
  const root = new THREE.Group();
  root.name = "pits";
  scene.add(root);

  const liveRoot = new THREE.Group();
  liveRoot.name = "pits-live";
  root.add(liveRoot);
  const heldRoot = new THREE.Group();
  heldRoot.name = "pits-held";
  root.add(heldRoot);

  // No per-pit tinted materials — pits are neutral hazards. Kept for
  // parity with the other managers so future owner-tinting (e.g. "your
  // mortar pits" UI hint) can plug in.
  const ownedLiveMaterials: THREE.Material[] = [];
  const ownedHeldMaterials: THREE.Material[] = [];
  // Held materials' baseline alpha — captured at build so per-frame
  // fade can multiply against it without losing the variant's authored
  // opacity (lava, embers, smoke layers all have different bases).
  const heldMaterialBaseOpacity = new WeakMap<THREE.Material, number>();
  // Lava materials per branch + per-material captured base color and
  // emissive (so we modulate against the variant's authored hue, not a
  // hard-coded value). Phase offset is derived from the pit's tile
  // position so dense clusters don't all pulse in lock-step.
  const liveLavaMaterials: THREE.MeshStandardMaterial[] = [];
  const heldLavaMaterials: THREE.MeshStandardMaterial[] = [];
  const lavaPhaseOffsetMs = new WeakMap<THREE.Material, number>();
  const lavaBaseColor = new WeakMap<THREE.Material, THREE.Color>();
  const lavaBaseEmissive = new WeakMap<THREE.Material, THREE.Color>();
  let lastLiveSignature: string | undefined;
  let lastHeldSignature: string | undefined;
  let lastFade: number | undefined;

  function clearLive(): void {
    disposeGroupSubtree(liveRoot, ownedLiveMaterials);
    liveLavaMaterials.length = 0;
  }
  function clearHeld(): void {
    disposeGroupSubtree(heldRoot, ownedHeldMaterials);
    heldLavaMaterials.length = 0;
  }

  function buildPits(
    pits: readonly BurningPit[],
    parent: THREE.Group,
    materialSink: THREE.Material[],
    lavaSink: THREE.MeshStandardMaterial[],
  ): void {
    for (const pit of pits) {
      const variantName = selectVariantName(pit.roundsLeft);
      const variant = getPitVariant(variantName);
      if (!variant) continue;
      const host = new THREE.Group();
      buildPit(THREE, host, variant.params);
      host.position.set(
        pit.col * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
        0,
        pit.row * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
      );
      host.scale.setScalar(PIT_SCALE);
      const phaseOffsetMs = (pit.col * 7 + pit.row * 13) % LAVA_PULSE_PERIOD_MS;
      // Capture the materials so the held branch can fade them; the live
      // branch ignores the sink (kept for symmetry). Lava-tagged meshes
      // also feed `lavaSink` for the per-frame color+emissive pulse.
      host.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mats = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        const isLava = obj.userData.isLava === true;
        for (const mat of mats) {
          materialSink.push(mat);
          if (isLava && mat instanceof THREE.MeshStandardMaterial) {
            if (!lavaPhaseOffsetMs.has(mat)) {
              lavaSink.push(mat);
              lavaPhaseOffsetMs.set(mat, phaseOffsetMs);
              lavaBaseColor.set(mat, mat.color.clone());
              lavaBaseEmissive.set(mat, mat.emissive.clone());
            }
          }
        }
      });
      parent.add(host);
    }
  }

  let pulsedAtLastFrame = false;
  function resetLavaToBase(mat: THREE.MeshStandardMaterial): void {
    const baseColor = lavaBaseColor.get(mat);
    const baseEmissive = lavaBaseEmissive.get(mat);
    if (baseColor) mat.color.copy(baseColor);
    if (baseEmissive) mat.emissive.copy(baseEmissive);
  }
  function applyLavaPulse(now: number, inBattle: boolean): void {
    if (liveLavaMaterials.length === 0 && heldLavaMaterials.length === 0)
      return;
    // Outside battle, restore the authored color/emissive once and skip
    // the per-frame work. Pits are quiet during build/cannon-place.
    if (!inBattle) {
      if (pulsedAtLastFrame) {
        for (const mat of liveLavaMaterials) resetLavaToBase(mat);
        for (const mat of heldLavaMaterials) resetLavaToBase(mat);
        pulsedAtLastFrame = false;
      }
      return;
    }
    pulsedAtLastFrame = true;
    const TWO_PI = Math.PI * 2;
    const pulseOne = (mat: THREE.MeshStandardMaterial): void => {
      const offset = lavaPhaseOffsetMs.get(mat) ?? 0;
      const phase = ((now + offset) / LAVA_PULSE_PERIOD_MS) * TWO_PI;
      const mult = LAVA_PULSE_CENTER + LAVA_PULSE_AMPLITUDE * Math.sin(phase);
      const baseColor = lavaBaseColor.get(mat);
      const baseEmissive = lavaBaseEmissive.get(mat);
      if (baseColor) mat.color.copy(baseColor).multiplyScalar(mult);
      if (baseEmissive) mat.emissive.copy(baseEmissive).multiplyScalar(mult);
    };
    for (const mat of liveLavaMaterials) pulseOne(mat);
    for (const mat of heldLavaMaterials) pulseOne(mat);
  }

  function captureHeldBaseOpacity(): void {
    heldRoot.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (heldMaterialBaseOpacity.has(mat)) continue;
        heldMaterialBaseOpacity.set(mat, mat.opacity);
        mat.transparent = true;
      }
    });
  }

  function applyHeldFade(fade: number): void {
    heldRoot.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        const base = heldMaterialBaseOpacity.get(mat) ?? mat.opacity;
        mat.opacity = base * fade;
      }
    });
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const livePits = overlay?.entities?.burningPits ?? [];
    const heldPits = overlay?.battle?.heldRubblePits ?? [];
    const fade = overlay?.battle?.rubbleClearingFade;

    const liveSignature = computeSignature(livePits);
    if (liveSignature !== lastLiveSignature) {
      lastLiveSignature = liveSignature;
      clearLive();
      if (livePits.length > 0)
        buildPits(livePits, liveRoot, ownedLiveMaterials, liveLavaMaterials);
    }

    const heldSignature = computeSignature(heldPits);
    if (heldSignature !== lastHeldSignature) {
      lastHeldSignature = heldSignature;
      clearHeld();
      if (heldPits.length > 0) {
        buildPits(heldPits, heldRoot, ownedHeldMaterials, heldLavaMaterials);
        captureHeldBaseOpacity();
      }
    }

    if (fade !== lastFade && heldPits.length > 0) {
      lastFade = fade;
      applyHeldFade(fade ?? 1);
    } else if (heldPits.length === 0) {
      lastFade = undefined;
    }

    applyLavaPulse(ctx.now, overlay?.battle?.inBattle === true);
  }

  function dispose(): void {
    clearLive();
    clearHeld();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Composite signature across every pit. Rebuilds only when one of
 *  the watched fields changes (position, set membership, or variant
 *  from a round decrement). */
function computeSignature(pits: readonly BurningPit[]): string {
  if (pits.length === 0) return "";
  const parts: string[] = [];
  for (const pit of pits) {
    parts.push(`${pit.col}:${pit.row}:${selectVariantName(pit.roundsLeft)}`);
  }
  return parts.join("|");
}

/** Pick a pit-scene variant name from the remaining-rounds counter.
 *  Mirrors the 2D stage picker in `drawBurningPits`: clamps to [1, 3]
 *  and maps 3 → fresh, 2 → dim, 1 → embers. */
function selectVariantName(roundsLeft: number): string {
  const stage = Math.max(1, Math.min(3, roundsLeft));
  if (stage === 3) return "pit_fresh";
  if (stage === 2) return "pit_dim";
  return "pit_embers";
}
