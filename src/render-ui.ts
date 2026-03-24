/**
 * UI overlay rendering — announcement, banner, game over, player select.
 */

import { FOCUS_MENU, FOCUS_REMATCH } from "./game-ui-types.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  LIFE_LOST_BTN_H as BTN_H,
  LIFE_LOST_BTN_W as BTN_W,
  BUTTON_FLASH_MS,
  CURSOR_BLINK_MS,
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
  GOLD,
  GOLD_BG,
  GOLD_LIGHT,
  PANEL_BG,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_PANEL_W as PANEL_W,
  REBIND_FLASH_MS,
  rgb,
  SHADOW_COLOR,
} from "./render-theme.ts";
import type { RenderOverlay } from "./render-types.ts";

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
  octx.textAlign = "center";
  octx.textBaseline = "middle";
  drawShadowText(octx, text, W / 2, H / 2, "rgba(0,0,0,0.7)", "#fff");
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
  const bannerH = Math.round(H * 0.15);
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
    octx.fillStyle = "#c8a860";
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
  octx.textAlign = "center";
  octx.textBaseline = "middle";
  for (const d of overlay.ui.scoreDeltas) {
    const shown = Math.round(d.delta * t);
    const total = d.total - d.delta + shown;
    octx.font = FONT_FLOAT_LG;
    drawShadowText(octx, `+${shown}`, d.cx, d.cy - 6, "rgba(0,0,0,0.8)", "#fff");
    octx.font = FONT_FLOAT_MD;
    drawShadowText(octx, `${total}`, d.cx, d.cy + 8, "rgba(0,0,0,0.6)", GOLD_LIGHT);
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
  const barH = 32;
  const by = H - barH;

  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, by, W, barH);
  octx.fillStyle = "rgba(200,160,64,0.4)";
  octx.fillRect(0, by, W, 1);

  octx.save();
  octx.font = FONT_STATUS;
  octx.textBaseline = "middle";
  const cy = by + barH / 2;

  // Left: round + phase + timer
  octx.textAlign = "left";
  octx.fillStyle = "#a08050";
  octx.fillText(`${sb.round}  ${sb.phase}  ${sb.timer}`, 8, cy);

  // Right: player stats
  octx.textAlign = "right";
  let rx = W - 8;
  for (let i = sb.players.length - 1; i >= 0; i--) {
    const p = sb.players[i]!;
    if (p.eliminated) continue;
    const c = p.color;
    // Lives
    octx.fillStyle = "#c44";
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
  const rowH = 14;
  const headerH = 36;
  const statsH = hasStats ? 14 : 0; // column headers
  const tableH = sorted.length * rowH + statsH;
  const btnH = 20;
  const panelW = Math.round(W * 0.65);
  const panelH = headerH + tableH + 16 + btnH + 12;
  const px = Math.round((W - panelW) / 2);
  const py = Math.round((H - panelH) / 2);

  octx.fillStyle = PANEL_BG(0.9);
  octx.fillRect(px, py, panelW, panelH);
  octx.strokeStyle = GOLD;
  octx.lineWidth = 2;
  octx.strokeRect(px + 1, py + 1, panelW - 2, panelH - 2);

  const cx = W / 2;
  octx.textAlign = "center";
  octx.font = FONT_HEADING;
  drawShadowText(octx, `${gameOverData.winner} wins!`, cx, py + 20, SHADOW_COLOR, GOLD_LIGHT);
  octx.fillStyle = GOLD;
  octx.fillRect(px + 10, py + 32, panelW - 20, 1);

  // Column headers
  const tableTop = py + headerH;
  const colName = px + 10;
  const colScore = px + panelW * 0.38;
  const colWalls = px + panelW * 0.56;
  const colCannons = px + panelW * 0.74;
  const colTerritory = px + panelW * 0.92;

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
    const y = tableTop + statsH + 10 + i * rowH;
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
  octx.textAlign = "center";
  octx.textBaseline = "middle";
  const btnW = Math.round((panelW - 30) / 2);
  const btnY = py + panelH - btnH - 10;
  const rematchX = px + 10;
  const menuX = px + panelW - 10 - btnW;
  const focused = gameOverData.focused;

  // Rematch button
  octx.fillStyle = focused === FOCUS_REMATCH ? "rgba(80,180,80,0.5)" : "rgba(80,180,80,0.2)";
  octx.fillRect(rematchX, btnY, btnW, btnH);
  octx.strokeStyle = focused === FOCUS_REMATCH ? "#afa" : "#8c8";
  octx.lineWidth = focused === FOCUS_REMATCH ? 2 : 1;
  octx.strokeRect(rematchX, btnY, btnW, btnH);
  octx.font = FONT_BUTTON;
  octx.fillStyle = focused === FOCUS_REMATCH ? "#fff" : "#ccc";
  octx.fillText("Rematch", rematchX + btnW / 2, btnY + btnH / 2);

  // Menu button
  octx.fillStyle = focused === FOCUS_MENU ? "rgba(100,100,140,0.5)" : "rgba(100,100,140,0.2)";
  octx.fillRect(menuX, btnY, btnW, btnH);
  octx.strokeStyle = focused === FOCUS_MENU ? "#ccf" : "#99c";
  octx.lineWidth = focused === FOCUS_MENU ? 2 : 1;
  octx.strokeRect(menuX, btnY, btnW, btnH);
  octx.font = FONT_BUTTON;
  octx.fillStyle = focused === FOCUS_MENU ? "#fff" : "#ccc";
  octx.fillText("Menu", menuX + btnW / 2, btnY + btnH / 2);
}
/** Draw life-lost continue/abandon dialogs (one per player). */
export function drawLifeLostDialog(
  octx: CanvasRenderingContext2D,
  _W: number,
  _H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.lifeLostDialog) return;
  const dlg = overlay.ui.lifeLostDialog;

  const panelW = PANEL_W,
    panelH = PANEL_H;

  for (const entry of dlg.entries) {
    const { px, py } = entry;
    const c = entry.color;
    const cx = px + panelW / 2;

    // Panel background
    octx.fillStyle = PANEL_BG(0.9);
    octx.fillRect(px, py, panelW, panelH);
    octx.strokeStyle = rgb(c);
    octx.lineWidth = 2;
    octx.strokeRect(px + 1, py + 1, panelW - 2, panelH - 2);

    // Player name
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.font = FONT_BODY;
    octx.fillStyle = rgb(c);
    octx.fillText(entry.name, cx, py + 18);

    // Separator
    octx.fillStyle = GOLD;
    octx.fillRect(px + 10, py + 28, panelW - 20, 1);

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

    if (entry.choice === "pending" && entry.lives > 0) {
      // Continue / Abandon buttons with focus highlight
      const btnW = BTN_W,
        btnH = BTN_H;
      const btnY = py + panelH - btnH - 10;
      const contX = px + panelW / 2 - btnW - 5;
      const abX = px + panelW / 2 + 5;
      const contFocused = entry.focused === 0;
      const abFocused = entry.focused === 1;

      // Continue button
      const contFlash = contFocused && flashOn(BUTTON_FLASH_MS);
      octx.fillStyle = BTN_CONTINUE.fill(
        contFocused ? (contFlash ? 0.6 : 0.4) : 0.15,
      );
      octx.fillRect(contX, btnY, btnW, btnH);
      octx.strokeStyle = contFocused
        ? BTN_CONTINUE.strokeFocused
        : BTN_CONTINUE.stroke;
      octx.lineWidth = contFocused ? 2 : 1;
      octx.strokeRect(contX, btnY, btnW, btnH);
      octx.font = FONT_BUTTON;
      octx.fillStyle = contFocused ? "#fff" : TEXT_DISABLED;
      octx.fillText("Continue", contX + btnW / 2, btnY + btnH / 2);

      // Abandon button
      const abFlash = abFocused && flashOn(BUTTON_FLASH_MS);
      octx.fillStyle = BTN_ABANDON.fill(
        abFocused ? (abFlash ? 0.5 : 0.3) : 0.1,
      );
      octx.fillRect(abX, btnY, btnW, btnH);
      octx.strokeStyle = abFocused
        ? BTN_ABANDON.strokeFocused
        : BTN_ABANDON.stroke;
      octx.lineWidth = abFocused ? 2 : 1;
      octx.strokeRect(abX, btnY, btnW, btnH);
      octx.fillStyle = abFocused ? "#fff" : "#777";
      octx.fillText("Abandon", abX + btnW / 2, btnY + btnH / 2);
    } else {
      // Resolved state
      octx.font = FONT_LABEL;
      octx.fillStyle =
        entry.choice === "continue" ? BTN_CONTINUE.stroke : BTN_ABANDON.stroke;
      octx.fillText(
        entry.choice === "continue" ? "Continuing..." : "Abandoned",
        cx,
        py + panelH - 18,
      );
    }
  }
}
/** Draw the options screen. */
export function drawOptionsScreen(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.optionsScreen) return;
  const opts = overlay.ui.optionsScreen;

  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, 0, W, H);

  octx.textAlign = "center";
  octx.textBaseline = "middle";

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
      const flash = flashOn(BUTTON_FLASH_MS);
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
      opt.value + (showCursor ? (flashOn(CURSOR_BLINK_MS) ? "_" : " ") : "");
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
): void {
  if (!overlay?.ui?.controlsScreen) return;
  const ctrl = overlay.ui.controlsScreen;

  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, 0, W, H);

  octx.textAlign = "center";
  octx.textBaseline = "middle";

  // Title
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
          const flash = flashOn(REBIND_FLASH_MS);
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
/** Draw the player selection lobby screen. */
export function drawPlayerSelect(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.playerSelect) return;
  const selectData = overlay.ui.playerSelect;
  octx.fillStyle = PANEL_BG(0.95);
  octx.fillRect(0, 0, W, H);

  octx.textAlign = "center";
  octx.textBaseline = "middle";

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

    octx.fillStyle = rgb(c, 0.15);
    octx.fillRect(rx, rectY, rectW, rectH);
    octx.strokeStyle = rgb(c);
    octx.lineWidth = 2;
    octx.strokeRect(rx + 1, rectY + 1, rectW - 2, rectH - 2);

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
      octx.fillStyle = rgb(c, 0.3);
      octx.fillRect(btnX, btnY, btnW, btnH);
      octx.strokeStyle = rgb(c);
      octx.lineWidth = 1;
      octx.strokeRect(btnX, btnY, btnW, btnH);
      octx.font = touch ? FONT_BODY : FONT_BUTTON;
      octx.fillStyle = "#fff";
      octx.fillText("Please wait...", cx, btnY + btnH / 2);
    } else {
      const flash = flashOn(CURSOR_BLINK_MS);
      const alpha = flash ? 0.5 : 0.2;
      octx.fillStyle = rgb(c, alpha);
      octx.fillRect(btnX, btnY, btnW, btnH);
      octx.strokeStyle = rgb(c);
      octx.lineWidth = 1;
      octx.strokeRect(btnX, btnY, btnW, btnH);
      octx.font = touch ? FONT_LABEL : FONT_HINT;
      octx.fillStyle = flash ? "#fff" : "#aaa";
      octx.fillText(touch ? "Tap to join" : "Press button to start", cx, btnY + btnH / 2);
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
/** Compute lobby panel layout (shared by drawing and hit-testing). */
export function computeLobbyLayout(W: number, H: number, count: number) {
  const touch = IS_TOUCH_DEVICE;
  const gap = touch ? 8 : 12;
  const rectW = Math.round((W - gap * (count + 1)) / count);
  const rectH = Math.round(H * (touch ? 0.6 : 0.5));
  const rectY = Math.round(H * (touch ? 0.18 : 0.27));
  return { gap, rectW, rectH, rectY };
}
/** Returns true on even half of a repeating blink cycle. */
function flashOn(intervalMs: number): boolean {
  return Math.floor(Date.now() / intervalMs) % 2 === 0;
}
/** Draw text with a dark shadow offset by 1px. */
function drawShadowText(
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
