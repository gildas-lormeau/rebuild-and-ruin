/**
 * Shared constants, types, and drawing primitives for render-ui*.ts files.
 */

import {
  PANEL_BG,
  TEXT_ALIGN_CENTER,
  TEXT_BASELINE_MIDDLE,
} from "./render-theme.ts";

interface ButtonStyle {
  fill: string;
  stroke: string;
  lineWidth: number;
  font: string;
  textColor: string;
}

// Panel background opacities
const BG_OPAQUE = 0.95;
// Layout spacing (pixels)
export const PAD = 8;
export const INSET = 10;
export const INSET_X2 = 20;
export const BG_OVERLAY = 0.9;
export const BG_BANNER = 0.85;
// Fill/tint opacity scale (buttons, highlights, color alphas)
export const OP_SECONDARY = 0.7;
export const OP_VIVID = 0.6;
export const OP_FOCUS = 0.5;
export const OP_ACCENT = 0.4;
export const OP_ACTIVE = 0.3;
export const OP_IDLE = 0.2;
export const OP_SUBTLE = 0.15;
export const OP_GHOST = 0.1;
// Local semantic colors (not shared across files — context-specific to UI panels)
export const BTN_CONTINUE = {
  fill: (a: number) => `rgba(80,180,80,${a})`,
  stroke: "#8c8",
  strokeFocused: "#afa",
};
export const BTN_ABANDON = {
  fill: (a: number) => `rgba(180,60,60,${a})`,
  stroke: "#c66",
  strokeFocused: "#f88",
};
export const TEXT_DIM = "#666";
export const TEXT_MUTED = "#888";
export const TEXT_SOFT = "#aaa";
export const TEXT_LIGHT = "#ccc";
export const TEXT_FAINT = "#777";
export const TEXT_DISABLED = "#999";
export const ELIMINATED_RED = "#c44";
export const BTN_MENU = {
  stroke: "#99c",
  strokeFocused: "#ccf",
};

/** Draw a panel: filled rect + inset border stroke. */
export function drawPanel(
  overlayCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
): void {
  overlayCtx.fillStyle = fill;
  overlayCtx.fillRect(x, y, w, h);
  overlayCtx.strokeStyle = stroke;
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** Draw a styled button: filled rect + border + centered label. */
export function drawButton(
  overlayCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  style: ButtonStyle,
  label: string,
): void {
  overlayCtx.fillStyle = style.fill;
  overlayCtx.fillRect(x, y, w, h);
  overlayCtx.strokeStyle = style.stroke;
  overlayCtx.lineWidth = style.lineWidth;
  overlayCtx.strokeRect(x, y, w, h);
  overlayCtx.font = style.font;
  overlayCtx.fillStyle = style.textColor;
  overlayCtx.fillText(label, x + w / 2, y + h / 2);
}

/** Fill a full-screen opaque panel and set up centered text drawing. */
export function beginModalScreen(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  overlayCtx.fillStyle = PANEL_BG(BG_OPAQUE);
  overlayCtx.fillRect(0, 0, W, H);
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
}
