/**
 * Shared UI theme constants for all rendering modules.
 */

import { IS_TOUCH_DEVICE } from "../platform/platform.ts";

/** RGB color tuple. */
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
// UI button/cursor flash
export const BUTTON_FLASH_MS = 400;
export const CURSOR_BLINK_MS = 500;
export const REBIND_FLASH_MS = 350;
// Tower selection-bracket flash cycle (ms per half-cycle of sin pulse).
export const TOWER_FLASH_MS = 120;
// Life-lost dialog panel (used by both drawing and hit-testing)
export const LIFE_LOST_PANEL_W = IS_TOUCH_DEVICE ? 170 : 130;
export const LIFE_LOST_PANEL_H = IS_TOUCH_DEVICE ? 110 : 90;
export const LIFE_LOST_BTN_W = IS_TOUCH_DEVICE ? 68 : 52;
export const LIFE_LOST_BTN_H = IS_TOUCH_DEVICE ? 28 : 18;
// Lobby panel layout (height and vertical position as fractions of canvas height)
export const LOBBY_RECT_H_RATIO = 0.5;
export const LOBBY_RECT_H_RATIO_TOUCH = 0.6;
export const LOBBY_RECT_Y_RATIO = 0.27;
export const LOBBY_RECT_Y_RATIO_TOUCH = 0.18;
// Zoom button tinting
export const ZOOM_BUTTON_ALPHA = 0.85;
export const TOUCH_ZOOM_BG = `rgba(60, 80, 120, ${ZOOM_BUTTON_ALPHA})`;
/** Pure white — used for focused button text and primary overlay labels. */
export const TEXT_WHITE = "#fff";
/** Muted gold for status bar round/phase/timer text. */
export const STATUS_TEXT_COLOR = "#a08050";
/** Red heart color for lives display in status bar. */
export const LIVES_HEART_COLOR = "#c44";
// Canvas text alignment constants
export const TEXT_ALIGN_CENTER = "center" as const;
export const TEXT_ALIGN_LEFT = "left" as const;
export const TEXT_ALIGN_RIGHT = "right" as const;
export const TEXT_BASELINE_MIDDLE = "middle" as const;

/** Convert RGB tuple to CSS color string, with optional alpha. */
export function rgb(c: RGB, alpha?: number): string {
  if (alpha !== undefined) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Returns true on even half of a repeating blink cycle. */
export function flashOn(intervalMs: number, now: number): boolean {
  return Math.floor(now / intervalMs) % 2 === 0;
}

/** Draw text with a dark shadow offset by 1px. */
export function drawShadowText(
  overlayCtx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  shadowColor: string,
  textColor: string,
): void {
  overlayCtx.fillStyle = shadowColor;
  overlayCtx.fillText(text, x + 1, y + 1);
  overlayCtx.fillStyle = textColor;
  overlayCtx.fillText(text, x, y);
}
