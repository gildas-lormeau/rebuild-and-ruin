/**
 * UI overlay rendering — announcement, banner, game over, player select.
 */

import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  computeLobbyLayout,
  GAMEOVER_BTN_H,
  GAMEOVER_COL_RATIOS,
  GAMEOVER_HEADER_H,
  GAMEOVER_ROW_H,
  gameOverLayout,
  lifeLostButtonLayout,
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
import { type RenderOverlay } from "./render-types.ts";
import { FOCUS_MENU, FOCUS_REMATCH, LifeLostChoice } from "./types.ts";

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

/** Draw announcement text centered on screen. */
export function drawAnnouncement(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.announcement) return;
  const text = overlay.ui.announcement;
  octx.save();
  octx.font = FONT_ANNOUNCE;
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  drawShadowText(octx, text, W / 2, H / 2, SHADOW_COLOR_HEAVY, TEXT_WHITE);
  octx.restore();
}

/** Draw phase transition banner sweeping across the screen. */
export function drawBanner(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.banner) return;
  const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
  const by = Math.round(overlay.ui.banner.y - bannerH / 2);
  octx.fillStyle = PANEL_BG(BG_BANNER);
  octx.fillRect(0, by, W, bannerH);
  octx.fillStyle = GOLD;
  octx.fillRect(0, by, W, 2);
  octx.fillRect(0, by + bannerH - 2, W, 2);
  octx.save();
  octx.textAlign = TEXT_ALIGN_CENTER;
  const hasSubtitle = !!overlay.ui.banner.subtitle;
  const titleY = hasSubtitle ? by + bannerH * 0.38 : by + bannerH / 2;
  octx.font = FONT_TITLE;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  drawShadowText(
    octx,
    overlay.ui.banner.text,
    W / 2,
    titleY,
    SHADOW_COLOR,
    GOLD_LIGHT,
  );
  if (hasSubtitle) {
    octx.font = FONT_FLOAT_SM;
    octx.fillStyle = GOLD_SUBTITLE;
    octx.fillText(overlay.ui.banner.subtitle!, W / 2, by + bannerH * 0.72);
  }
  octx.restore();
}

/** Draw score deltas floating over each player's territory. */
export function drawScoreDeltas(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.scoreDeltas?.length) return;
  const progress = overlay.ui.scoreDeltaProgress ?? 1;
  const linear = Math.min(1, progress / 0.8); // count up in first 80%, hold final value for last 20%
  const t = linear ** 3; // ease-in cubic: slow start, fast finish
  const fade = Math.min(1, progress / 0.15); // fade in over first 15%
  octx.save();
  octx.globalAlpha = fade;
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  for (const d of overlay.ui.scoreDeltas) {
    const shown = Math.round(d.delta * t);
    const total = d.total - d.delta + shown;
    octx.font = FONT_FLOAT_LG;
    drawShadowText(
      octx,
      `+${shown}`,
      d.cx,
      d.cy - 6,
      SHADOW_COLOR_DENSE,
      TEXT_WHITE,
    );
    octx.font = FONT_FLOAT_MD;
    drawShadowText(octx, `${total}`, d.cx, d.cy + 8, SHADOW_COLOR, GOLD_LIGHT);
  }
  octx.restore();
}

/** Draw status bar at the bottom of the canvas. */
export function drawStatusBar(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.statusBar) return;
  const sb = overlay.ui.statusBar;
  const barH = STATUSBAR_HEIGHT;
  const by = H - barH;

  octx.fillStyle = PANEL_BG(BG_OPAQUE);
  octx.fillRect(0, by, W, barH);
  octx.fillStyle = GOLD_BG(OP_ACCENT);
  octx.fillRect(0, by, W, 1);

  octx.save();
  octx.font = FONT_STATUS;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  const cy = by + barH / 2;

  // Left: round + phase + timer
  octx.textAlign = TEXT_ALIGN_LEFT;
  octx.fillStyle = STATUS_TEXT_COLOR;
  octx.fillText(`${sb.round}  ${sb.phase}  ${sb.timer}`, PAD, cy);

  // Right: player stats
  octx.textAlign = TEXT_ALIGN_RIGHT;
  let rx = W - PAD;
  for (let i = sb.players.length - 1; i >= 0; i--) {
    const p = sb.players[i]!;
    if (p.eliminated) continue;
    const c = p.color;
    // Lives
    octx.fillStyle = LIVES_HEART_COLOR;
    const heartsStr = "\u2665".repeat(p.lives);
    octx.fillText(heartsStr, rx, cy);
    rx -= octx.measureText(heartsStr).width + 2;
    // Cannons
    octx.fillStyle = rgb(c, OP_VIVID);
    const cannonStr = `${p.cannons}c `;
    octx.fillText(cannonStr, rx, cy);
    rx -= octx.measureText(cannonStr).width;
    // Score
    octx.fillStyle = rgb(c);
    const scoreStr = `${p.score} `;
    octx.fillText(scoreStr, rx, cy);
    rx -= octx.measureText(scoreStr).width + 4;
  }
  octx.restore();
}

/** Draw the game over overlay with winner and scores. */
export function drawGameOver(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.gameOver) return;
  const gameOverData = overlay.ui.gameOver;
  const sorted = [...gameOverData.scores].sort((a, b) => b.score - a.score);
  const hasStats = sorted.some((e) => e.stats);
  const statsH = hasStats ? GAMEOVER_ROW_H : 0;
  const lo = gameOverLayout(W, H, gameOverData.scores);
  const { panelW, panelH, px, py, btnW, btnY, rematchX, menuX } = lo;

  drawPanel(octx, px, py, panelW, panelH, PANEL_BG(BG_OVERLAY), GOLD);

  const cx = W / 2;
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.font = FONT_HEADING;
  drawShadowText(
    octx,
    `${gameOverData.winner} wins!`,
    cx,
    py + 20,
    SHADOW_COLOR,
    GOLD_LIGHT,
  );
  octx.fillStyle = GOLD;
  octx.fillRect(px + INSET, py + 32, panelW - INSET_X2, 1);

  // Column headers
  const tableTop = py + GAMEOVER_HEADER_H;
  const colName = px + INSET;
  const colScore = px + panelW * GAMEOVER_COL_RATIOS[0];
  const colWalls = px + panelW * GAMEOVER_COL_RATIOS[1];
  const colCannons = px + panelW * GAMEOVER_COL_RATIOS[2];
  const colTerritory = px + panelW * GAMEOVER_COL_RATIOS[3];

  if (hasStats) {
    octx.font = FONT_FLOAT_XS;
    octx.fillStyle = TEXT_MUTED;
    octx.textAlign = TEXT_ALIGN_RIGHT;
    octx.fillText("Score", colScore, tableTop + PAD);
    octx.fillText("Walls", colWalls, tableTop + PAD);
    octx.fillText("Cannons", colCannons, tableTop + PAD);
    octx.fillText("Land", colTerritory, tableTop + PAD);
  }

  // Player rows
  octx.font = FONT_LABEL;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const y = tableTop + statsH + INSET + i * GAMEOVER_ROW_H;
    const c = entry.color;
    const alpha = entry.eliminated ? OP_ACCENT : 1;
    octx.fillStyle = rgb(c, alpha);
    octx.textAlign = TEXT_ALIGN_LEFT;
    octx.fillText(entry.name, colName, y);
    octx.textAlign = TEXT_ALIGN_RIGHT;
    octx.fillText(`${entry.score}`, colScore, y);
    if (entry.stats) {
      octx.fillStyle = rgb(c, alpha * OP_SECONDARY);
      octx.fillText(`${entry.stats.wallsDestroyed}`, colWalls, y);
      octx.fillText(`${entry.stats.cannonsKilled}`, colCannons, y);
      octx.fillText(`${entry.territory ?? 0}`, colTerritory, y);
    }
  }

  // Rematch / Menu buttons
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  const focused = gameOverData.focused;

  const rematchFocused = focused === FOCUS_REMATCH;
  drawButton(
    octx,
    rematchX,
    btnY,
    btnW,
    GAMEOVER_BTN_H,
    BTN_CONTINUE.fill(rematchFocused ? OP_FOCUS : OP_IDLE),
    rematchFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
    rematchFocused ? 2 : 1,
    FONT_BUTTON,
    rematchFocused ? TEXT_WHITE : TEXT_LIGHT,
    "Rematch",
  );

  const menuFocused = focused === FOCUS_MENU;
  drawButton(
    octx,
    menuX,
    btnY,
    btnW,
    GAMEOVER_BTN_H,
    BTN_ABANDON.fill(menuFocused ? OP_FOCUS : OP_IDLE),
    menuFocused ? BTN_MENU.strokeFocused : BTN_MENU.stroke,
    menuFocused ? 2 : 1,
    FONT_BUTTON,
    menuFocused ? TEXT_WHITE : TEXT_LIGHT,
    "Menu",
  );
}

/** Draw life-lost continue/abandon dialogs (one per player). */
export function drawLifeLostDialog(
  octx: CanvasRenderingContext2D,
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
    drawPanel(octx, px, py, PANEL_W, PANEL_H, PANEL_BG(BG_OVERLAY), rgb(c));

    // Player name
    octx.textAlign = TEXT_ALIGN_CENTER;
    octx.textBaseline = TEXT_BASELINE_MIDDLE;
    octx.font = FONT_BODY;
    octx.fillStyle = rgb(c);
    octx.fillText(entry.name, cx, py + 18);

    // Separator
    octx.fillStyle = GOLD;
    octx.fillRect(px + INSET, py + 28, PANEL_W - INSET_X2, 1);

    // Lives remaining
    octx.font = FONT_SMALL;
    if (entry.lives > 0) {
      octx.fillStyle = GOLD_LIGHT;
      octx.fillText(
        `${entry.lives} ${entry.lives === 1 ? "life" : "lives"} left`,
        cx,
        py + 40,
      );
    } else {
      octx.fillStyle = ELIMINATED_RED;
      octx.fillText("Eliminated", cx, py + 40);
    }

    if (entry.choice === LifeLostChoice.PENDING && entry.lives > 0) {
      // Continue / Abandon buttons with focus highlight
      const btnW = BTN_W,
        btnH = BTN_H;
      const { btnY, contX, abX } = lifeLostButtonLayout(px, py);
      const contFocused = entry.focused === 0;
      const abFocused = entry.focused === 1;

      // Continue button
      const t = now ?? Date.now();
      const contFlash = contFocused && flashOn(BUTTON_FLASH_MS, t);
      drawButton(
        octx,
        contX,
        btnY,
        btnW,
        btnH,
        BTN_CONTINUE.fill(
          contFocused ? (contFlash ? OP_VIVID : OP_ACCENT) : OP_SUBTLE,
        ),
        contFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
        contFocused ? 2 : 1,
        FONT_BUTTON,
        contFocused ? TEXT_WHITE : TEXT_DISABLED,
        "Continue",
      );

      // Abandon button
      const abFlash = abFocused && flashOn(BUTTON_FLASH_MS, t);
      drawButton(
        octx,
        abX,
        btnY,
        btnW,
        btnH,
        BTN_ABANDON.fill(
          abFocused ? (abFlash ? OP_FOCUS : OP_ACTIVE) : OP_GHOST,
        ),
        abFocused ? BTN_ABANDON.strokeFocused : BTN_ABANDON.stroke,
        abFocused ? 2 : 1,
        FONT_BUTTON,
        abFocused ? TEXT_WHITE : TEXT_FAINT,
        "Abandon",
      );
    } else {
      // Resolved state
      octx.font = FONT_LABEL;
      octx.fillStyle =
        entry.choice === LifeLostChoice.CONTINUE
          ? BTN_CONTINUE.stroke
          : BTN_ABANDON.stroke;
      octx.fillText(
        entry.choice === LifeLostChoice.CONTINUE
          ? "Continuing..."
          : "Abandoned",
        cx,
        py + PANEL_H - 18,
      );
    }
  }
}

/** Draw the player selection lobby screen. */
export function drawPlayerSelect(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.ui?.playerSelect) return;
  const selectData = overlay.ui.playerSelect;
  beginModalScreen(octx, W, H);

  octx.font = FONT_TITLE;
  octx.fillStyle = GOLD_LIGHT;
  octx.fillText("Rebuild & Ruin", W / 2, H * 0.1);
  octx.font = FONT_SUBTITLE;
  octx.fillStyle = TEXT_MUTED;
  octx.fillText("A Rampart Tribute", W / 2, H * 0.1 + 20);

  if (selectData.roomCode) {
    octx.font = FONT_TIMER;
    octx.fillStyle = GOLD;
    octx.fillText(`Room: ${selectData.roomCode}`, W / 2, H * 0.1 + 42);
  }

  const count = selectData.players.length;
  const { gap, rectW, rectH, rectY } = computeLobbyLayout(W, H, count);

  for (let i = 0; i < count; i++) {
    const p = selectData.players[i]!;
    const c = p.color;
    const rx = gap + i * (rectW + gap);

    drawPanel(octx, rx, rectY, rectW, rectH, rgb(c, OP_SUBTLE), rgb(c));

    const cx = rx + rectW / 2;
    const touch = IS_TOUCH_DEVICE;
    octx.font = touch ? FONT_HEADING : FONT_BODY;
    octx.fillStyle = rgb(c);
    octx.fillText(p.name, cx, rectY + (touch ? 34 : 30));
    const btnW = rectW - (touch ? 12 : 16);
    const btnH = touch ? 36 : 24;
    const btnX = rx + (touch ? 6 : 8);
    const btnY = rectY + rectH - btnH - (touch ? 8 : 12);

    if (p.joined) {
      drawButton(
        octx,
        btnX,
        btnY,
        btnW,
        btnH,
        rgb(c, OP_ACTIVE),
        rgb(c),
        1,
        touch ? FONT_BODY : FONT_BUTTON,
        TEXT_WHITE,
        "Please wait...",
      );
    } else {
      const flash = flashOn(CURSOR_BLINK_MS, now ?? Date.now());
      drawButton(
        octx,
        btnX,
        btnY,
        btnW,
        btnH,
        rgb(c, flash ? OP_FOCUS : OP_IDLE),
        rgb(c),
        1,
        touch ? FONT_LABEL : FONT_HINT,
        flash ? TEXT_WHITE : TEXT_SOFT,
        touch ? "Tap to join" : "Press button to start",
      );
    }

    if (!touch) {
      octx.font = FONT_HINT;
      octx.fillStyle = TEXT_DIM;
      octx.fillText(p.keyHint ?? "", cx, btnY - PAD);
    }
  }

  const secs = Math.ceil(selectData.timer);
  octx.font = FONT_TIMER;
  octx.fillStyle = GOLD;
  octx.fillText(`Starting in ${secs}s`, W / 2, H * 0.88);

  // Gear button + F1 hint (top-right corner)
  octx.textAlign = TEXT_ALIGN_RIGHT;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
  octx.font = FONT_ICON;
  octx.fillStyle = TEXT_MUTED;
  octx.fillText("\u2699", W - 6, 18);
  octx.font = FONT_HINT;
  octx.fillStyle = TEXT_DIM;
  octx.fillText("F1", W - 30, 18);
}

/** Draw the options screen. */
export function drawOptionsScreen(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.ui?.optionsScreen) return;
  const opts = overlay.ui.optionsScreen;
  beginModalScreen(octx, W, H);

  octx.font = FONT_TITLE;
  octx.fillStyle = GOLD_LIGHT;
  octx.fillText("OPTIONS", W / 2, H * 0.12);

  // Options list
  const optH = 28;
  const startY = Math.round(H * 0.28);
  const panelW = Math.round(W * 0.65);
  const px = Math.round((W - panelW) / 2);

  for (let i = 0; i < opts.options.length; i++) {
    const opt = opts.options[i]!;
    const oy = startY + i * optH;
    const selected = i === opts.cursor;

    // Row background
    if (selected) {
      octx.fillStyle = GOLD_BG(OP_SUBTLE);
      octx.fillRect(px, oy, panelW, optH - 2);
    }

    // Arrow indicators for selected editable row
    if (selected && opt.editable) {
      const t = now ?? Date.now();
      const flash = flashOn(BUTTON_FLASH_MS, t);
      octx.font = FONT_BODY;
      octx.fillStyle = flash ? GOLD_LIGHT : GOLD;
      octx.textAlign = TEXT_ALIGN_LEFT;
      octx.fillText("\u25C0", px + PAD / 2, oy + optH / 2);
      octx.textAlign = TEXT_ALIGN_RIGHT;
      octx.fillText("\u25B6", px + panelW - PAD / 2, oy + optH / 2);
    }

    // Option name (left-aligned)
    octx.textAlign = TEXT_ALIGN_LEFT;
    octx.font = selected ? FONT_BODY : FONT_LABEL;
    octx.fillStyle = selected
      ? opt.editable
        ? TEXT_WHITE
        : TEXT_DISABLED
      : TEXT_MUTED;
    octx.fillText(opt.name, px + INSET_X2, oy + optH / 2);

    // Option value (right-aligned) — with blinking cursor for seed input
    octx.textAlign = TEXT_ALIGN_RIGHT;
    octx.fillStyle = selected
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
    octx.fillText(displayValue, px + panelW - INSET_X2, oy + optH / 2);
  }

  // Separator
  const sepY = startY + opts.options.length * optH + PAD;
  octx.fillStyle = GOLD;
  octx.fillRect(px + INSET, sepY, panelW - INSET_X2, 1);

  // Context-sensitive hint
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.font = FONT_HINT;
  octx.fillStyle = TEXT_DIM;
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
  octx.fillText(hint, W / 2, H * 0.85);
}

/** Draw the controls rebinding screen. */
export function drawControlsScreen(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.ui?.controlsScreen) return;
  const ctrl = overlay.ui.controlsScreen;
  beginModalScreen(octx, W, H);

  octx.font = FONT_TITLE;
  octx.fillStyle = GOLD_LIGHT;
  octx.fillText("CONTROLS", W / 2, H * 0.1);

  // Layout
  const colCount = ctrl.players.length;
  const rowCount = ctrl.actionNames.length;
  const tableW = Math.round(W * 0.8);
  const labelColW = Math.round(tableW * 0.2);
  const playerColW = Math.round((tableW - labelColW) / colCount);
  const tableX = Math.round((W - tableW) / 2);
  const headerY = Math.round(H * 0.2);
  const rowH = 22;
  const startY = headerY + 28;

  // Player name headers
  for (let p = 0; p < colCount; p++) {
    const player = ctrl.players[p]!;
    const c = player.color;
    const cx = tableX + labelColW + p * playerColW + playerColW / 2;
    octx.font = FONT_BODY;
    octx.fillStyle = rgb(c);
    octx.fillText(player.name, cx, headerY);
  }

  // Header separator
  octx.fillStyle = GOLD;
  octx.fillRect(tableX + PAD, headerY + 12, tableW - PAD * 2, 1);

  // Rows
  for (let a = 0; a < rowCount; a++) {
    const oy = startY + a * rowH;

    // Action label (left column)
    octx.textAlign = TEXT_ALIGN_LEFT;
    octx.font = FONT_LABEL;
    octx.fillStyle = TEXT_MUTED;
    octx.fillText(ctrl.actionNames[a]!, tableX + PAD, oy + rowH / 2);

    // Key cells for each player
    for (let p = 0; p < colCount; p++) {
      const player = ctrl.players[p]!;
      const cx = tableX + labelColW + p * playerColW + playerColW / 2;
      const cellX = tableX + labelColW + p * playerColW + PAD / 2;
      const cellW = playerColW - PAD;
      const isSelected = p === ctrl.playerIdx && a === ctrl.actionIdx;

      if (isSelected) {
        if (ctrl.rebinding) {
          // Flashing "Press key..." cell
          const flash = flashOn(REBIND_FLASH_MS, now ?? Date.now());
          octx.fillStyle = flash ? GOLD_BG(OP_ACTIVE) : GOLD_BG(OP_GHOST);
          octx.fillRect(cellX, oy + 1, cellW, rowH - 2);
          octx.strokeStyle = GOLD_LIGHT;
          octx.lineWidth = 1;
          octx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
          octx.textAlign = TEXT_ALIGN_CENTER;
          octx.font = FONT_SMALL;
          octx.fillStyle = flash ? GOLD_LIGHT : GOLD;
          octx.fillText("Press key\u2026", cx, oy + rowH / 2);
        } else {
          // Highlighted selected cell
          octx.fillStyle = GOLD_BG(OP_IDLE);
          octx.fillRect(cellX, oy + 1, cellW, rowH - 2);
          octx.strokeStyle = GOLD;
          octx.lineWidth = 1;
          octx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
          octx.textAlign = TEXT_ALIGN_CENTER;
          octx.font = FONT_BODY;
          octx.fillStyle = TEXT_WHITE;
          octx.fillText(player.bindings[a]!, cx, oy + rowH / 2);
        }
      } else {
        octx.textAlign = TEXT_ALIGN_CENTER;
        octx.font = FONT_LABEL;
        octx.fillStyle = rgb(player.color, OP_SECONDARY);
        octx.fillText(player.bindings[a]!, cx, oy + rowH / 2);
      }
    }
  }

  // Bottom separator
  const sepY = startY + rowCount * rowH + PAD;
  octx.fillStyle = GOLD;
  octx.fillRect(tableX + INSET, sepY, tableW - INSET_X2, 1);

  // Bottom hint
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.font = FONT_HINT;
  octx.fillStyle = TEXT_DIM;
  octx.fillText(
    "\u2190 \u2192 switch player  |  \u2191 \u2193 select action  |  Enter to rebind  |  ESC to go back",
    W / 2,
    H * 0.88,
  );
}

/** Draw a panel: filled rect + inset border stroke. */
function drawPanel(
  octx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
): void {
  octx.fillStyle = fill;
  octx.fillRect(x, y, w, h);
  octx.strokeStyle = stroke;
  octx.lineWidth = 2;
  octx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** Draw a styled button: filled rect + border + centered label. */
function drawButton(
  octx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  lineWidth: number,
  font: string,
  textColor: string,
  label: string,
): void {
  octx.fillStyle = fill;
  octx.fillRect(x, y, w, h);
  octx.strokeStyle = stroke;
  octx.lineWidth = lineWidth;
  octx.strokeRect(x, y, w, h);
  octx.font = font;
  octx.fillStyle = textColor;
  octx.fillText(label, x + w / 2, y + h / 2);
}

/** Fill a full-screen opaque panel and set up centered text drawing. */
function beginModalScreen(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  octx.fillStyle = PANEL_BG(BG_OPAQUE);
  octx.fillRect(0, 0, W, H);
  octx.textAlign = TEXT_ALIGN_CENTER;
  octx.textBaseline = TEXT_BASELINE_MIDDLE;
}
