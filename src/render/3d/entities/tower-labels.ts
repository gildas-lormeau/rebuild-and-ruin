/**
 * 3D billboard labels showing the owning player's name above each home
 * tower during battle. Mirrors the 2D `drawTowers` label pass, which is
 * gated behind `liveEnabled` and therefore skipped in 3D mode.
 *
 * Each label is a `THREE.Sprite` so it always faces the camera and stays
 * readable under battle tilt. One canvas texture is baked per player
 * (name + color are stable) and shared across any towers that player
 * owns. Sprite positions refresh per frame — towers are static during
 * battle, but ownership can change (e.g. `capturedCannons`-like flows
 * later), so the manager reconciles on every update instead of caching
 * a fingerprint.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import {
  getPlayerColor,
  PLAYER_NAMES,
} from "../../../shared/ui/player-config.ts";
import {
  FONT_FLOAT_LG,
  rgb,
  SHADOW_COLOR_DENSE,
  TEXT_ALIGN_CENTER,
} from "../../../shared/ui/theme.ts";
import type { FrameCtx } from "../frame-ctx.ts";

export interface TowerLabelsManager {
  update(ctx: FrameCtx): void;
  dispose(): void;
}

/** Canvas size for the baked label texture (per-player). Power-of-two
 *  keeps GPU upload cheap; 128×32 fits "Red"/"Blue"/"Gold" at 14px bold
 *  with comfortable horizontal padding. */
const LABEL_CANVAS_W = 128;
const LABEL_CANVAS_H = 32;
/** Sprite world-space size. 1 world unit = 1 game-1× pixel, so these
 *  values are the on-screen pixel footprint at camera zoom 1. */
const LABEL_WORLD_W = 128;
const LABEL_WORLD_H = 32;
/** Y-height the label hovers at (world units, above the ground plane).
 *  Sits above the tallest home-tower pole so it clears the geometry on
 *  any zone. */
const LABEL_Y = TILE_SIZE * 6;
/** Tower footprint is 2×2, anchored at top-left, so the world center
 *  sits one tile inward on both axes. */
const TOWER_CENTER_OFFSET = TILE_SIZE;
/** Matches the 2D `drawTowers` label: muted so the tower mesh reads
 *  through. */
const LABEL_OPACITY = 0.7;

export function createTowerLabelsManager(
  scene: THREE.Scene,
): TowerLabelsManager {
  const root = new THREE.Group();
  root.name = "tower-labels";
  scene.add(root);

  const materials = new Map<number, THREE.SpriteMaterial>();
  const textures = new Map<number, THREE.CanvasTexture>();
  const sprites = new Map<number, THREE.Sprite>();

  function ensureMaterial(playerId: ValidPlayerSlot): THREE.SpriteMaterial {
    const cached = materials.get(playerId);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = LABEL_CANVAS_W;
    canvas.height = LABEL_CANVAS_H;
    const ctx = canvas.getContext("2d")!;

    const name = PLAYER_NAMES[playerId] ?? `P${playerId + 1}`;
    const color = getPlayerColor(playerId).interiorLight;

    ctx.font = FONT_FLOAT_LG;
    ctx.textAlign = TEXT_ALIGN_CENTER;
    ctx.textBaseline = "bottom";
    ctx.fillStyle = SHADOW_COLOR_DENSE;
    ctx.fillText(name, LABEL_CANVAS_W / 2, LABEL_CANVAS_H - 4);
    ctx.fillStyle = rgb(color);
    ctx.fillText(name, LABEL_CANVAS_W / 2 - 0.5, LABEL_CANVAS_H - 4.5);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.set(playerId, texture);

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: LABEL_OPACITY,
      depthTest: false,
    });
    materials.set(playerId, material);
    return material;
  }

  function update(ctx: FrameCtx): void {
    const { overlay, map } = ctx;
    const towers = map?.towers;
    const ownedTowers = overlay?.entities?.ownedTowers;
    const inBattle = !!overlay?.battle?.inBattle;

    if (!inBattle || !towers || !ownedTowers) {
      for (const sprite of sprites.values()) sprite.visible = false;
      return;
    }

    const seen = new Set<number>();
    for (let i = 0; i < towers.length; i++) {
      const ownerId = ownedTowers.get(i);
      if (ownerId === undefined) continue;
      const tower = towers[i]!;
      seen.add(i);

      const material = ensureMaterial(ownerId as ValidPlayerSlot);
      let sprite = sprites.get(i);
      if (!sprite) {
        sprite = new THREE.Sprite(material);
        sprite.scale.set(LABEL_WORLD_W, LABEL_WORLD_H, 1);
        sprites.set(i, sprite);
        root.add(sprite);
      } else if (sprite.material !== material) {
        sprite.material = material;
      }
      sprite.position.set(
        tower.col * TILE_SIZE + TOWER_CENTER_OFFSET,
        LABEL_Y,
        tower.row * TILE_SIZE + TOWER_CENTER_OFFSET,
      );
      sprite.visible = true;
    }

    for (const [idx, sprite] of sprites) {
      if (!seen.has(idx)) sprite.visible = false;
    }
  }

  function dispose(): void {
    for (const texture of textures.values()) texture.dispose();
    for (const material of materials.values()) material.dispose();
    while (root.children.length > 0) root.remove(root.children[0]!);
    scene.remove(root);
    textures.clear();
    materials.clear();
    sprites.clear();
  }

  return { update, dispose };
}
