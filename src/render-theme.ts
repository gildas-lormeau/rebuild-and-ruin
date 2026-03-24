/**
 * Shared UI theme constants for all rendering modules.
 */

/** RGB color tuple. */

// Gear button position (tile-space, top-right corner)

import { GRID_COLS, TILE_SIZE } from "./grid.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";

export type RGB = [number, number, number];

/** Dark sepia panel background (0.85–0.95 alpha depending on context). */
export const PANEL_BG = (alpha: number) => `rgba(20, 12, 8, ${alpha})`;
/** Gold accent — borders, separators, timer text. */
export const GOLD = "#c8a040";
/** Light gold — titles, important text. */
export const GOLD_LIGHT = "#f0d870";
/** Gold background with variable alpha — for highlighted rows/cells. */
export const GOLD_BG = (alpha: number) => `rgba(200, 160, 64, ${alpha})`;
/** Text shadow color for overlay text. */
export const SHADOW_COLOR = "rgba(0,0,0,0.6)";
export const FONT_ANNOUNCE = "bold 24px monospace";
export const FONT_TITLE = "bold 20px monospace";
export const FONT_HEADING = "bold 16px monospace";
export const FONT_STATUS = "bold 15px monospace";
export const FONT_SUBTITLE = "12px monospace";
export const FONT_BODY = "bold 14px monospace";
export const FONT_LABEL = "bold 12px monospace";
export const FONT_SMALL = "bold 11px monospace";
export const FONT_BUTTON = "bold 10px monospace";
export const FONT_HINT = "9px monospace";
export const FONT_TIMER = "bold 14px monospace";
export const FONT_ICON = "28px monospace";
// Sans-serif variants — used for in-world floating text (more legible at small sizes)
export const FONT_FLOAT_LG = "bold 14px sans-serif";
export const FONT_FLOAT_MD = "bold 12px sans-serif";
export const FONT_FLOAT_SM = "bold 11px sans-serif";
export const FONT_FLOAT_XS = "bold 7px sans-serif";
// In-world effect timings
export const BONUS_FLASH_MS = 300;
export const TOWER_FLASH_MS = 120;
// Crosshair animation
export const CROSSHAIR_READY_FREQ = 16;
export const CROSSHAIR_IDLE_FREQ = 4;
export const CROSSHAIR_ARM_READY = 14;
export const CROSSHAIR_ARM_IDLE = 10;
export const CROSSHAIR_ARM_PULSE = 3;
// UI button/cursor flash
export const BUTTON_FLASH_MS = 400;
export const CURSOR_BLINK_MS = 500;
export const REBIND_FLASH_MS = 350;
// Life-lost dialog panel (used by both drawing and hit-testing)
export const LIFE_LOST_PANEL_W = IS_TOUCH_DEVICE ? 170 : 130;
export const LIFE_LOST_PANEL_H = IS_TOUCH_DEVICE ? 110 : 90;
export const LIFE_LOST_BTN_W = IS_TOUCH_DEVICE ? 68 : 52;
export const LIFE_LOST_BTN_H = IS_TOUCH_DEVICE ? 28 : 18;
export const GEAR_X = GRID_COLS * TILE_SIZE - 32;
export const GEAR_Y = 4;
export const GEAR_SIZE = 28;
export const TOUCH_ARROW_BG = "rgba(80, 90, 110, 0.8)";
export const TOUCH_ARROW_BORDER = "rgba(140, 160, 190, 0.7)";
export const TOUCH_ROTATE_BG = "rgba(200, 160, 64, 0.85)";
export const TOUCH_ROTATE_BORDER = "rgba(240, 216, 112, 0.9)";
export const TOUCH_ACTION_BG = "rgba(60, 160, 80, 0.85)";
export const TOUCH_ACTION_BORDER = "rgba(100, 220, 120, 0.9)";
export const TOUCH_QUIT_BG = "rgba(80, 40, 40, 0.7)";
export const TOUCH_QUIT_BORDER = "rgba(180, 80, 80, 0.7)";
export const TOUCH_ZOOM_HOME_BG = "rgba(60, 80, 120, 0.85)";
export const TOUCH_ZOOM_HOME_BORDER = "rgba(100, 140, 200, 0.7)";
export const TOUCH_ZOOM_ENEMY_BG = "rgba(100, 50, 50, 0.85)";
export const TOUCH_ZOOM_ENEMY_BORDER = "rgba(180, 80, 80, 0.7)";
/** Loupe (magnifying glass) diameter in canvas pixels. */
export const LOUPE_DIAMETER = 520;
/** Loupe offset from finger in canvas pixels (used for the main axis). */
export const LOUPE_OFFSET = 300;
/** Loupe magnification factor relative to the scene canvas. */
export const LOUPE_ZOOM = 4;
/** Loupe border width in canvas pixels. */
export const LOUPE_BORDER_WIDTH = 3;
/** Loupe outer border color. */
export const LOUPE_BORDER_COLOR = "rgba(40, 30, 20, 0.9)";
/** Loupe inner accent ring color. */
export const LOUPE_ACCENT_COLOR = "rgba(200, 160, 64, 0.6)";

/** Convert RGB tuple to CSS color string, with optional alpha. */
export function rgb(c: RGB, alpha?: number): string {
  if (alpha !== undefined) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
