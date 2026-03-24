/**
 * Sprite atlas loader — loads a PNG sprite sheet and provides drawSprite().
 *
 * Usage:
 *   import { loadAtlas, drawSprite, isAtlasReady } from "./sprites";
 *   await loadAtlas();              // call once at startup
 *   drawSprite(ctx, "house", x, y); // blit a sprite onto a canvas
 */

// ---------------------------------------------------------------------------
// Sprite map — name → { x, y, w, h } in the 1x atlas
// ---------------------------------------------------------------------------

interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SPRITES: Record<string, SpriteRect> = {
  tower_neutral:       { x: 0,   y: 0,   w: 32, h: 32 },
  tower_home_p0:       { x: 34,  y: 0,   w: 48, h: 48 },
  tower_home_p1:       { x: 84,  y: 0,   w: 48, h: 48 },
  tower_home_p2:       { x: 134, y: 0,   w: 48, h: 48 },
  tower_debris:        { x: 184, y: 0,   w: 32, h: 32 },
  tower_debris_p0:     { x: 218, y: 0,   w: 32, h: 32 },
  tower_debris_p1:     { x: 252, y: 0,   w: 32, h: 32 },
  tower_debris_p2:     { x: 286, y: 0,   w: 32, h: 32 },
  cannon_n:            { x: 320, y: 0,   w: 32, h: 32 },
  cannon_ne:           { x: 354, y: 0,   w: 32, h: 32 },
  cannon_e:            { x: 388, y: 0,   w: 32, h: 32 },
  cannon_se:           { x: 422, y: 0,   w: 32, h: 32 },
  cannon_s:            { x: 456, y: 0,   w: 32, h: 32 },
  cannon_sw:           { x: 0,   y: 50,  w: 32, h: 32 },
  cannon_w:            { x: 34,  y: 50,  w: 32, h: 32 },
  cannon_nw:           { x: 68,  y: 50,  w: 32, h: 32 },
  super_n:             { x: 102, y: 50,  w: 48, h: 48 },
  super_ne:            { x: 152, y: 50,  w: 48, h: 48 },
  super_e:             { x: 202, y: 50,  w: 48, h: 48 },
  super_se:            { x: 252, y: 50,  w: 48, h: 48 },
  super_s:             { x: 302, y: 50,  w: 48, h: 48 },
  super_sw:            { x: 352, y: 50,  w: 48, h: 48 },
  super_w:             { x: 402, y: 50,  w: 48, h: 48 },
  super_nw:            { x: 452, y: 50,  w: 48, h: 48 },
  cannon_debris:       { x: 0,   y: 100, w: 32, h: 32 },
  super_debris:        { x: 34,  y: 100, w: 48, h: 48 },
  wall_debris:         { x: 84,  y: 100, w: 16, h: 16 },
  balloon_base:        { x: 102, y: 100, w: 32, h: 32 },
  house:               { x: 136, y: 100, w: 16, h: 16 },
  grunt_n:             { x: 154, y: 100, w: 16, h: 16 },
  grunt_e:             { x: 172, y: 100, w: 16, h: 16 },
  grunt_s:             { x: 190, y: 100, w: 16, h: 16 },
  grunt_w:             { x: 208, y: 100, w: 16, h: 16 },
  wall_h_p0:           { x: 226, y: 100, w: 16, h: 16 },
  wall_v_p0:           { x: 244, y: 100, w: 16, h: 16 },
  wall_tl_p0:          { x: 262, y: 100, w: 16, h: 16 },
  wall_tr_p0:          { x: 280, y: 100, w: 16, h: 16 },
  wall_bl_p0:          { x: 298, y: 100, w: 16, h: 16 },
  wall_br_p0:          { x: 316, y: 100, w: 16, h: 16 },
  wall_h_p1:           { x: 334, y: 100, w: 16, h: 16 },
  wall_v_p1:           { x: 352, y: 100, w: 16, h: 16 },
  wall_tl_p1:          { x: 370, y: 100, w: 16, h: 16 },
  wall_tr_p1:          { x: 388, y: 100, w: 16, h: 16 },
  wall_bl_p1:          { x: 406, y: 100, w: 16, h: 16 },
  wall_br_p1:          { x: 424, y: 100, w: 16, h: 16 },
  wall_h_p2:           { x: 442, y: 100, w: 16, h: 16 },
  wall_v_p2:           { x: 460, y: 100, w: 16, h: 16 },
  wall_tl_p2:          { x: 478, y: 100, w: 16, h: 16 },
  wall_tr_p2:          { x: 496, y: 100, w: 16, h: 16 },
  wall_bl_p2:          { x: 0,   y: 150, w: 16, h: 16 },
  wall_br_p2:          { x: 18,  y: 150, w: 16, h: 16 },
  wall_h_neutral:      { x: 36,  y: 150, w: 16, h: 16 },
  wall_v_neutral:      { x: 54,  y: 150, w: 16, h: 16 },
  wall_tl_neutral:     { x: 72,  y: 150, w: 16, h: 16 },
  wall_tr_neutral:     { x: 90,  y: 150, w: 16, h: 16 },
  wall_bl_neutral:     { x: 108, y: 150, w: 16, h: 16 },
  wall_br_neutral:     { x: 126, y: 150, w: 16, h: 16 },
  interior_light_p0:   { x: 144, y: 150, w: 16, h: 16 },
  interior_dark_p0:    { x: 162, y: 150, w: 16, h: 16 },
  interior_light_p1:   { x: 180, y: 150, w: 16, h: 16 },
  interior_dark_p1:    { x: 198, y: 150, w: 16, h: 16 },
  interior_light_p2:   { x: 216, y: 150, w: 16, h: 16 },
  interior_dark_p2:    { x: 234, y: 150, w: 16, h: 16 },
  bonus_square:        { x: 252, y: 150, w: 16, h: 16 },
  burning_pit_3:       { x: 270, y: 150, w: 16, h: 16 },
  burning_pit_2:       { x: 288, y: 150, w: 16, h: 16 },
  burning_pit_1:       { x: 306, y: 150, w: 16, h: 16 },
  cannonball:          { x: 324, y: 150, w: 16, h: 16 },
  cannonball_incendiary: { x: 342, y: 150, w: 16, h: 16 },
  balloon_flight:      { x: 360, y: 150, w: 32, h: 32 },
  // Cobblestone floor (battle-phase territory)
  cobblestone_p0:          { x: 394, y: 150, w: 16, h: 16 },
  cobblestone_p1:          { x: 412, y: 150, w: 16, h: 16 },
  cobblestone_p2:          { x: 430, y: 150, w: 16, h: 16 },
  // Battle-phase towers (darker, weathered)
  tower_neutral_battle:    { x: 448, y: 150, w: 32, h: 32 },
  tower_home_p0_battle:    { x: 0,   y: 184, w: 48, h: 48 },
  tower_home_p1_battle:    { x: 50,  y: 184, w: 48, h: 48 },
  tower_home_p2_battle:    { x: 100, y: 184, w: 48, h: 48 },
  // Battle-phase debris (darker rubble)
  tower_debris_battle:     { x: 150, y: 184, w: 32, h: 32 },
  tower_debris_p0_battle:  { x: 184, y: 184, w: 32, h: 32 },
  tower_debris_p1_battle:  { x: 218, y: 184, w: 32, h: 32 },
  tower_debris_p2_battle:  { x: 252, y: 184, w: 32, h: 32 },
  // Terrain textures
  grass_dark:              { x: 286, y: 184, w: 16, h: 16 },
  grass_light:             { x: 304, y: 184, w: 16, h: 16 },
  grass_battle:            { x: 322, y: 184, w: 16, h: 16 },
  water:                   { x: 340, y: 184, w: 16, h: 16 },
  bank:                    { x: 358, y: 184, w: 16, h: 16 },
};
let atlas: HTMLImageElement | null = null;
/** Load the sprite sheet. Resolves when the image is decoded and ready. */
// @ts-ignore — import.meta.env is Vite-specific
const BASE = import.meta.env?.BASE_URL ?? "/";

export function loadAtlas(src = `${BASE}assets/sprites.png`): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      atlas = img;
      resolve();
    };
    img.onerror = () => reject(new Error(`Failed to load sprite atlas: ${src}`));
    img.src = src;
  });
}
/**
 * Draw a named sprite onto a canvas context at (dx, dy) in pixel coordinates.
 * Returns false if the atlas isn't loaded or the sprite name is unknown
 * (caller should fall back to procedural drawing).
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  name: string,
  dx: number,
  dy: number,
): boolean {
  if (!atlas) return false;
  const rect = SPRITES[name];
  if (!rect) return false;
  ctx.drawImage(atlas, rect.x, rect.y, rect.w, rect.h, dx, dy, rect.w, rect.h);
  return true;
}
/**
 * Draw a named sprite centered on (cx, cy).
 * Useful for entities that are positioned by their center (towers, cannons).
 */
export function drawSpriteCentered(
  ctx: CanvasRenderingContext2D,
  name: string,
  cx: number,
  cy: number,
): boolean {
  if (!atlas) return false;
  const rect = SPRITES[name];
  if (!rect) return false;
  ctx.drawImage(
    atlas,
    rect.x, rect.y, rect.w, rect.h,
    cx - rect.w / 2, cy - rect.h / 2, rect.w, rect.h,
  );
  return true;
}
