/**
 * Shared 3D modifier-reveal burst pattern. Each affected tile gets a colored
 * disc that scales 0 → max with easeOutQuad and an opacity that peaks at
 * midpoint then fades, plus a brief flash ring at the tile's stagger start.
 * Per-tile delay is seed-derived so the effect rolls across affected tiles
 * instead of snapping in uniformly. Triggered when the active modifier
 * matches `config.modifierId` and `revealTimeMs` is defined; the runtime
 * holds `revealTimeMs === 0` during the snapshot window so the per-tile
 * `tileElapsed = revealTimeMs - delayMs` is non-positive then (no draws).
 */

import * as THREE from "three";
import type { ModifierId } from "../../../shared/core/game-constants.ts";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createFlatDisc, tileSeed } from "./helpers.ts";

interface ModifierRevealBurstConfig {
  /** Group name in the scene graph (debug visibility). */
  readonly name: string;
  /** ModifierId this burst belongs to. The manager activates only when
   *  the active reveal matches. */
  readonly modifierId: ModifierId;
  /** Disc tint hex. Peaks at `discPeakOpacity` then fades. */
  readonly discColor: number;
  /** Brief flash-ring tint hex (typically white). */
  readonly flashColor: number;
  /** Disc grow + fade total duration, ms. */
  readonly discDurationMs: number;
  /** Flash ring grow + fade duration, ms (≪ discDurationMs). */
  readonly flashDurationMs: number;
  /** Max per-tile stagger added on top of the global start, ms. */
  readonly staggerSpanMs: number;
  /** Disc opacity at midpoint of its window. */
  readonly discPeakOpacity: number;
  /** Flash ring opacity at start of its window. */
  readonly flashPeakOpacity: number;
  /** Max disc + flash radius (defaults to half a tile so visuals stay inside the tile). */
  readonly maxRadius?: number;
  /** Per-tile delay producer. Defaults to seeded-random within
   *  `staggerSpanMs` (the legacy "rolling" feel). Override to get a
   *  directional wave, sequential strikes, etc. */
  readonly computeDelays?: (
    tiles: readonly number[],
    staggerSpanMs: number,
  ) => readonly number[];
}

interface BurstHost {
  group: THREE.Group;
  discMesh: THREE.Mesh;
  discMaterial: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMaterial: THREE.MeshBasicMaterial;
  delayMs: number;
}

export function createModifierRevealBurstManager(
  scene: THREE.Scene,
  config: ModifierRevealBurstConfig,
): EffectManager {
  const maxRadius = config.maxRadius ?? TILE_SIZE / 2;
  const root = new THREE.Group();
  root.name = config.name;
  scene.add(root);

  const discGeometry = createFlatDisc();
  const hosts: BurstHost[] = [];

  function buildHost(): BurstHost {
    const group = new THREE.Group();
    const discMaterial = new THREE.MeshBasicMaterial({
      color: config.discColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const discMesh = new THREE.Mesh(discGeometry, discMaterial);
    group.add(discMesh);

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: config.flashColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const flashMesh = new THREE.Mesh(discGeometry, flashMaterial);
    flashMesh.position.y = Z_FIGHT_MARGIN;
    group.add(flashMesh);

    root.add(group);
    return {
      group,
      discMesh,
      discMaterial,
      flashMesh,
      flashMaterial,
      delayMs: 0,
    };
  }

  function disposeHost(host: BurstHost): void {
    host.discMaterial.dispose();
    host.flashMaterial.dispose();
    root.remove(host.group);
  }

  function ensurePool(count: number): void {
    while (hosts.length < count) hosts.push(buildHost());
    while (hosts.length > count) {
      const host = hosts.pop();
      if (host) disposeHost(host);
    }
  }

  function reset(): void {
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
  }

  function startReveal(tiles: readonly number[]): void {
    ensurePool(tiles.length);
    const delays = (config.computeDelays ?? seededRandomDelays)(
      tiles,
      config.staggerSpanMs,
    );
    for (let idx = 0; idx < tiles.length; idx++) {
      const key = tiles[idx]!;
      const row = Math.floor(key / GRID_COLS);
      const col = key % GRID_COLS;
      const host = hosts[idx]!;
      host.delayMs = delays[idx]!;
      host.group.position.set(
        col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.THAWING,
        row * TILE_SIZE + TILE_SIZE / 2,
      );
    }
  }

  function update(ctx: FrameCtx): void {
    const reveal = ctx.overlay?.ui?.modifierReveal;
    if (reveal?.modifierId !== config.modifierId) {
      if (hosts.length > 0) reset();
      return;
    }

    const elapsed = reveal.revealTimeMs;
    if (hosts.length === 0) startReveal(reveal.tiles);

    for (let idx = 0; idx < hosts.length; idx++) {
      const host = hosts[idx]!;
      const tileElapsed = elapsed - host.delayMs;

      if (tileElapsed <= 0 || tileElapsed >= config.discDurationMs) {
        host.discMesh.visible = false;
        host.flashMesh.visible = false;
        continue;
      }

      // Disc: grows + opacity peaks at midpoint, fades to zero.
      const progress = tileElapsed / config.discDurationMs;
      const radius = maxRadius * easeOutQuad(progress);
      const opacity =
        (progress < 0.5 ? progress * 2 : (1 - progress) * 2) *
        config.discPeakOpacity;
      host.discMaterial.opacity = opacity;
      host.discMesh.scale.set(radius, 1, radius);
      host.discMesh.visible = true;

      // Flash ring: brief expanding burst at tile start.
      if (tileElapsed < config.flashDurationMs) {
        const flashProgress = tileElapsed / config.flashDurationMs;
        const flashRadius = maxRadius * flashProgress;
        host.flashMaterial.opacity =
          (1 - flashProgress) * config.flashPeakOpacity;
        host.flashMesh.scale.set(flashRadius, 1, flashRadius);
        host.flashMesh.visible = true;
      } else {
        host.flashMesh.visible = false;
      }
    }
  }

  function dispose(): void {
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
    discGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}

function easeOutQuad(progress: number): number {
  return 1 - (1 - progress) * (1 - progress);
}

function seededRandomDelays(
  tiles: readonly number[],
  staggerSpanMs: number,
): readonly number[] {
  const result: number[] = [];
  for (const key of tiles) {
    const row = Math.floor(key / GRID_COLS);
    const col = key % GRID_COLS;
    result.push(((tileSeed(row, col) >>> 0) % 1000) * (staggerSpanMs / 1000));
  }
  return result;
}
