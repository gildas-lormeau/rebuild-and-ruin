/**
 * UI overlay rendering — announcement, banner, game over, player select.
 *
 * Time parameter convention: `now` is the frame timestamp from `performance.now()`,
 * threaded from drawMap. See render-effects.ts for the full convention.
 */

import { MODIFIER_ID } from "../shared/game-constants.ts";
import { GRID_COLS, TILE_SIZE } from "../shared/grid.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
} from "../shared/interaction-types.ts";
import {
  type GameOverOverlay,
  type RenderOverlay,
  type UpgradePickCard,
} from "../shared/overlay-types.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform.ts";
import { isPlayerEliminated } from "../shared/player-types.ts";
import type { RGB } from "../shared/theme.ts";
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
} from "../shared/theme.ts";
import {
  computeLobbyLayout,
  GAMEOVER_BTN_H,
  GAMEOVER_HEADER_H,
  GAMEOVER_ROW_H,
  gameOverLayout,
  lifeLostButtonLayout,
  SCOREBOARD_COL_RATIOS,
  UPGRADE_CARD_GAP,
  UPGRADE_CARD_H,
  UPGRADE_CARD_W,
  UPGRADE_NAME_H,
  UPGRADE_PICK_PULSE_DURATION,
  UPGRADE_ROW_GAP,
  UPGRADE_ROW_W,
} from "./render-composition.ts";
import {
  BG_BANNER,
  BG_OVERLAY,
  BTN_ABANDON,
  BTN_CONTINUE,
  BTN_MENU,
  beginModalScreen,
  drawButton,
  drawPanel,
  ELIMINATED_RED,
  INSET,
  INSET_X2,
  OP_ACCENT,
  OP_ACTIVE,
  OP_FOCUS,
  OP_GHOST,
  OP_IDLE,
  OP_SECONDARY,
  OP_SUBTLE,
  OP_VIVID,
  PAD,
  TEXT_DIM,
  TEXT_DISABLED,
  TEXT_FAINT,
  TEXT_LIGHT,
  TEXT_MUTED,
  TEXT_SOFT,
} from "./render-ui-theme.ts";

type ScoreEntry = GameOverOverlay["scores"][number];

// Modifier banner pulse timing (ms per full cycle)
const MODIFIER_PULSE_MS = 400;
// Modifier banner pulse: base alpha and amplitude
const MODIFIER_PULSE_BASE = 0.25;
const MODIFIER_PULSE_AMP = 0.3;

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

/** Highlight tiles affected by a modifier during the reveal banner.
 *  Tiles are revealed progressively as the banner sweeps past them. */
export function drawModifierRevealHighlight(
  overlayCtx: CanvasRenderingContext2D,
  H: number,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  const diff = overlay?.ui?.banner?.modifierDiff;
  if (!diff || diff.changedTiles.length === 0) return;

  const bannerY = overlay!.ui!.banner!.y;
  const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
  // Tiles above the banner top edge are fully revealed
  const revealY = bannerY - bannerH / 2;

  // Pulse alpha: 0.25–0.55 over 400ms
  const pulse =
    MODIFIER_PULSE_BASE +
    MODIFIER_PULSE_AMP *
      (0.5 + 0.5 * Math.sin((now / MODIFIER_PULSE_MS) * Math.PI * 2));

  const color =
    diff.id === MODIFIER_ID.WILDFIRE
      ? `rgba(255,100,20,${pulse})`
      : diff.id === MODIFIER_ID.FROZEN_RIVER
        ? `rgba(100,200,255,${pulse})`
        : diff.id === MODIFIER_ID.CRUMBLING_WALLS
          ? `rgba(180,140,80,${pulse})`
          : `rgba(255,255,100,${pulse})`;

  overlayCtx.fillStyle = color;
  for (const key of diff.changedTiles) {
    const row = Math.floor(key / GRID_COLS);
    const col = key % GRID_COLS;
    const py = row * TILE_SIZE;
    // Only highlight tiles that the banner has already swept past
    if (py + TILE_SIZE > revealY) continue;
    overlayCtx.fillRect(col * TILE_SIZE, py, TILE_SIZE, TILE_SIZE);
  }
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
  const statusBar = overlay.ui.statusBar;
  const barH = STATUSBAR_HEIGHT;
  const by = H - barH;

  overlayCtx.fillStyle = PANEL_BG(BG_OVERLAY);
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
  let leftText = `${statusBar.round}  ${statusBar.phase}  ${statusBar.timer}`;
  if (statusBar.modifier) leftText += `  \u26a0 ${statusBar.modifier}`;
  if (statusBar.upgrades && statusBar.upgrades.length > 0)
    leftText += `  \u2726 ${statusBar.upgrades.join(", ")}`;
  overlayCtx.fillText(leftText, PAD, cy);

  // Right: player stats
  overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
  let rx = W - PAD;
  for (let i = statusBar.players.length - 1; i >= 0; i--) {
    const player = statusBar.players[i]!;
    if (isPlayerEliminated(player)) continue;
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
  const layout = gameOverLayout(W, H, gameOverData.scores);
  const { panelW, panelH, px, py, btnW, btnY, rematchX, menuX } = layout;

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
  now: number = performance.now(),
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

/** Draw combo floating text (gold text that rises and fades out). */
export function drawComboFloats(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
): void {
  const floats = overlay?.ui?.comboFloats;
  if (!floats || floats.length === 0) return;

  overlayCtx.save();
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  overlayCtx.font = FONT_BODY;

  for (let i = 0; i < floats.length; i++) {
    const float = floats[i]!;
    const alpha = Math.max(0, 1 - float.age / 2);
    const rise = float.age * 20;
    overlayCtx.fillStyle = `rgba(255, 215, 100, ${alpha})`;
    overlayCtx.fillText(float.text, W / 2, H * 0.35 - rise + i * 16);
  }
  overlayCtx.restore();
}

/** Draw upgrade pick cards — one row of 3 cards per player, stacked vertically.
 *  When the banner is actively sweeping, the overlay is progressively revealed
 *  above the banner line (same visual language as modifier reveals). */
export function drawUpgradePick(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.ui?.upgradePick) return;
  const pick = overlay.ui.upgradePick;
  if (pick.entries.length === 0) return;

  // Progressive reveal: clip to above the banner sweep line
  const banner = overlay.ui?.banner;
  const duringBanner = !!banner;
  if (duringBanner) {
    const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
    const clipBottom = Math.round(banner.y - bannerH / 2);
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(0, 0, W, clipBottom);
    overlayCtx.clip();
  }

  // Semi-transparent backdrop
  overlayCtx.fillStyle = SHADOW_COLOR_HEAVY;
  overlayCtx.fillRect(0, 0, W, H);

  // Title
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  overlayCtx.font = FONT_TITLE;
  overlayCtx.fillStyle = GOLD_LIGHT;
  overlayCtx.fillText("CHOOSE UPGRADE", W / 2, H * 0.08);

  const time = now;
  const cardW = UPGRADE_CARD_W;
  const cardH = UPGRADE_CARD_H;
  const cardGap = UPGRADE_CARD_GAP;
  const rowGap = UPGRADE_ROW_GAP;
  const rowW = UPGRADE_ROW_W;
  const nameH = UPGRADE_NAME_H;
  const entryH = nameH + cardH + rowGap;

  const totalH = pick.entries.length * entryH - rowGap;
  const startY = Math.max(H * 0.14, (H - totalH - 30) / 2);

  for (let entryIdx = 0; entryIdx < pick.entries.length; entryIdx++) {
    const entry = pick.entries[entryIdx]!;
    const isInteractive = entry.interactive;
    const rowX = (W - rowW) / 2;
    const rowY = startY + entryIdx * entryH;

    // Player name
    overlayCtx.font = FONT_BODY;
    overlayCtx.fillStyle = rgb(entry.color);
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.fillText(entry.playerName, W / 2, rowY + nameH / 2);

    const cardsY = rowY + nameH;

    for (let cardIdx = 0; cardIdx < entry.cards.length; cardIdx++) {
      drawUpgradeCard(
        overlayCtx,
        entry.cards[cardIdx]!,
        rowX + cardIdx * (cardW + cardGap),
        cardsY,
        cardW,
        cardH,
        isInteractive,
        entry.color,
        time,
      );
    }
  }

  // Timer bar — only show when interactive (not during banner preview)
  if (!duringBanner) {
    const barW = rowW;
    const barH = 4;
    const barX = (W - rowW) / 2;
    const barY = startY + totalH + 10;
    const progress = Math.max(0, 1 - pick.timer / pick.maxTimer);
    overlayCtx.fillStyle = SHADOW_COLOR;
    overlayCtx.fillRect(barX, barY, barW, barH);
    overlayCtx.fillStyle = progress > 0.25 ? GOLD : ELIMINATED_RED;
    overlayCtx.fillRect(barX, barY, barW * progress, barH);
  }

  // Hint — only when interactive (not during banner preview)
  if (!duringBanner && pick.entries.some((entry) => entry.interactive)) {
    overlayCtx.font = FONT_HINT;
    overlayCtx.fillStyle = TEXT_DIM;
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.fillText(
      "\u2190 \u2192 to browse  |  Enter to pick",
      W / 2,
      H * 0.94,
    );
  }

  if (duringBanner) {
    overlayCtx.restore();
  }
}

/** Draw the player selection lobby screen. */
export function drawPlayerSelect(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay?: RenderOverlay,
  now: number = performance.now(),
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
    const nameFont = touch ? FONT_HEADING : FONT_BODY;
    const nameY = touch ? 34 : 30;
    const btnMarginX = touch ? 6 : 8;
    const btnMarginBottom = touch ? 8 : 12;
    const btnW = rectW - btnMarginX * 2;
    const btnH = touch ? 36 : 24;
    const btnX = rx + btnMarginX;
    const btnY = rectY + rectH - btnH - btnMarginBottom;
    overlayCtx.font = nameFont;
    overlayCtx.fillStyle = rgb(c);
    overlayCtx.fillText(player.name, cx, rectY + nameY);

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
      const flash = flashOn(CURSOR_BLINK_MS, now);
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
  const colNameX = px + INSET;
  const colScoreX = px + panelW * SCOREBOARD_COL_RATIOS[0];
  const colWallsX = px + panelW * SCOREBOARD_COL_RATIOS[1];
  const colCannonsX = px + panelW * SCOREBOARD_COL_RATIOS[2];
  const colTerritoryX = px + panelW * SCOREBOARD_COL_RATIOS[3];

  if (hasStats) {
    overlayCtx.font = FONT_FLOAT_XS;
    overlayCtx.fillStyle = TEXT_MUTED;
    overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
    overlayCtx.fillText("Score", colScoreX, tableTop + PAD);
    overlayCtx.fillText("Walls", colWallsX, tableTop + PAD);
    overlayCtx.fillText("Cannons", colCannonsX, tableTop + PAD);
    overlayCtx.fillText("Land", colTerritoryX, tableTop + PAD);
  }

  overlayCtx.font = FONT_LABEL;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const y = tableTop + statsH + INSET + i * GAMEOVER_ROW_H;
    const c = entry.color;
    const alpha = isPlayerEliminated(entry) ? OP_ACCENT : 1;
    overlayCtx.fillStyle = rgb(c, alpha);
    overlayCtx.textAlign = TEXT_ALIGN_LEFT;
    overlayCtx.fillText(entry.name, colNameX, y);
    overlayCtx.textAlign = TEXT_ALIGN_RIGHT;
    overlayCtx.fillText(`${entry.score}`, colScoreX, y);
    if (entry.stats) {
      overlayCtx.fillStyle = rgb(c, alpha * OP_SECONDARY);
      overlayCtx.fillText(`${entry.stats.wallsDestroyed}`, colWallsX, y);
      overlayCtx.fillText(`${entry.stats.cannonsKilled}`, colCannonsX, y);
      overlayCtx.fillText(`${entry.territory ?? 0}`, colTerritoryX, y);
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

/** Draw a single player's life-lost entry: choice buttons (pending) or resolved text. */
function drawLifeLostEntry(
  ctx: CanvasRenderingContext2D,
  entry: {
    readonly lives: number;
    readonly choice: LifeLostChoice;
    readonly focusedButton: number;
    readonly px: number;
    readonly py: number;
  },
  px: number,
  py: number,
  cx: number,
  now: number = performance.now(),
): void {
  if (entry.choice === LifeLostChoice.PENDING && entry.lives > 0) {
    // Continue / Abandon buttons with focus highlight
    const btnW = BTN_W;
    const btnH = BTN_H;
    const { btnY, contX, abX } = lifeLostButtonLayout(px, py);
    const contFocused = entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE;
    const abFocused = entry.focusedButton === LIFE_LOST_FOCUS_ABANDON;

    // Continue button
    const time = now;
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

/** Draw a single upgrade card: background, focus indicator, category, name,
 *  word-wrapped description, and picked checkmark. */
function drawUpgradeCard(
  ctx: CanvasRenderingContext2D,
  card: UpgradePickCard,
  cx: number,
  cy: number,
  cardW: number,
  cardH: number,
  isInteractive: boolean,
  playerColor: RGB,
  time: number,
): void {
  const isFocused =
    isInteractive && card.focused && flashOn(BUTTON_FLASH_MS, time);
  const pulseFrac =
    card.pulseAge > 0 && card.pulseAge < UPGRADE_PICK_PULSE_DURATION
      ? 1 - card.pulseAge / UPGRADE_PICK_PULSE_DURATION
      : 0;
  const borderColor = card.picked
    ? rgb(playerColor)
    : card.focused && isInteractive
      ? GOLD
      : SHADOW_COLOR;
  drawPanel(
    ctx,
    cx,
    cy,
    cardW,
    cardH,
    card.picked ? GOLD_BG(OP_ACTIVE) : PANEL_BG(BG_OVERLAY),
    borderColor,
  );

  if (isFocused) {
    ctx.strokeStyle = GOLD_LIGHT;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 1, cy - 1, cardW + 2, cardH + 2);
  }

  if (pulseFrac > 0) {
    ctx.save();
    ctx.globalAlpha = pulseFrac;
    ctx.strokeStyle = rgb(playerColor);
    ctx.lineWidth = 2 + 5 * pulseFrac;
    const inset = 2 + 6 * pulseFrac;
    ctx.strokeRect(
      cx - inset,
      cy - inset,
      cardW + inset * 2,
      cardH + inset * 2,
    );
    ctx.restore();
  }

  const cardCx = cx + cardW / 2;

  // Category badge
  ctx.font = FONT_SMALL;
  ctx.fillStyle = TEXT_DIM;
  ctx.textAlign = TEXT_ALIGN_CENTER;
  ctx.fillText(card.category.toUpperCase(), cardCx, cy + 12);

  // Upgrade name
  ctx.font = FONT_BODY;
  ctx.fillStyle = card.focused || card.picked ? TEXT_WHITE : GOLD_LIGHT;
  ctx.fillText(card.label, cardCx, cy + 30);

  // Description (word-wrapped)
  ctx.font = FONT_SMALL;
  ctx.fillStyle = card.focused ? GOLD_LIGHT : TEXT_MUTED;
  const maxTextW = cardW - INSET_X2;
  const words = card.description.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxTextW) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    ctx.fillText(lines[lineIdx]!, cardCx, cy + 46 + lineIdx * 12);
  }

  // Checkmark for picked card
  if (card.picked) {
    ctx.font = FONT_BODY;
    ctx.fillStyle = rgb(playerColor);
    ctx.fillText("\u2713", cardCx, cy + cardH - 10);
  }
}
