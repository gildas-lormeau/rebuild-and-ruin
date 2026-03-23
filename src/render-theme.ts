/**
 * Shared UI theme constants for all rendering modules.
 */

/** RGB color tuple. */
export type RGB = [number, number, number];

/** Convert RGB tuple to CSS color string, with optional alpha. */
export function rgb(c: RGB, alpha?: number): string {
  if (alpha !== undefined) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------------------
// Panel backgrounds
// ---------------------------------------------------------------------------

/** Dark sepia panel background (0.85–0.95 alpha depending on context). */
export const PANEL_BG = (alpha: number) => `rgba(20, 12, 8, ${alpha})`;

// ---------------------------------------------------------------------------
// Accent colors
// ---------------------------------------------------------------------------

/** Gold accent — borders, separators, timer text. */
export const GOLD = "#c8a040";
/** Light gold — titles, important text. */
export const GOLD_LIGHT = "#f0d870";
/** Gold background with variable alpha — for highlighted rows/cells. */
export const GOLD_BG = (alpha: number) => `rgba(200, 160, 64, ${alpha})`;
/** Text shadow color for overlay text. */
export const SHADOW_COLOR = "rgba(0,0,0,0.6)";

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

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
