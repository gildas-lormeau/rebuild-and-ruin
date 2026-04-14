/**
 * Sprite atlas loader — loads a PNG sprite sheet and provides drawSprite().
 *
 * Usage:
 *   import { loadAtlas, drawSprite, isAtlasReady } from "./sprites.ts";
 *   await loadAtlas();              // call once at startup
 *   drawSprite(ctx, "house", x, y); // blit a sprite onto a canvas
 */

interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SPRITES: Record<string, SpriteRect> = {
  tower_neutral: {
    x: 0,
    y: 0,
    w: 32,
    h: 32,
  },
  tower_home_p0: {
    x: 34,
    y: 0,
    w: 48,
    h: 48,
  },
  tower_home_p1: {
    x: 84,
    y: 0,
    w: 48,
    h: 48,
  },
  tower_home_p2: {
    x: 134,
    y: 0,
    w: 48,
    h: 48,
  },
  tower_debris: {
    x: 184,
    y: 0,
    w: 32,
    h: 32,
  },
  tower_debris_p0: {
    x: 218,
    y: 0,
    w: 32,
    h: 32,
  },
  tower_debris_p1: {
    x: 252,
    y: 0,
    w: 32,
    h: 32,
  },
  tower_debris_p2: {
    x: 286,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_n: {
    x: 320,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_ne: {
    x: 354,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_e: {
    x: 388,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_se: {
    x: 422,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_s: {
    x: 456,
    y: 0,
    w: 32,
    h: 32,
  },
  cannon_sw: {
    x: 0,
    y: 50,
    w: 32,
    h: 32,
  },
  cannon_w: {
    x: 34,
    y: 50,
    w: 32,
    h: 32,
  },
  cannon_nw: {
    x: 68,
    y: 50,
    w: 32,
    h: 32,
  },
  super_n: {
    x: 102,
    y: 50,
    w: 48,
    h: 48,
  },
  super_ne: {
    x: 152,
    y: 50,
    w: 48,
    h: 48,
  },
  super_e: {
    x: 202,
    y: 50,
    w: 48,
    h: 48,
  },
  super_se: {
    x: 252,
    y: 50,
    w: 48,
    h: 48,
  },
  super_s: {
    x: 302,
    y: 50,
    w: 48,
    h: 48,
  },
  super_sw: {
    x: 352,
    y: 50,
    w: 48,
    h: 48,
  },
  super_w: {
    x: 402,
    y: 50,
    w: 48,
    h: 48,
  },
  super_nw: {
    x: 452,
    y: 50,
    w: 48,
    h: 48,
  },
  mortar_n: {
    x: 0,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_ne: {
    x: 34,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_e: {
    x: 68,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_se: {
    x: 102,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_s: {
    x: 136,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_sw: {
    x: 170,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_w: {
    x: 204,
    y: 100,
    w: 32,
    h: 32,
  },
  mortar_nw: {
    x: 238,
    y: 100,
    w: 32,
    h: 32,
  },
  rampart: {
    x: 272,
    y: 100,
    w: 32,
    h: 32,
  },
  rampart_debris: {
    x: 306,
    y: 100,
    w: 32,
    h: 32,
  },
  shield_aura_2x2: {
    x: 340,
    y: 100,
    w: 32,
    h: 32,
  },
  shield_aura_3x3: {
    x: 374,
    y: 100,
    w: 48,
    h: 48,
  },
  cannon_debris: {
    x: 424,
    y: 100,
    w: 32,
    h: 32,
  },
  super_debris: {
    x: 458,
    y: 100,
    w: 48,
    h: 48,
  },
  wall_debris: {
    x: 0,
    y: 150,
    w: 16,
    h: 16,
  },
  balloon_base: {
    x: 18,
    y: 150,
    w: 32,
    h: 32,
  },
  house: {
    x: 52,
    y: 150,
    w: 16,
    h: 16,
  },
  grunt_n: {
    x: 70,
    y: 150,
    w: 16,
    h: 16,
  },
  grunt_e: {
    x: 88,
    y: 150,
    w: 16,
    h: 16,
  },
  grunt_s: {
    x: 106,
    y: 150,
    w: 16,
    h: 16,
  },
  grunt_w: {
    x: 124,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_h_p0: {
    x: 142,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_v_p0: {
    x: 160,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tl_p0: {
    x: 178,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tr_p0: {
    x: 196,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_bl_p0: {
    x: 214,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_br_p0: {
    x: 232,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_h_p1: {
    x: 250,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_v_p1: {
    x: 268,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tl_p1: {
    x: 286,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tr_p1: {
    x: 304,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_bl_p1: {
    x: 322,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_br_p1: {
    x: 340,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_h_p2: {
    x: 358,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_v_p2: {
    x: 376,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tl_p2: {
    x: 394,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tr_p2: {
    x: 412,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_bl_p2: {
    x: 430,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_br_p2: {
    x: 448,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_h_neutral: {
    x: 466,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_v_neutral: {
    x: 484,
    y: 150,
    w: 16,
    h: 16,
  },
  wall_tl_neutral: {
    x: 0,
    y: 184,
    w: 16,
    h: 16,
  },
  wall_tr_neutral: {
    x: 18,
    y: 184,
    w: 16,
    h: 16,
  },
  wall_bl_neutral: {
    x: 36,
    y: 184,
    w: 16,
    h: 16,
  },
  wall_br_neutral: {
    x: 54,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_light_p0: {
    x: 72,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_dark_p0: {
    x: 90,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_light_p1: {
    x: 108,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_dark_p1: {
    x: 126,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_light_p2: {
    x: 144,
    y: 184,
    w: 16,
    h: 16,
  },
  interior_dark_p2: {
    x: 162,
    y: 184,
    w: 16,
    h: 16,
  },
  bonus_square: {
    x: 180,
    y: 184,
    w: 16,
    h: 16,
  },
  burning_pit_3: {
    x: 198,
    y: 184,
    w: 16,
    h: 16,
  },
  burning_pit_2: {
    x: 216,
    y: 184,
    w: 16,
    h: 16,
  },
  burning_pit_1: {
    x: 234,
    y: 184,
    w: 16,
    h: 16,
  },
  cannonball: {
    x: 252,
    y: 184,
    w: 16,
    h: 16,
  },
  cannonball_incendiary: {
    x: 270,
    y: 184,
    w: 16,
    h: 16,
  },
  balloon_flight: {
    x: 288,
    y: 184,
    w: 32,
    h: 32,
  },
  cobblestone_p0: {
    x: 322,
    y: 184,
    w: 16,
    h: 16,
  },
  cobblestone_p1: {
    x: 340,
    y: 184,
    w: 16,
    h: 16,
  },
  cobblestone_p2: {
    x: 358,
    y: 184,
    w: 16,
    h: 16,
  },
  tower_neutral_battle: {
    x: 376,
    y: 184,
    w: 32,
    h: 32,
  },
  tower_home_p0_battle: {
    x: 410,
    y: 184,
    w: 48,
    h: 48,
  },
  tower_home_p1_battle: {
    x: 460,
    y: 184,
    w: 48,
    h: 48,
  },
  tower_home_p2_battle: {
    x: 0,
    y: 234,
    w: 48,
    h: 48,
  },
  tower_debris_battle: {
    x: 50,
    y: 234,
    w: 32,
    h: 32,
  },
  tower_debris_p0_battle: {
    x: 84,
    y: 234,
    w: 32,
    h: 32,
  },
  tower_debris_p1_battle: {
    x: 118,
    y: 234,
    w: 32,
    h: 32,
  },
  tower_debris_p2_battle: {
    x: 152,
    y: 234,
    w: 32,
    h: 32,
  },
  grass_dark: {
    x: 186,
    y: 234,
    w: 16,
    h: 16,
  },
  grass_light: {
    x: 204,
    y: 234,
    w: 16,
    h: 16,
  },
  grass_battle: {
    x: 222,
    y: 234,
    w: 16,
    h: 16,
  },
  water: {
    x: 240,
    y: 234,
    w: 16,
    h: 16,
  },
  bank: {
    x: 258,
    y: 234,
    w: 16,
    h: 16,
  },
};
/** Load the sprite sheet. Resolves when the image is decoded and ready. */
// @ts-ignore — import.meta.env is Vite-specific
const BASE = import.meta.env?.BASE_URL ?? "/";

let atlas: HTMLImageElement | undefined;

export function loadAtlas(src = `${BASE}assets/sprites.png`): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      atlas = img;
      resolve();
    };
    img.onerror = () =>
      reject(new Error(`Failed to load sprite atlas: ${src}`));
    img.src = src;
  });
}

/**
 * Draw a named sprite onto a canvas context at (dx, dy) in pixel coordinates.
 * Returns false if the atlas isn't loaded or the sprite name is unknown
 * (caller should fall back to procedural drawing).
 */
export function drawSprite(
  canvasCtx: CanvasRenderingContext2D,
  name: string,
  dx: number,
  dy: number,
): boolean {
  const sprite = resolveSprite(name);
  if (!sprite) return false;
  blitSprite(canvasCtx, sprite, dx, dy);
  return true;
}

/**
 * Draw a named sprite centered on (cx, cy).
 * Useful for entities that are positioned by their center (towers, cannons).
 */
export function drawSpriteCentered(
  canvasCtx: CanvasRenderingContext2D,
  name: string,
  cx: number,
  cy: number,
): boolean {
  const sprite = resolveSprite(name);
  if (!sprite) return false;
  blitSprite(canvasCtx, sprite, cx - sprite.rect.w / 2, cy - sprite.rect.h / 2);
  return true;
}

/** Resolve atlas + sprite rect, or null if not ready/unknown. */
function resolveSprite(
  name: string,
): { rect: SpriteRect; img: HTMLImageElement } | null {
  if (!atlas) return null;
  const rect = SPRITES[name];
  if (!rect) return null;
  return { rect, img: atlas };
}

/** Blit a resolved sprite rect at the given destination. */
function blitSprite(
  canvasCtx: CanvasRenderingContext2D,
  sprite: { rect: SpriteRect; img: HTMLImageElement },
  dx: number,
  dy: number,
): void {
  canvasCtx.drawImage(
    sprite.img,
    sprite.rect.x,
    sprite.rect.y,
    sprite.rect.w,
    sprite.rect.h,
    dx,
    dy,
    sprite.rect.w,
    sprite.rect.h,
  );
}
