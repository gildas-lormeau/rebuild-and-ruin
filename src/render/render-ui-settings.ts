/**
 * Options and controls screen rendering + hit-testing.
 *
 * Extracted from render-ui.ts — these modal screens have their own
 * hit-test logic consumed by runtime-options.ts.
 */

import type {
  ControlsPlayer,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import { HIT_ARROW, HIT_CLOSE } from "../shared/ui/settings-defs.ts";
import {
  BUTTON_FLASH_MS,
  CURSOR_BLINK_MS,
  FONT_BODY,
  FONT_HINT,
  FONT_LABEL,
  FONT_SMALL,
  FONT_TITLE,
  flashOn,
  GOLD,
  GOLD_BG,
  GOLD_LIGHT,
  REBIND_FLASH_MS,
  rgb,
  TEXT_ALIGN_CENTER,
  TEXT_ALIGN_LEFT,
  TEXT_ALIGN_RIGHT,
  TEXT_WHITE,
} from "../shared/ui/theme.ts";
import type { ControlsHit, OptionsHit } from "../shared/ui/ui-contracts.ts";
import {
  beginModalScreen,
  INSET,
  INSET_X2,
  OP_ACTIVE,
  OP_GHOST,
  OP_IDLE,
  OP_SECONDARY,
  OP_SUBTLE,
  PAD,
  TEXT_DIM,
  TEXT_DISABLED,
  TEXT_MUTED,
} from "./render-ui-theme.ts";

const HIT_ROW = "row";
const HIT_CELL = "cell";
// Options screen layout constants
const OPT_ROW_H = 28;
const CLOSE_BTN_SIZE = 24;
const CLOSE_BTN_MARGIN = 6;
/** Width of the tap target around each arrow indicator (◀ / ▶). */
const ARROW_TAP_W = 28;

/** Hit-test the options screen. Coordinates in tile-pixel space (W×H). */
export function optionsScreenHitTest(
  x: number,
  y: number,
  W: number,
  H: number,
  optionCount: number,
): OptionsHit {
  const { panelW, px, startY, optH, closeX, closeY, closeSize } =
    optionsScreenLayout(W, H);

  // Close button
  if (
    x >= closeX &&
    x <= closeX + closeSize &&
    y >= closeY &&
    y <= closeY + closeSize
  ) {
    return { type: HIT_CLOSE };
  }

  // Option rows
  for (let i = 0; i < optionCount; i++) {
    const oy = startY + i * optH;
    if (x >= px && x <= px + panelW && y >= oy && y <= oy + optH) {
      // Left arrow area (◀)
      if (x < px + ARROW_TAP_W) return { type: HIT_ARROW, index: i, dir: -1 };
      // Right arrow area (▶)
      if (x > px + panelW - ARROW_TAP_W)
        return { type: HIT_ARROW, index: i, dir: 1 };
      // Row body — select only, no value change
      return { type: HIT_ROW, index: i };
    }
  }

  return null;
}

/** Draw the options screen. */
export function drawOptionsScreen(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.ui?.optionsScreen) return;
  const opts = overlay.ui.optionsScreen;
  beginModalScreen(overlayCtx, W, H);

  const { panelW, px, startY, optH, closeX, closeY, closeSize } =
    optionsScreenLayout(W, H);

  overlayCtx.font = FONT_TITLE;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.fillText("OPTIONS", W / 2, H * 0.12);

  drawCloseButton(overlayCtx, closeX, closeY, closeSize);

  for (let i = 0; i < opts.options.length; i++) {
    const opt = opts.options[i]!;
    const oy = startY + i * optH;
    const selected = i === opts.cursor;

    // Row background
    if (selected) {
      overlayCtx.fillStyle = GOLD_BG(OP_SUBTLE);
      overlayCtx.fillRect(px, oy, panelW, optH - 2);
    }

    // Arrow indicators for selected editable row
    if (selected && opt.editable) {
      const time = now;
      const flash = flashOn(BUTTON_FLASH_MS, time);
      overlayCtx.font = FONT_BODY;
      overlayCtx.fillStyle = flash ? GOLD_LIGHT : GOLD;
      overlayCtx.textAlign = TEXT_ALIGN_LEFT;
      overlayCtx.fillText("\u25C0", px + PAD / 2, oy + optH / 2);
      overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
      overlayCtx.fillText("\u25B6", px + panelW - PAD / 2, oy + optH / 2);
    }

    // Option name (left-aligned)
    overlayCtx.textAlign = TEXT_ALIGN_LEFT;
    overlayCtx.font = selected ? FONT_BODY : FONT_LABEL;
    overlayCtx.fillStyle = selected
      ? opt.editable
        ? TEXT_WHITE
        : TEXT_DISABLED
      : TEXT_MUTED;
    overlayCtx.fillText(opt.name, px + INSET_X2, oy + optH / 2);

    // Option value (right-aligned) — with blinking cursor for seed input
    overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
    overlayCtx.fillStyle = selected
      ? opt.editable
        ? GOLD_LIGHT
        : TEXT_DISABLED
      : GOLD;
    const showCursor =
      selected &&
      opt.editable &&
      opt.name === "Seed" &&
      opt.value !== "Random" &&
      !opts.readOnly;
    const displayValue =
      opt.value +
      (showCursor ? (flashOn(CURSOR_BLINK_MS, now) ? "_" : " ") : "");
    overlayCtx.fillText(displayValue, px + panelW - INSET_X2, oy + optH / 2);
  }

  // Separator
  const sepY = startY + opts.options.length * optH + PAD;
  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillRect(px + INSET, sepY, panelW - INSET_X2, 1);

  // Context-sensitive hint
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.font = FONT_HINT;
  overlayCtx.fillStyle = TEXT_DIM;
  const selOpt = opts.options[opts.cursor];
  let hint: string;
  if (opts.readOnly) {
    hint = "Game paused  |  ESC to resume";
  } else if (selOpt?.name === "Seed") {
    hint = "Type digits to set seed  |  Delete to clear  |  ESC to go back";
  } else {
    hint =
      "ESC to go back  |  \u2190 \u2192 to change value  |  Enter to select";
  }
  overlayCtx.fillText(hint, W / 2, H * 0.85);
}

/** Hit-test the controls screen. Coordinates in tile-pixel space (W×H). */
export function controlsScreenHitTest(
  x: number,
  y: number,
  W: number,
  H: number,
  colCount: number,
  rowCount: number,
): ControlsHit {
  const {
    tableX,
    labelColW,
    playerColW,
    startY,
    rowH,
    closeX,
    closeY,
    closeSize,
  } = controlsScreenLayout(W, H, colCount);

  // Close button
  if (
    x >= closeX &&
    x <= closeX + closeSize &&
    y >= closeY &&
    y <= closeY + closeSize
  ) {
    return { type: HIT_CLOSE };
  }

  // Key cells
  for (let a = 0; a < rowCount; a++) {
    const oy = startY + a * rowH;
    if (y < oy || y > oy + rowH) continue;
    for (let playerIdx = 0; playerIdx < colCount; playerIdx++) {
      const cellX = tableX + labelColW + playerIdx * playerColW + PAD / 2;
      const cellW = playerColW - PAD;
      if (x >= cellX && x <= cellX + cellW) {
        return { type: HIT_CELL, playerIdx, actionIdx: a };
      }
    }
  }

  return null;
}

/** Draw the controls rebinding screen. */
export function drawControlsScreen(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.ui?.controlsScreen) return;
  const ctrl = overlay.ui.controlsScreen;
  beginModalScreen(overlayCtx, W, H);

  // Layout
  const colCount = ctrl.players.length;
  const rowCount = ctrl.actionNames.length;
  const {
    tableW,
    tableX,
    labelColW,
    playerColW,
    headerY,
    startY,
    rowH,
    closeX,
    closeY,
    closeSize,
  } = controlsScreenLayout(W, H, colCount);

  drawCloseButton(overlayCtx, closeX, closeY, closeSize);

  drawControlsHeader(
    overlayCtx,
    W,
    H,
    ctrl.players,
    tableX,
    tableW,
    labelColW,
    playerColW,
    headerY,
  );
  drawControlsTable(
    overlayCtx,
    W,
    H,
    ctrl.players,
    ctrl.actionNames,
    ctrl.playerIdx,
    ctrl.actionIdx,
    ctrl.rebinding,
    tableX,
    tableW,
    labelColW,
    playerColW,
    startY,
    rowH,
    rowCount,
    now,
  );
}

/** Compute options screen geometry (shared by renderer and hit-test). */
function optionsScreenLayout(
  W: number,
  H: number,
): {
  panelW: number;
  px: number;
  startY: number;
  optH: number;
  closeX: number;
  closeY: number;
  closeSize: number;
} {
  const panelW = Math.round(W * 0.65);
  const px = Math.round((W - panelW) / 2);
  const startY = Math.round(H * 0.28);
  return {
    panelW,
    px,
    startY,
    optH: OPT_ROW_H,
    closeX: px + panelW - CLOSE_BTN_SIZE - CLOSE_BTN_MARGIN,
    closeY: Math.round(H * 0.12) - CLOSE_BTN_SIZE / 2 - 2,
    closeSize: CLOSE_BTN_SIZE,
  };
}

/** Compute controls screen geometry (shared by renderer and hit-test). */
function controlsScreenLayout(
  W: number,
  H: number,
  colCount: number,
): {
  tableW: number;
  tableX: number;
  labelColW: number;
  playerColW: number;
  headerY: number;
  startY: number;
  rowH: number;
  closeX: number;
  closeY: number;
  closeSize: number;
} {
  const tableW = Math.round(W * 0.8);
  const labelColW = Math.round(tableW * 0.2);
  const playerColW = Math.round((tableW - labelColW) / colCount);
  const tableX = Math.round((W - tableW) / 2);
  const headerY = Math.round(H * 0.2);
  return {
    tableW,
    tableX,
    labelColW,
    playerColW,
    headerY,
    startY: headerY + 28,
    rowH: 22,
    closeX: tableX + tableW - CLOSE_BTN_SIZE - CLOSE_BTN_MARGIN,
    closeY: Math.round(H * 0.1) - CLOSE_BTN_SIZE / 2 - 2,
    closeSize: CLOSE_BTN_SIZE,
  };
}

/** Draw the controls screen title, player name columns and header separator. */
function drawControlsHeader(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  players: readonly ControlsPlayer[],
  tableX: number,
  tableW: number,
  labelColW: number,
  playerColW: number,
  headerY: number,
): void {
  overlayCtx.font = FONT_TITLE;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.fillText("CONTROLS", W / 2, H * 0.1);

  for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
    const player = players[playerIndex]!;
    const c = player.color;
    const cx = tableX + labelColW + playerIndex * playerColW + playerColW / 2;
    overlayCtx.font = FONT_BODY;
    overlayCtx.fillStyle = rgb(c);
    overlayCtx.fillText(player.name, cx, headerY);
  }

  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillRect(tableX + PAD, headerY + 12, tableW - PAD * 2, 1);
}

/** Draw the action rows (labels + key cells) and bottom separator/hint. */
function drawControlsTable(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  players: readonly ControlsPlayer[],
  actionNames: readonly string[],
  selectedPlayerIdx: number,
  selectedActionIdx: number,
  rebinding: boolean,
  tableX: number,
  tableW: number,
  labelColW: number,
  playerColW: number,
  startY: number,
  rowH: number,
  rowCount: number,
  now: number = performance.now(),
): void {
  for (let a = 0; a < rowCount; a++) {
    const oy = startY + a * rowH;

    overlayCtx.textAlign = TEXT_ALIGN_LEFT;
    overlayCtx.font = FONT_LABEL;
    overlayCtx.fillStyle = TEXT_MUTED;
    overlayCtx.fillText(actionNames[a]!, tableX + PAD, oy + rowH / 2);

    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      const player = players[playerIndex]!;
      const cx = tableX + labelColW + playerIndex * playerColW + playerColW / 2;
      const cellX = tableX + labelColW + playerIndex * playerColW + PAD / 2;
      const cellW = playerColW - PAD;
      const isSelected =
        playerIndex === selectedPlayerIdx && a === selectedActionIdx;
      drawControlsKeyCell(
        overlayCtx,
        player,
        a,
        isSelected,
        rebinding,
        cellX,
        cellW,
        cx,
        oy,
        rowH,
        now,
      );
    }
  }

  const sepY = startY + rowCount * rowH + PAD;
  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillRect(tableX + INSET, sepY, tableW - INSET_X2, 1);

  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.font = FONT_HINT;
  overlayCtx.fillStyle = TEXT_DIM;
  overlayCtx.fillText(
    "\u2190 \u2192 switch player  |  \u2191 \u2193 select action  |  Enter to rebind  |  ESC to go back",
    W / 2,
    H * 0.88,
  );
}

/** Draw the close button (✕) shared by options and controls screens. */
function drawCloseButton(
  overlayCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  overlayCtx.fillStyle = GOLD_BG(OP_IDLE);
  overlayCtx.fillRect(x, y, size, size);
  overlayCtx.strokeStyle = GOLD;
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(x, y, size, size);
  overlayCtx.font = FONT_BODY;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.fillText("\u2715", x + size / 2, y + size / 2);
}

/** Draw a single key cell in the controls table.
 *  Three visual states: rebinding flash, selected highlight, or normal. */
function drawControlsKeyCell(
  overlayCtx: CanvasRenderingContext2D,
  player: ControlsPlayer,
  actionIdx: number,
  isSelected: boolean,
  rebinding: boolean,
  cellX: number,
  cellW: number,
  cx: number,
  oy: number,
  rowH: number,
  now: number = performance.now(),
): void {
  const cy = oy + rowH / 2;
  if (isSelected && rebinding) {
    // Flashing "Press key..." cell
    const flash = flashOn(REBIND_FLASH_MS, now);
    overlayCtx.fillStyle = flash ? GOLD_BG(OP_ACTIVE) : GOLD_BG(OP_GHOST);
    overlayCtx.fillRect(cellX, oy + 1, cellW, rowH - 2);
    overlayCtx.strokeStyle = GOLD_LIGHT;
    overlayCtx.lineWidth = 1;
    overlayCtx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.font = FONT_SMALL;
    overlayCtx.fillStyle = flash ? GOLD_LIGHT : GOLD;
    overlayCtx.fillText("Press key\u2026", cx, cy);
  } else if (isSelected) {
    // Highlighted selected cell
    overlayCtx.fillStyle = GOLD_BG(OP_IDLE);
    overlayCtx.fillRect(cellX, oy + 1, cellW, rowH - 2);
    overlayCtx.strokeStyle = GOLD;
    overlayCtx.lineWidth = 1;
    overlayCtx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.font = FONT_BODY;
    overlayCtx.fillStyle = TEXT_WHITE;
    overlayCtx.fillText(player.bindings[actionIdx]!, cx, cy);
  } else {
    // Normal unselected cell
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.font = FONT_LABEL;
    overlayCtx.fillStyle = rgb(player.color, OP_SECONDARY);
    overlayCtx.fillText(player.bindings[actionIdx]!, cx, cy);
  }
}
