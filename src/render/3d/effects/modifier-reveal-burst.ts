/**
 * Shared 3D modifier-reveal burst pattern.
 *
 * Many modifier reveals share the same shape: each affected tile gets a
 * colored disc that scales 0 → max with easeOutQuad and an opacity that
 * peaks at midpoint then fades, plus a brief flash ring at the tile's
 * stagger start. Per-tile delay is seed-derived so the effect appears to
 * roll across the affected tiles instead of snapping in uniformly.
 *
 * Triggered when `overlay.ui.modifierReveal.paletteKey === paletteKey`
 * AND the banner sweep has completed (`banner.progress >= 1`). Runs once
 * per modifier roll, then disposes all hosts.
 */

import * as THREE from "three";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createFlatDisc, tileSeed } from "./helpers.ts";

interface ModifierRevealBurstConfig {
  /** Group name in the scene graph (debug visibility). */
  readonly name: string;
  /** ModifierId to gate on (matches `overlay.ui.modifierReveal.paletteKey`). */
  readonly paletteKey: string;
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
  let revealStartMs: number | undefined;
  let lastPaletteKey: string | undefined;

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
    revealStartMs = undefined;
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
  }

  function startReveal(now: number, tiles: readonly number[]): void {
    revealStartMs = now;
    ensurePool(tiles.length);
    const delays = (config.computeDelays ?? seededRandomDelays)(
      tiles,
      config.staggerSpanMs,
    );
    for (let i = 0; i < tiles.length; i++) {
      const key = tiles[i]!;
      const row = Math.floor(key / GRID_COLS);
      const col = key % GRID_COLS;
      const host = hosts[i]!;
      host.delayMs = delays[i]!;
      host.group.position.set(
        col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.THAWING,
        row * TILE_SIZE + TILE_SIZE / 2,
      );
    }
  }

  function update(ctx: FrameCtx): void {
    const reveal = ctx.overlay?.ui?.modifierReveal;
    const banner = ctx.overlay?.ui?.banner;

    // Only react to our modifier. When the modifier flips off (phase
    // leaves MODIFIER_REVEAL or a different modifier rolls), reset.
    if (reveal?.paletteKey !== config.paletteKey) {
      if (lastPaletteKey === config.paletteKey) reset();
      lastPaletteKey = reveal?.paletteKey;
      return;
    }
    lastPaletteKey = reveal.paletteKey;

    // Wait for banner sweep to complete before kicking the reveal.
    const sweepDone = banner === undefined || banner.progress >= 1;
    if (!sweepDone) return;

    if (revealStartMs === undefined) {
      startReveal(ctx.now, reveal.tiles);
    }

    const elapsed = ctx.now - revealStartMs!;
    let allDone = true;
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i]!;
      const tileElapsed = elapsed - host.delayMs;

      if (tileElapsed >= config.discDurationMs) {
        host.discMesh.visible = false;
        host.flashMesh.visible = false;
        continue;
      }
      allDone = false;

      if (tileElapsed <= 0) {
        host.discMesh.visible = false;
        host.flashMesh.visible = false;
        continue;
      }

      // Disc: grows + opacity peaks at midpoint, fades to zero.
      const t = tileElapsed / config.discDurationMs;
      const radius = maxRadius * easeOutQuad(t);
      const opacity = (t < 0.5 ? t * 2 : (1 - t) * 2) * config.discPeakOpacity;
      host.discMaterial.opacity = opacity;
      host.discMesh.scale.set(radius, 1, radius);
      host.discMesh.visible = true;

      // Flash ring: brief expanding burst at tile start.
      if (tileElapsed < config.flashDurationMs) {
        const flashT = tileElapsed / config.flashDurationMs;
        const flashRadius = maxRadius * flashT;
        host.flashMaterial.opacity = (1 - flashT) * config.flashPeakOpacity;
        host.flashMesh.scale.set(flashRadius, 1, flashRadius);
        host.flashMesh.visible = true;
      } else {
        host.flashMesh.visible = false;
      }
    }

    if (allDone) reset();
  }

  function dispose(): void {
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
    discGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
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
