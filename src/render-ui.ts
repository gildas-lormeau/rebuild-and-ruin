/**
 * UI overlay rendering — announcement, banner, game over, player select.
 *
 * Time parameter convention: `now?: number` uses Date.now() scale (milliseconds
 * since epoch). Allows deterministic testing by injecting a fixed timestamp.
 * See render-effects.ts for the full convention documentation.
 */

import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  computeLobbyLayout,
  GAMEOVER_BTN_H,
  GAMEOVER_HEADER_H,
  GAMEOVER_ROW_H,
  gameOverLayout,
  lifeLostButtonLayout,
  SCOREBOARD_COL_RATIOS,
} from "./render-composition.ts";
import {
  BANNER_HEIGHT_RATIO,
  LIFE_LOST_BTN_H as BTN_H,
  LIFE_LOST_BTN_W as BTN_W,
  BUTTON_FLASH_MS,
  CURSOR_BLINK_MS,
  drawShadowText,
  FONT_ANNOUNCE,
  FONT_BODY,
  FONT_BUTTON,
  FONT_FLOAT_LG,
  FONT_FLOAT_MD,
  FONT_FLOAT_SM,
  FONT_FLOAT_XS,
  FONT_HEADING,
  FONT_HINT,
  FONT_ICON,
  FONT_LABEL,
  FONT_SMALL,
  FONT_STATUS,
  FONT_SUBTITLE,
  FONT_TIMER,
  FONT_TITLE,
  flashOn,
  GOLD,
  GOLD_BG,
  GOLD_LIGHT,
  GOLD_SUBTITLE,
  LIVES_HEART_COLOR,
  PANEL_BG,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_PANEL_W as PANEL_W,
  REBIND_FLASH_MS,
  rgb,
  SHADOW_COLOR,
  SHADOW_COLOR_DENSE,
  SHADOW_COLOR_HEAVY,
  STATUS_TEXT_COLOR,
  STATUSBAR_HEIGHT,
  TEXT_ALIGN_CENTER,
  TEXT_ALIGN_LEFT,
  TEXT_ALIGN_RIGHT,
  TEXT_BASELINE_MIDDLE,
  TEXT_WHITE,
} from "./render-theme.ts";
import {
  type ControlsPlayer,
  type GameOverOverlay,
  type RenderOverlay,
} from "./render-types.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
} from "./types.ts";

interface ButtonStyle {
  fill: string;
  stroke: string;
  lineWidth: number;
  font: string;
  textColor: string;
}

type ScoreEntry = GameOverOverlay["scores"][number];

/** Hit-test result for a tap/click on the options screen. */
type OptionsHit =
  | { type: typeof HIT_CLOSE }
  | { type: typeof HIT_ROW; index: number }
  | { type: typeof HIT_ARROW; index: number; dir: -1 | 1 }
  | null;

/** Hit-test result for a tap/click on the controls screen. */
type ControlsHit =
  | { type: typeof HIT_CLOSE }
  | { type: typeof HIT_CELL; playerIdx: number; actionIdx: number }
  | null;

// Local semantic colors (not shared across files — context-specific to UI panels)
const BTN_CONTINUE = {
  fill: (a: number) => `rgba(80,180,80,${a})`,
  stroke: "#8c8",
  strokeFocused: "#afa",
};
const BTN_ABANDON = {
  fill: (a: number) => `rgba(180,60,60,${a})`,
  stroke: "#c66",
  strokeFocused: "#f88",
};
const TEXT_DIM = "#666";
const TEXT_MUTED = "#888";
const TEXT_SOFT = "#aaa";
const TEXT_LIGHT = "#ccc";
const TEXT_FAINT = "#777";
const TEXT_DISABLED = "#999";
const ELIMINATED_RED = "#c44";
const BTN_MENU = {
  stroke: "#99c",
  strokeFocused: "#ccf",
};
// Layout spacing (pixels)
const PAD = 8;
const INSET = 10;
const INSET_X2 = 20;
// Panel background opacities
const BG_OPAQUE = 0.95;
const BG_OVERLAY = 0.9;
const BG_BANNER = 0.85;
// Fill/tint opacity scale (buttons, highlights, color alphas)
const OP_SECONDARY = 0.7;
const OP_VIVID = 0.6;
const OP_FOCUS = 0.5;
const OP_ACCENT = 0.4;
const OP_ACTIVE = 0.3;
const OP_IDLE = 0.2;
const OP_SUBTLE = 0.15;
const OP_GHOST = 0.1;
const HIT_ROW = "row" as const;
const HIT_CELL = "cell" as const;
// Options screen layout constants
const OPT_ROW_H = 28;
const CLOSE_BTN_SIZE = 24;
const CLOSE_BTN_MARGIN = 6;
/** Width of the tap target around each arrow indicator (◀ / ▶). */
const ARROW_TAP_W = 28;
// Options/controls hit-test discriminators
export const HIT_CLOSE = "close" as const;
export const HIT_ARROW = "arrow" as const;

/** Draw announcement text centered on screen. */
export function drawAnnouncement(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.announcement) return;
  const text = overlay.ui.announcement;
  overlayCtx.save();
  overlayCtx.font = FONT_ANNOUNCE;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  drawShadowText(
    overlayCtx,
    text,
    W / 2,
    H / 2,
    SHADOW_COLOR_HEAVY,
    TEXT_WHITE,
  );
  overlayCtx.restore();
}

/** Draw phase transition banner sweeping across the screen. */
export function drawBanner(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.banner) return;
  const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
  const by = Math.round(overlay.ui.banner.y - bannerH / 2);
  overlayCtx.fillStyle = PANEL_BG(BG_BANNER);
  overlayCtx.fillRect(0, by, W, bannerH);
  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillRect(0, by, W, 2);
  overlayCtx.fillRect(0, by + bannerH - 2, W, 2);
  overlayCtx.save();
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  const hasSubtitle = !!overlay.ui.banner.subtitle;
  const titleY = hasSubtitle ? by + bannerH * 0.38 : by + bannerH / 2;
  overlayCtx.font = FONT_TITLE;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  drawShadowText(
    overlayCtx,
    overlay.ui.banner.text,
    W / 2,
    titleY,
    SHADOW_COLOR,
    GOLD_LIGHT,
  );
  if (hasSubtitle) {
    overlayCtx.font = FONT_FLOAT_SM;
    overlayCtx.fillStyle = GOLD_SUBTITLE;
    overlayCtx.fillText(
      overlay.ui.banner.subtitle!,
      W / 2,
      by + bannerH * 0.72,
    );
  }
  overlayCtx.restore();
}

/** Draw score deltas floating over each player's territory. */
export function drawScoreDeltas(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.scoreDeltas?.length) return;
  const progress = overlay.ui.scoreDeltaProgress ?? 1;
  const linear = Math.min(1, progress / 0.8); // count up in first 80%, hold final value for last 20%
  const time = linear ** 3; // ease-in cubic: slow start, fast finish
  const fade = Math.min(1, progress / 0.15); // fade in over first 15%
  overlayCtx.save();
  overlayCtx.globalAlpha = fade;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  for (const delta of overlay.ui.scoreDeltas) {
    const shown = Math.round(delta.delta * time);
    const total = delta.total - delta.delta + shown;
    overlayCtx.font = FONT_FLOAT_LG;
    drawShadowText(
      overlayCtx,
      `+${shown}`,
      delta.cx,
      delta.cy - 6,
      SHADOW_COLOR_DENSE,
      TEXT_WHITE,
    );
    overlayCtx.font = FONT_FLOAT_MD;
    drawShadowText(
      overlayCtx,
      `${total}`,
      delta.cx,
      delta.cy + 8,
      SHADOW_COLOR,
      GOLD_LIGHT,
    );
  }
  overlayCtx.restore();
}

/** Draw status bar at the bottom of the canvas. */
export function drawStatusBar(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.statusBar) return;
  const sb = overlay.ui.statusBar;
  const barH = STATUSBAR_HEIGHT;
  const by = H - barH;

  overlayCtx.fillStyle = PANEL_BG(BG_OPAQUE);
  overlayCtx.fillRect(0, by, W, barH);
  overlayCtx.fillStyle = GOLD_BG(OP_ACCENT);
  overlayCtx.fillRect(0, by, W, 1);

  overlayCtx.save();
  overlayCtx.font = FONT_STATUS;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  const cy = by + barH / 2;

  // Left: round + phase + timer
  overlayCtx.textAlign = TEXT_ALIGN_LEFT;
  overlayCtx.fillStyle = STATUS_TEXT_COLOR;
  overlayCtx.fillText(`${sb.round}  ${sb.phase}  ${sb.timer}`, PAD, cy);

  // Right: player stats
  overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
  let rx = W - PAD;
  for (let i = sb.players.length - 1; i >= 0; i--) {
    const player = sb.players[i]!;
    if (player.eliminated) continue;
    const c = player.color;
    // Lives
    overlayCtx.fillStyle = LIVES_HEART_COLOR;
    const heartsStr = "\u2665".repeat(player.lives);
    overlayCtx.fillText(heartsStr, rx, cy);
    rx -= overlayCtx.measureText(heartsStr).width + 2;
    // Cannons
    overlayCtx.fillStyle = rgb(c, OP_VIVID);
    const cannonStr = `${player.cannons}c `;
    overlayCtx.fillText(cannonStr, rx, cy);
    rx -= overlayCtx.measureText(cannonStr).width;
    // Score
    overlayCtx.fillStyle = rgb(c);
    const scoreStr = `${player.score} `;
    overlayCtx.fillText(scoreStr, rx, cy);
    rx -= overlayCtx.measureText(scoreStr).width + 4;
  }
  overlayCtx.restore();
}

/** Draw the game over overlay with winner and scores. */
export function drawGameOver(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.gameOver) return;
  overlayCtx.save();
  const gameOverData = overlay.ui.gameOver;
  const sorted = [...gameOverData.scores].sort((a, b) => b.score - a.score);
  const hasStats = sorted.some((e) => e.stats);
  const lo = gameOverLayout(W, H, gameOverData.scores);
  const { panelW, panelH, px, py, btnW, btnY, rematchX, menuX } = lo;

  drawGameOverPanel(overlayCtx, W, px, py, panelW, panelH, gameOverData.winner);
  drawGameOverScores(overlayCtx, sorted, hasStats, px, py, panelW);
  drawGameOverButtons(
    overlayCtx,
    btnW,
    btnY,
    rematchX,
    menuX,
    gameOverData.focused,
  );
  overlayCtx.restore();
}

/** Draw life-lost continue/abandon dialogs (one per player). */
export function drawLifeLostDialog(
  overlayCtx: CanvasRenderingContext2D,
  _W: number,
  _H: number,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.ui?.lifeLostDialog) return;
  const dlg = overlay.ui.lifeLostDialog;

  for (const entry of dlg.entries) {
    const { px, py } = entry;
    const c = entry.color;
    const cx = px + PANEL_W / 2;

    // Panel background
    drawPanel(
      overlayCtx,
      px,
      py,
      PANEL_W,
      PANEL_H,
      PANEL_BG(BG_OVERLAY),
      rgb(c),
    );

    // Player name
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
    overlayCtx.font = FONT_BODY;
    overlayCtx.fillStyle = rgb(c);
    overlayCtx.fillText(entry.name, cx, py + 18);

    // Separator
    overlayCtx.fillStyle = GOLD;
    overlayCtx.fillRect(px + INSET, py + 28, PANEL_W - INSET_X2, 1);

    // Lives remaining
    overlayCtx.font = FONT_SMALL;
    if (entry.lives > 0) {
      overlayCtx.fillStyle = GOLD_LIGHT;
      overlayCtx.fillText(
        `${entry.lives} ${entry.lives === 1 ? "life" : "lives"} left`,
        cx,
        py + 40,
      );
    } else {
      overlayCtx.fillStyle = ELIMINATED_RED;
      overlayCtx.fillText("Eliminated", cx, py + 40);
    }

    drawLifeLostEntry(overlayCtx, entry, px, py, cx, now);
  }
}

/** Draw the player selection lobby screen. */
export function drawPlayerSelect(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.ui?.playerSelect) return;
  const selectData = overlay.ui.playerSelect;
  beginModalScreen(overlayCtx, W, H);

  overlayCtx.font = FONT_TITLE;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.fillText("Rebuild & Ruin", W / 2, H * 0.1);
  overlayCtx.font = FONT_SUBTITLE;
  overlayCtx.fillStyle = TEXT_MUTED;
  overlayCtx.fillText("A Rampart Remake", W / 2, H * 0.1 + 20);

  if (selectData.roomCode) {
    overlayCtx.font = FONT_TIMER;
    overlayCtx.fillStyle = GOLD;
    overlayCtx.fillText(`Room: ${selectData.roomCode}`, W / 2, H * 0.1 + 42);
  }

  const count = selectData.players.length;
  const { gap, rectW, rectH, rectY } = computeLobbyLayout(W, H, count);

  for (let i = 0; i < count; i++) {
    const player = selectData.players[i]!;
    const c = player.color;
    const rx = gap + i * (rectW + gap);

    drawPanel(overlayCtx, rx, rectY, rectW, rectH, rgb(c, OP_SUBTLE), rgb(c));

    const cx = rx + rectW / 2;
    const touch = IS_TOUCH_DEVICE;
    overlayCtx.font = touch ? FONT_HEADING : FONT_BODY;
    overlayCtx.fillStyle = rgb(c);
    overlayCtx.fillText(player.name, cx, rectY + (touch ? 34 : 30));
    const btnW = rectW - (touch ? 12 : 16);
    const btnH = touch ? 36 : 24;
    const btnX = rx + (touch ? 6 : 8);
    const btnY = rectY + rectH - btnH - (touch ? 8 : 12);

    if (player.joined) {
      drawButton(
        overlayCtx,
        btnX,
        btnY,
        btnW,
        btnH,
        {
          fill: rgb(c, OP_ACTIVE),
          stroke: rgb(c),
          lineWidth: 1,
          font: touch ? FONT_BODY : FONT_BUTTON,
          textColor: TEXT_WHITE,
        },
        "Please wait...",
      );
    } else {
      const flash = flashOn(CURSOR_BLINK_MS, now ?? Date.now());
      drawButton(
        overlayCtx,
        btnX,
        btnY,
        btnW,
        btnH,
        {
          fill: rgb(c, flash ? OP_FOCUS : OP_IDLE),
          stroke: rgb(c),
          lineWidth: 1,
          font: touch ? FONT_LABEL : FONT_HINT,
          textColor: flash ? TEXT_WHITE : TEXT_SOFT,
        },
        touch ? "Tap to join" : "Press button to start",
      );
    }

    if (!touch) {
      overlayCtx.font = FONT_HINT;
      overlayCtx.fillStyle = TEXT_DIM;
      overlayCtx.fillText(player.keyHint ?? "", cx, btnY - PAD);
    }
  }

  const secs = Math.ceil(selectData.timer);
  overlayCtx.font = FONT_TIMER;
  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillText(`Starting in ${secs}s`, W / 2, H * 0.88);

  // Gear button + F1 hint (top-right corner)
  overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  overlayCtx.font = FONT_ICON;
  overlayCtx.fillStyle = TEXT_MUTED;
  overlayCtx.fillText("\u2699", W - 6, 18);
  overlayCtx.font = FONT_HINT;
  overlayCtx.fillStyle = TEXT_DIM;
  overlayCtx.fillText("F1", W - 30, 18);
}

/** Hit-test the options screen. Coordinates in tile-pixel space (W×H). */
export function optionsScreenHitTest(
  x: number,
  y: number,
  W: number,
  H: number,
  optionCount: number,
): OptionsHit {
  const { panelW, px, startY, optH, closeX, closeY, closeSize } =
    optionsScreenLayout(W, H, optionCount);

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
  now?: number,
): void {
  if (!overlay?.ui?.optionsScreen) return;
  const opts = overlay.ui.optionsScreen;
  beginModalScreen(overlayCtx, W, H);

  const { panelW, px, startY, optH, closeX, closeY, closeSize } =
    optionsScreenLayout(W, H, opts.options.length);

  overlayCtx.font = FONT_TITLE;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.fillText("OPTIONS", W / 2, H * 0.12);

  // Close button (✕)
  overlayCtx.fillStyle = GOLD_BG(OP_IDLE);
  overlayCtx.fillRect(closeX, closeY, closeSize, closeSize);
  overlayCtx.strokeStyle = GOLD;
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(closeX, closeY, closeSize, closeSize);
  overlayCtx.font = FONT_BODY;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.fillText("\u2715", closeX + closeSize / 2, closeY + closeSize / 2);

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
      const time = now ?? Date.now();
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
      (showCursor
        ? flashOn(CURSOR_BLINK_MS, now ?? Date.now())
          ? "_"
          : " "
        : "");
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
  } = controlsScreenLayout(W, H, colCount, rowCount);

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
    for (let pi = 0; pi < colCount; pi++) {
      const cellX = tableX + labelColW + pi * playerColW + PAD / 2;
      const cellW = playerColW - PAD;
      if (x >= cellX && x <= cellX + cellW) {
        return { type: HIT_CELL, playerIdx: pi, actionIdx: a };
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
  now?: number,
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
  } = controlsScreenLayout(W, H, colCount, rowCount);

  // Close button (✕)
  overlayCtx.fillStyle = GOLD_BG(OP_IDLE);
  overlayCtx.fillRect(closeX, closeY, closeSize, closeSize);
  overlayCtx.strokeStyle = GOLD;
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(closeX, closeY, closeSize, closeSize);
  overlayCtx.font = FONT_BODY;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.fillText("\u2715", closeX + closeSize / 2, closeY + closeSize / 2);

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
  optionCount: number,
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
  rowCount: number,
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

/** Draw the game-over panel background, winner heading and separator line. */
function drawGameOverPanel(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  px: number,
  py: number,
  panelW: number,
  panelH: number,
  winner: string,
): void {
  drawPanel(overlayCtx, px, py, panelW, panelH, PANEL_BG(BG_OVERLAY), GOLD);

  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.font = FONT_HEADING;
  drawShadowText(
    overlayCtx,
    `${winner} wins!`,
    W / 2,
    py + 20,
    SHADOW_COLOR,
    GOLD_LIGHT,
  );
  overlayCtx.fillStyle = GOLD;
  overlayCtx.fillRect(px + INSET, py + 32, panelW - INSET_X2, 1);
}

/** Draw score column headers and per-player score rows. */
function drawGameOverScores(
  overlayCtx: CanvasRenderingContext2D,
  sorted: readonly ScoreEntry[],
  hasStats: boolean,
  px: number,
  py: number,
  panelW: number,
): void {
  const statsH = hasStats ? GAMEOVER_ROW_H : 0;
  const tableTop = py + GAMEOVER_HEADER_H;
  const colName = px + INSET;
  const colScore = px + panelW * SCOREBOARD_COL_RATIOS[0];
  const colWalls = px + panelW * SCOREBOARD_COL_RATIOS[1];
  const colCannons = px + panelW * SCOREBOARD_COL_RATIOS[2];
  const colTerritory = px + panelW * SCOREBOARD_COL_RATIOS[3];

  if (hasStats) {
    overlayCtx.font = FONT_FLOAT_XS;
    overlayCtx.fillStyle = TEXT_MUTED;
    overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
    overlayCtx.fillText("Score", colScore, tableTop + PAD);
    overlayCtx.fillText("Walls", colWalls, tableTop + PAD);
    overlayCtx.fillText("Cannons", colCannons, tableTop + PAD);
    overlayCtx.fillText("Land", colTerritory, tableTop + PAD);
  }

  overlayCtx.font = FONT_LABEL;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const y = tableTop + statsH + INSET + i * GAMEOVER_ROW_H;
    const c = entry.color;
    const alpha = entry.eliminated ? OP_ACCENT : 1;
    overlayCtx.fillStyle = rgb(c, alpha);
    overlayCtx.textAlign = TEXT_ALIGN_LEFT;
    overlayCtx.fillText(entry.name, colName, y);
    overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
    overlayCtx.fillText(`${entry.score}`, colScore, y);
    if (entry.stats) {
      overlayCtx.fillStyle = rgb(c, alpha * OP_SECONDARY);
      overlayCtx.fillText(`${entry.stats.wallsDestroyed}`, colWalls, y);
      overlayCtx.fillText(`${entry.stats.cannonsKilled}`, colCannons, y);
      overlayCtx.fillText(`${entry.territory ?? 0}`, colTerritory, y);
    }
  }
}

/** Draw the rematch and menu buttons at the bottom of the game-over panel. */
function drawGameOverButtons(
  overlayCtx: CanvasRenderingContext2D,
  btnW: number,
  btnY: number,
  rematchX: number,
  menuX: number,
  focused: GameOverOverlay["focused"],
): void {
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;

  const rematchFocused = focused === FOCUS_REMATCH;
  drawButton(
    overlayCtx,
    rematchX,
    btnY,
    btnW,
    GAMEOVER_BTN_H,
    {
      fill: BTN_CONTINUE.fill(rematchFocused ? OP_FOCUS : OP_IDLE),
      stroke: rematchFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
      lineWidth: rematchFocused ? 2 : 1,
      font: FONT_BUTTON,
      textColor: rematchFocused ? TEXT_WHITE : TEXT_LIGHT,
    },
    "Rematch",
  );

  const menuFocused = focused === FOCUS_MENU;
  drawButton(
    overlayCtx,
    menuX,
    btnY,
    btnW,
    GAMEOVER_BTN_H,
    {
      fill: BTN_ABANDON.fill(menuFocused ? OP_FOCUS : OP_IDLE),
      stroke: menuFocused ? BTN_MENU.strokeFocused : BTN_MENU.stroke,
      lineWidth: menuFocused ? 2 : 1,
      font: FONT_BUTTON,
      textColor: menuFocused ? TEXT_WHITE : TEXT_LIGHT,
    },
    "Menu",
  );
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
  now?: number,
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
  now?: number,
): void {
  const cy = oy + rowH / 2;
  if (isSelected && rebinding) {
    // Flashing "Press key..." cell
    const flash = flashOn(REBIND_FLASH_MS, now ?? Date.now());
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

/** Draw a single player's life-lost entry: choice buttons (pending) or resolved text. */
function drawLifeLostEntry(
  ctx: CanvasRenderingContext2D,
  entry: {
    readonly lives: number;
    readonly choice: LifeLostChoice;
    readonly focused: number;
    readonly px: number;
    readonly py: number;
  },
  px: number,
  py: number,
  cx: number,
  now?: number,
): void {
  if (entry.choice === LifeLostChoice.PENDING && entry.lives > 0) {
    // Continue / Abandon buttons with focus highlight
    const btnW = BTN_W;
    const btnH = BTN_H;
    const { btnY, contX, abX } = lifeLostButtonLayout(px, py);
    const contFocused = entry.focused === LIFE_LOST_FOCUS_CONTINUE;
    const abFocused = entry.focused === LIFE_LOST_FOCUS_ABANDON;

    // Continue button
    const time = now ?? Date.now();
    const contFlash = contFocused && flashOn(BUTTON_FLASH_MS, time);
    drawButton(
      ctx,
      contX,
      btnY,
      btnW,
      btnH,
      {
        fill: BTN_CONTINUE.fill(
          contFocused ? (contFlash ? OP_VIVID : OP_ACCENT) : OP_SUBTLE,
        ),
        stroke: contFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
        lineWidth: contFocused ? 2 : 1,
        font: FONT_BUTTON,
        textColor: contFocused ? TEXT_WHITE : TEXT_DISABLED,
      },
      "Continue",
    );

    // Abandon button
    const abFlash = abFocused && flashOn(BUTTON_FLASH_MS, time);
    drawButton(
      ctx,
      abX,
      btnY,
      btnW,
      btnH,
      {
        fill: BTN_ABANDON.fill(
          abFocused ? (abFlash ? OP_FOCUS : OP_ACTIVE) : OP_GHOST,
        ),
        stroke: abFocused ? BTN_ABANDON.strokeFocused : BTN_ABANDON.stroke,
        lineWidth: abFocused ? 2 : 1,
        font: FONT_BUTTON,
        textColor: abFocused ? TEXT_WHITE : TEXT_FAINT,
      },
      "Abandon",
    );
  } else {
    // Resolved state
    ctx.font = FONT_LABEL;
    const isContinue = entry.choice === LifeLostChoice.CONTINUE;
    ctx.fillStyle = isContinue ? BTN_CONTINUE.stroke : BTN_ABANDON.stroke;
    if (entry.lives > 0) {
      ctx.fillText(
        isContinue ? "Continuing..." : "Abandoned",
        cx,
        py + PANEL_H - 18,
      );
    }
  }
}

/** Draw a panel: filled rect + inset border stroke. */
function drawPanel(
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
function drawButton(
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
function beginModalScreen(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  overlayCtx.fillStyle = PANEL_BG(BG_OPAQUE);
  overlayCtx.fillRect(0, 0, W, H);
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
}
