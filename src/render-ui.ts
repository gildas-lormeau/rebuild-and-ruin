/**
 * UI overlay rendering — announcement, banner, game over, player select.
 */

import { CHOICE_CONTINUE, CHOICE_PENDING } from "./life-lost.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import { computeLobbyLayout, GAMEOVER_BTN_H, GAMEOVER_COL_RATIOS, GAMEOVER_HEADER_H, GAMEOVER_ROW_H, gameOverLayout, lifeLostButtonLayout } from "./render-composition.ts";
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
  setCenterText,
} from "./render-theme.ts";
import { FOCUS_MENU, FOCUS_REMATCH, type RenderOverlay } from "./render-types.ts";

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
const TEXT_DISABLED = "#999";
const ELIMINATED_RED = "#c44";

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
  setCenterText(octx);
  drawShadowText(octx, text, W / 2, H / 2, SHADOW_COLOR_HEAVY, "#fff");
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
  octx.fillStyle = PANEL_BG(0.85);
  octx.fillRect(0, by, W, bannerH);
  octx.fillStyle = GOLD;
  octx.fillRect(0, by, W, 2);
  octx.fillRect(0, by + bannerH - 2, W, 2);
  octx.save();
  octx.textAlign = "center";
  const hasSubtitle = !!overlay.ui.banner.subtitle;
  const titleY = hasSubtitle ? by + bannerH * 0.38 : by + bannerH / 2;
  octx.font = FONT_TITLE;
  octx.textBaseline = "middle";
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
  setCenterText(octx);
  for (const d of overlay.ui.scoreDeltas) {
    const shown = Math.round(d.delta * t);
    const total = d.total - d.delta + shown;
    octx.font = FONT_FLOAT_LG;
    drawShadowText(octx, `+${shown}`, d.cx, d.cy - 6, SHADOW_COLOR_DENSE, "#fff");
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

  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, by, W, barH);
  octx.fillStyle = GOLD_BG(0.4);
  octx.fillRect(0, by, W, 1);

  octx.save();
  octx.font = FONT_STATUS;
  octx.textBaseline = "middle";
  const cy = by + barH / 2;

  // Left: round + phase + timer
  octx.textAlign = "left";
  octx.fillStyle = STATUS_TEXT_COLOR;
  octx.fillText(`${sb.round}  ${sb.phase}  ${sb.timer}`, 8, cy);

  // Right: player stats
  octx.textAlign = "right";
  let rx = W - 8;
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
    octx.fillStyle = rgb(c, 0.6);
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
  const hasStats = sorted.some(e => e.stats);
  const statsH = hasStats ? GAMEOVER_ROW_H : 0;
  const lo = gameOverLayout(W, H, gameOverData.scores);
  const { panelW, panelH, px, py, btnW, btnY, rematchX, menuX } = lo;

  drawPanel(octx, px, py, panelW, panelH, PANEL_BG(0.9), GOLD);

  const cx = W / 2;
  octx.textAlign = "center";
  octx.font = FONT_HEADING;
  drawShadowText(octx, `${gameOverData.winner} wins!`, cx, py + 20, SHADOW_COLOR, GOLD_LIGHT);
  octx.fillStyle = GOLD;
  octx.fillRect(px + 10, py + 32, panelW - 20, 1);

  // Column headers
  const tableTop = py + GAMEOVER_HEADER_H;
  const colName = px + 10;
  const colScore = px + panelW * GAMEOVER_COL_RATIOS[0];
  const colWalls = px + panelW * GAMEOVER_COL_RATIOS[1];
  const colCannons = px + panelW * GAMEOVER_COL_RATIOS[2];
  const colTerritory = px + panelW * GAMEOVER_COL_RATIOS[3];

  if (hasStats) {
    octx.font = FONT_FLOAT_XS;
    octx.fillStyle = "#888";
    octx.textAlign = "right";
    octx.fillText("Score", colScore, tableTop + 8);
    octx.fillText("Walls", colWalls, tableTop + 8);
    octx.fillText("Cannons", colCannons, tableTop + 8);
    octx.fillText("Land", colTerritory, tableTop + 8);
  }

  // Player rows
  octx.font = FONT_LABEL;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const y = tableTop + statsH + 10 + i * GAMEOVER_ROW_H;
    const c = entry.color;
    const alpha = entry.eliminated ? 0.4 : 1;
    octx.fillStyle = rgb(c, alpha);
    octx.textAlign = "left";
    octx.fillText(entry.name, colName, y);
    octx.textAlign = "right";
    octx.fillText(`${entry.score}`, colScore, y);
    if (entry.stats) {
      octx.fillStyle = rgb(c, alpha * 0.7);
      octx.fillText(`${entry.stats.wallsDestroyed}`, colWalls, y);
      octx.fillText(`${entry.stats.cannonsKilled}`, colCannons, y);
      octx.fillText(`${entry.territory ?? 0}`, colTerritory, y);
    }
  }

  // Rematch / Menu buttons
  setCenterText(octx);
  const focused = gameOverData.focused;

  const rematchFocused = focused === FOCUS_REMATCH;
  drawButton(octx, rematchX, btnY, btnW, GAMEOVER_BTN_H,
    BTN_CONTINUE.fill(rematchFocused ? 0.5 : 0.2),
    rematchFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
    rematchFocused ? 2 : 1, FONT_BUTTON,
    rematchFocused ? "#fff" : "#ccc", "Rematch");

  const menuFocused = focused === FOCUS_MENU;
  drawButton(octx, menuX, btnY, btnW, GAMEOVER_BTN_H,
    BTN_ABANDON.fill(menuFocused ? 0.5 : 0.2),
    menuFocused ? "#ccf" : "#99c",
    menuFocused ? 2 : 1, FONT_BUTTON,
    menuFocused ? "#fff" : "#ccc", "Menu");
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
    drawPanel(octx, px, py, PANEL_W, PANEL_H, PANEL_BG(0.9), rgb(c));

    // Player name
    setCenterText(octx);
    octx.font = FONT_BODY;
    octx.fillStyle = rgb(c);
    octx.fillText(entry.name, cx, py + 18);

    // Separator
    octx.fillStyle = GOLD;
    octx.fillRect(px + 10, py + 28, PANEL_W - 20, 1);

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

    if (entry.choice === CHOICE_PENDING && entry.lives > 0) {
      // Continue / Abandon buttons with focus highlight
      const btnW = BTN_W,
        btnH = BTN_H;
      const { btnY, contX, abX } = lifeLostButtonLayout(px, py);
      const contFocused = entry.focused === 0;
      const abFocused = entry.focused === 1;

      // Continue button
      const t = now ?? Date.now();
      const contFlash = contFocused && flashOn(BUTTON_FLASH_MS, t);
      drawButton(octx, contX, btnY, btnW, btnH,
        BTN_CONTINUE.fill(contFocused ? (contFlash ? 0.6 : 0.4) : 0.15),
        contFocused ? BTN_CONTINUE.strokeFocused : BTN_CONTINUE.stroke,
        contFocused ? 2 : 1, FONT_BUTTON,
        contFocused ? "#fff" : TEXT_DISABLED, "Continue");

      // Abandon button
      const abFlash = abFocused && flashOn(BUTTON_FLASH_MS, t);
      drawButton(octx, abX, btnY, btnW, btnH,
        BTN_ABANDON.fill(abFocused ? (abFlash ? 0.5 : 0.3) : 0.1),
        abFocused ? BTN_ABANDON.strokeFocused : BTN_ABANDON.stroke,
        abFocused ? 2 : 1, FONT_BUTTON,
        abFocused ? "#fff" : "#777", "Abandon");
    } else {
      // Resolved state
      octx.font = FONT_LABEL;
      octx.fillStyle =
        entry.choice === CHOICE_CONTINUE ? BTN_CONTINUE.stroke : BTN_ABANDON.stroke;
      octx.fillText(
        entry.choice === CHOICE_CONTINUE ? "Continuing..." : "Abandoned",
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

    drawPanel(octx, rx, rectY, rectW, rectH, rgb(c, 0.15), rgb(c));

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
      drawButton(octx, btnX, btnY, btnW, btnH,
        rgb(c, 0.3), rgb(c), 1,
        touch ? FONT_BODY : FONT_BUTTON, "#fff", "Please wait...");
    } else {
      const flash = flashOn(CURSOR_BLINK_MS, now ?? Date.now());
      drawButton(octx, btnX, btnY, btnW, btnH,
        rgb(c, flash ? 0.5 : 0.2), rgb(c), 1,
        touch ? FONT_LABEL : FONT_HINT,
        flash ? "#fff" : "#aaa",
        touch ? "Tap to join" : "Press button to start");
    }

    if (!touch) {
      octx.font = FONT_HINT;
      octx.fillStyle = TEXT_DIM;
      octx.fillText(p.keyHint ?? "", cx, btnY - 8);
    }
  }

  const secs = Math.ceil(selectData.timer);
  octx.font = FONT_TIMER;
  octx.fillStyle = GOLD;
  octx.fillText(`Starting in ${secs}s`, W / 2, H * 0.88);

  // Gear button + F1 hint (top-right corner)
  octx.textAlign = "right";
  octx.textBaseline = "middle";
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
      octx.fillStyle = GOLD_BG(0.15);
      octx.fillRect(px, oy, panelW, optH - 2);
    }

    // Arrow indicators for selected editable row
    if (selected && opt.editable) {
      const t = now ?? Date.now();
      const flash = flashOn(BUTTON_FLASH_MS, t);
      octx.font = FONT_BODY;
      octx.fillStyle = flash ? GOLD_LIGHT : GOLD;
      octx.textAlign = "left";
      octx.fillText("\u25C0", px + 4, oy + optH / 2);
      octx.textAlign = "right";
      octx.fillText("\u25B6", px + panelW - 4, oy + optH / 2);
    }

    // Option name (left-aligned)
    octx.textAlign = "left";
    octx.font = selected ? FONT_BODY : FONT_LABEL;
    octx.fillStyle = selected
      ? opt.editable
        ? "#fff"
        : TEXT_DISABLED
      : TEXT_MUTED;
    octx.fillText(opt.name, px + 20, oy + optH / 2);

    // Option value (right-aligned) — with blinking cursor for seed input
    octx.textAlign = "right";
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
      opt.value + (showCursor ? (flashOn(CURSOR_BLINK_MS, now ?? Date.now()) ? "_" : " ") : "");
    octx.fillText(displayValue, px + panelW - 20, oy + optH / 2);
  }

  // Separator
  const sepY = startY + opts.options.length * optH + 8;
  octx.fillStyle = GOLD;
  octx.fillRect(px + 10, sepY, panelW - 20, 1);

  // Context-sensitive hint
  octx.textAlign = "center";
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
  octx.fillRect(tableX + 4, headerY + 12, tableW - 8, 1);

  // Rows
  for (let a = 0; a < rowCount; a++) {
    const oy = startY + a * rowH;

    // Action label (left column)
    octx.textAlign = "left";
    octx.font = FONT_LABEL;
    octx.fillStyle = TEXT_MUTED;
    octx.fillText(ctrl.actionNames[a]!, tableX + 6, oy + rowH / 2);

    // Key cells for each player
    for (let p = 0; p < colCount; p++) {
      const player = ctrl.players[p]!;
      const cx = tableX + labelColW + p * playerColW + playerColW / 2;
      const cellX = tableX + labelColW + p * playerColW + 4;
      const cellW = playerColW - 8;
      const isSelected = p === ctrl.playerIdx && a === ctrl.actionIdx;

      if (isSelected) {
        if (ctrl.rebinding) {
          // Flashing "Press key..." cell
          const flash = flashOn(REBIND_FLASH_MS, now ?? Date.now());
          octx.fillStyle = flash ? GOLD_BG(0.3) : GOLD_BG(0.1);
          octx.fillRect(cellX, oy + 1, cellW, rowH - 2);
          octx.strokeStyle = GOLD_LIGHT;
          octx.lineWidth = 1;
          octx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
          octx.textAlign = "center";
          octx.font = FONT_SMALL;
          octx.fillStyle = flash ? GOLD_LIGHT : GOLD;
          octx.fillText("Press key\u2026", cx, oy + rowH / 2);
        } else {
          // Highlighted selected cell
          octx.fillStyle = GOLD_BG(0.2);
          octx.fillRect(cellX, oy + 1, cellW, rowH - 2);
          octx.strokeStyle = GOLD;
          octx.lineWidth = 1;
          octx.strokeRect(cellX, oy + 1, cellW, rowH - 2);
          octx.textAlign = "center";
          octx.font = FONT_BODY;
          octx.fillStyle = "#fff";
          octx.fillText(player.bindings[a]!, cx, oy + rowH / 2);
        }
      } else {
        octx.textAlign = "center";
        octx.font = FONT_LABEL;
        octx.fillStyle = rgb(player.color, 0.7);
        octx.fillText(player.bindings[a]!, cx, oy + rowH / 2);
      }
    }
  }

  // Bottom separator
  const sepY = startY + rowCount * rowH + 8;
  octx.fillStyle = GOLD;
  octx.fillRect(tableX + 10, sepY, tableW - 20, 1);

  // Bottom hint
  octx.textAlign = "center";
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
  x: number, y: number, w: number, h: number,
  fill: string, stroke: string,
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
  x: number, y: number, w: number, h: number,
  fill: string, stroke: string, lineWidth: number,
  font: string, textColor: string, label: string,
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
function beginModalScreen(octx: CanvasRenderingContext2D, W: number, H: number): void {
  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, 0, W, H);
  setCenterText(octx);
}
