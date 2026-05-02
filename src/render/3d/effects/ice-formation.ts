/**
 * 3D ice-formation effect — post-banner reveal animation for the
 * `frozen_river` modifier.
 *
 * Triggers when `overlay.ui.modifierReveal.paletteKey === "frozen_river"`
 * AND the banner sweep has completed (`banner.progress >= 1`). Runs once
 * during the MODIFIER_REVEAL dwell phase — each affected tile gets a
 * frosty disc that scales up and fades, plus a brief flash ring at the
 * tile's stagger start. Per-tile delay is seed-derived so the freeze
 * appears to roll across the river instead of snapping in uniformly.
 *
 * Decorative only: terrain-bitmap already paints these tiles as frozen
 * at banner-snapshot time (state.modern.frozenTiles is set at apply).
 * This effect is the live "freeze happening now" flair on top.
 */

import * as THREE from "three";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { createFlatDisc, tileSeed } from "./helpers.ts";

export interface IceFormationManager {
  update(ctx: FrameCtx): void;
  dispose(): void;
}

interface IceHost {
  group: THREE.Group;
  frostMesh: THREE.Mesh;
  frostMaterial: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMaterial: THREE.MeshBasicMaterial;
  delayMs: number;
}

const FROZEN_RIVER_KEY = "frozen_river";
const FROST_DURATION_MS = 1100;
const FLASH_DURATION_MS = 200;
const STAGGER_SPAN_MS = 600;
const ICE_TINT = 0xc0e0ff;
const FLASH_COLOR = 0xffffff;
const MAX_DISC_RADIUS = TILE_SIZE / 2;
const FROST_PEAK_OPACITY = 0.7;
const FLASH_PEAK_OPACITY = 0.5;

export function createIceFormationManager(
  scene: THREE.Scene,
): IceFormationManager {
  const root = new THREE.Group();
  root.name = "ice-formation";
  scene.add(root);

  const discGeometry = createFlatDisc();
  const hosts: IceHost[] = [];
  let revealStartMs: number | undefined;
  let lastPaletteKey: string | undefined;

  function buildHost(): IceHost {
    const group = new THREE.Group();
    const frostMaterial = new THREE.MeshBasicMaterial({
      color: ICE_TINT,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const frostMesh = new THREE.Mesh(discGeometry, frostMaterial);
    group.add(frostMesh);

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR,
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
      frostMesh,
      frostMaterial,
      flashMesh,
      flashMaterial,
      delayMs: 0,
    };
  }

  function disposeHost(host: IceHost): void {
    host.frostMaterial.dispose();
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
    for (let i = 0; i < tiles.length; i++) {
      const key = tiles[i]!;
      const row = Math.floor(key / GRID_COLS);
      const col = key % GRID_COLS;
      const host = hosts[i]!;
      host.delayMs =
        ((tileSeed(row, col) >>> 0) % 1000) * (STAGGER_SPAN_MS / 1000);
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

    // Only react to frozen_river. When the modifier flips off (phase
    // leaves MODIFIER_REVEAL or a different modifier rolls), reset.
    if (reveal?.paletteKey !== FROZEN_RIVER_KEY) {
      if (lastPaletteKey === FROZEN_RIVER_KEY) reset();
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

      if (tileElapsed >= FROST_DURATION_MS) {
        host.frostMesh.visible = false;
        host.flashMesh.visible = false;
        continue;
      }
      allDone = false;

      if (tileElapsed <= 0) {
        host.frostMesh.visible = false;
        host.flashMesh.visible = false;
        continue;
      }

      // Frost disc: grows + opacity peaks at midpoint, fades to zero.
      const t = tileElapsed / FROST_DURATION_MS;
      const radius = MAX_DISC_RADIUS * easeOutQuad(t);
      const opacity = (t < 0.5 ? t * 2 : (1 - t) * 2) * FROST_PEAK_OPACITY;
      host.frostMaterial.opacity = opacity;
      host.frostMesh.scale.set(radius, 1, radius);
      host.frostMesh.visible = true;

      // Flash ring: brief expanding white burst at tile start.
      if (tileElapsed < FLASH_DURATION_MS) {
        const flashT = tileElapsed / FLASH_DURATION_MS;
        const flashRadius = MAX_DISC_RADIUS * flashT;
        host.flashMaterial.opacity = (1 - flashT) * FLASH_PEAK_OPACITY;
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
