/**
 * Shared UI theme constants for all rendering modules.
 */

import type { RGB } from "./geometry-types.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";

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
/** Heavier shadow for centered announcements over the game area. */
export const SHADOW_COLOR_HEAVY = "rgba(0,0,0,0.7)";
/** Heaviest shadow for small floating text that needs maximum contrast. */
export const SHADOW_COLOR_DENSE = "rgba(0,0,0,0.8)";
/** Muted gold for banner subtitles. */
export const GOLD_SUBTITLE = "#c8a860";
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
// Layout constants shared across render modules
export const BANNER_HEIGHT_RATIO = 0.15;
export const STATUSBAR_HEIGHT = 32;
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
// Zoom button tinting
export const ZOOM_BUTTON_ALPHA = 0.85;
export const TOUCH_ZOOM_HOME_BG = `rgba(60, 80, 120, ${ZOOM_BUTTON_ALPHA})`;
export const TOUCH_ZOOM_ENEMY_BG = `rgba(100, 50, 50, ${ZOOM_BUTTON_ALPHA})`;
/** Loupe corner radius in CSS pixels (scaled by DPR internally). */
export const LOUPE_RADIUS = 12;
/** Loupe magnification factor relative to the scene canvas. */
export const LOUPE_ZOOM = 2;
/** Loupe stone border width in canvas pixels. */
export const LOUPE_BORDER_WIDTH = 6;
/** Loupe rivet (corner stud) radius in canvas pixels. */
export const LOUPE_RIVET_RADIUS = 5;
/** Loupe stone border color. */
export const LOUPE_STONE_COLOR = "rgba(50, 40, 30, 0.92)";
/** Loupe inner border accent color. */
export const LOUPE_STONE_LIGHT = "rgba(90, 75, 55, 0.8)";
/** Loupe rivet color. */
export const LOUPE_RIVET_COLOR = "#c8a040";
/** Loupe rivet highlight (subtle gold shine). */
export const LOUPE_RIVET_HIGHLIGHT = "rgba(255, 240, 180, 0.6)";
/** Loupe crosshair stroke color. */
export const LOUPE_CROSSHAIR_COLOR = "rgba(255, 255, 255, 0.5)";
/** Loupe crosshair center dot color. */
export const LOUPE_CROSSHAIR_DOT = "rgba(255, 255, 255, 0.7)";
/** Pure white — used for focused button text and primary overlay labels. */
export const TEXT_WHITE = "#fff";
/** Muted gold for status bar round/phase/timer text. */
export const STATUS_TEXT_COLOR = "#a08050";
/** Red heart color for lives display in status bar. */
export const LIVES_HEART_COLOR = "#c44";

/** Convert RGB tuple to CSS color string, with optional alpha. */
export function rgb(c: RGB, alpha?: number): string {
  if (alpha !== undefined) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Returns true on even half of a repeating blink cycle. */
export function flashOn(intervalMs: number, now: number): boolean {
  return Math.floor(now / intervalMs) % 2 === 0;
}

/** Set text alignment to centered (both horizontal and vertical). */
export function setCenterText(ctx: CanvasRenderingContext2D): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
}

/** Draw text with a dark shadow offset by 1px. */
export function drawShadowText(
  octx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  shadowColor: string,
  textColor: string,
): void {
  octx.fillStyle = shadowColor;
  octx.fillText(text, x + 1, y + 1);
  octx.fillStyle = textColor;
  octx.fillText(text, x, y);
}
