/**
 * 3D bonus-square indicators — an inset 8×8 square painted in the
 * *alternative* checker-grass color so each bonus tile reads as a
 * smaller inner tile of the opposite shade from its surround.
 *
 * Depth-tested at `ELEVATION_STACK.BONUS_DISCS` so grunts and other
 * standing entities occlude the inset naturally. `renderOrder` is set
 * high to beat the transparent terrain mesh in the sort; depth test
 * still does the right thing against opaque standing geometry.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK, RENDER_ORDER } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { tileSignature } from "./helpers.ts";

export interface BonusSquaresManager {
  update(ctx: FrameCtx): void;
  dispose(): void;
}

/** Inset size in world pixels — 8 of the 16 tile-width. */
const INSET_SIZE = 8;
/** Checker-grass base colors (match `GRASS_DARK` / `GRASS_LIGHT` in
 *  render-map.ts). We pick whichever shade is NOT under the tile so
 *  the inset contrasts against the tile's own grass. */
const GRASS_DARK = 0x2d8c2d;
// (45, 140, 45)
const GRASS_LIGHT = 0x339933;
// (51, 153, 51)
/** Smooth breathing period in ms. Slower than the old 300ms flash so
 *  the pulse reads as a gentle glow rather than a strobe. */
const PULSE_PERIOD_MS = 1200;
/** Opacity range — never fully fades out so the inset stays readable. */
const PULSE_MIN = 0.55;
const PULSE_MAX = 1.0;

export function createBonusSquaresManager(
  scene: THREE.Scene,
): BonusSquaresManager {
  const root = new THREE.Group();
  root.name = "bonusSquares";
  scene.add(root);

  // Unit plane rotated flat onto the XZ ground plane; each mesh is
  // scaled by INSET_SIZE so it occupies an 8×8 world-pixel square.
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);

  // Two shared materials, one per checker parity. A bonus tile at
  // (row, col) gets the material OPPOSITE to its own grass shade
  // (parity (row+col) % 2; 0 = dark in grassBaseColor, so show light,
  // and vice-versa). Opacity is rewritten each frame from the pulse.
  const matShowLight = new THREE.MeshBasicMaterial({
    color: GRASS_LIGHT,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const matShowDark = new THREE.MeshBasicMaterial({
    color: GRASS_DARK,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });

  const meshes: THREE.Mesh[] = [];
  let activeCount = 0;
  let lastSignature: string | undefined;

  function reconcile(
    tiles: readonly { row: number; col: number }[] | undefined,
  ): void {
    const signature = tileSignature(tiles);
    if (signature === lastSignature) return;
    lastSignature = signature;
    activeCount = tiles?.length ?? 0;
    for (let i = 0; i < activeCount; i++) {
      const bonus = tiles![i]!;
      // Grass at this tile is GRASS_DARK when (row+col)%2===0, else
      // GRASS_LIGHT. Use the other shade for the inset.
      const showLight = (bonus.row + bonus.col) % 2 === 0;
      const material = showLight ? matShowLight : matShowDark;
      let mesh = meshes[i];
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = RENDER_ORDER.EFFECT;
        mesh.scale.setScalar(INSET_SIZE);
        meshes.push(mesh);
        root.add(mesh);
      } else if (mesh.material !== material) {
        mesh.material = material;
      }
      mesh.position.set(
        bonus.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.BONUS_DISCS,
        bonus.row * TILE_SIZE + TILE_SIZE / 2,
      );
      mesh.visible = true;
    }
    for (let i = activeCount; i < meshes.length; i++) {
      meshes[i]!.visible = false;
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    const inBattle = !!overlay?.battle?.inBattle;
    const tiles = inBattle ? undefined : overlay?.entities?.bonusSquares;
    reconcile(tiles);
    if (activeCount === 0) {
      matShowLight.opacity = 0;
      matShowDark.opacity = 0;
      return;
    }
    // Smooth sine breathe between PULSE_MIN and PULSE_MAX.
    const phase = ((now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS) * Math.PI * 2;
    const t = 0.5 + 0.5 * Math.sin(phase);
    const opacity = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * t;
    matShowLight.opacity = opacity;
    matShowDark.opacity = opacity;
  }

  function dispose(): void {
    for (const mesh of meshes) root.remove(mesh);
    meshes.length = 0;
    geometry.dispose();
    matShowLight.dispose();
    matShowDark.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
