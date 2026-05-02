import {
  type ModifierId,
  UPGRADE_PICK_PULSE_DURATION,
} from "../shared/core/game-constants.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../shared/core/grid.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { towerCenterPx } from "../shared/core/spatial.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform/platform.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
} from "../shared/ui/interaction-types.ts";
import {
  type GameOverOverlay,
  type RenderOverlay,
  type UpgradePickCard,
} from "../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../shared/ui/player-config.ts";
import {
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
  type RGB,
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
  TOWER_FLASH_MS,
} from "../shared/ui/theme.ts";
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

// Lockout timer pulse color (Master Builder upgrade) and cycle length.
const LOCKOUT_AMBER = "rgba(255,180,50,1)";
const LOCKOUT_PULSE_MS = 300;
/** Per-modifier banner colors. `title` lights the headline, `border`
 *  the top/bottom rules. Tuned so phase banners (gold) stay clearly
 *  distinct from a modifier reveal. The reveal-time tile pulse
 *  previously driven from this map moved to per-modifier 3D burst
 *  managers in src/render/3d/effects/. */
const MODIFIER_COLORS: Record<ModifierId, { title: string; border: string }> = {
  wildfire: { title: "#ff8040", border: "#ff5010" },
  crumbling_walls: { title: "#d0a060", border: "#a07030" },
  grunt_surge: { title: "#ff6060", border: "#c02020" },
  frozen_river: { title: "#80d0ff", border: "#4090d0" },
  sinkhole: { title: "#d0a070", border: "#704020" },
  high_tide: { title: "#60b0ff", border: "#2060c0" },
  dust_storm: { title: "#e0c070", border: "#a07020" },
  rubble_clearing: { title: "#90d080", border: "#408030" },
  low_water: { title: "#a0d8b0", border: "#508060" },
  dry_lightning: { title: "#ffe080", border: "#c0a030" },
  fog_of_war: { title: "#c8d0d8", border: "#6c7480" },
  frostbite: { title: "#b8e8ff", border: "#5098c8" },
  sapper: { title: "#c89878", border: "#785838" },
};

/** Draw announcement text centered on screen. */
/** Countdown timer shown at the map junction during non-battle phases.
 *  Pulses amber when Master Builder lockout is active. */
export function drawPhaseTimer(
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (overlay?.ui?.timer == null || overlay.ui.timer < 0) return;
  const secs = Math.max(0, Math.ceil(overlay.ui.timer) - 1);
  const text = `${secs}`;
  const jx = map.junction.x * TILE_SIZE + TILE_SIZE / 2;
  const jy = map.junction.y * TILE_SIZE + TILE_SIZE / 2;
  const lockout = overlay.ui.masterBuilderLockout ?? 0;
  overlayCtx.save();
  overlayCtx.font = FONT_TIMER;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  if (lockout > 0) {
    const pulse = 1.0 + 0.15 * Math.abs(Math.sin(now / LOCKOUT_PULSE_MS));
    overlayCtx.translate(jx, jy);
    overlayCtx.scale(pulse, pulse);
    drawShadowText(overlayCtx, text, 0, 0, SHADOW_COLOR, LOCKOUT_AMBER);
  } else {
    drawShadowText(overlayCtx, text, jx, jy, SHADOW_COLOR, TEXT_WHITE);
  }
  overlayCtx.restore();
}

/** Draw the corner-bracket selection cursor(s) around towers during
 *  CASTLE_SELECT / CASTLE_RESELECT. Rendered on the 2D overlay regardless
 *  of whether the 3D renderer is drawing live tower meshes — castle
 *  selection is a top-down phase, so the 2D bracket aligns perfectly on
 *  top of the 3D towers. */
export function drawSelectionCursor(
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (!overlay?.selection) return;
  const highlighted = overlay.selection.highlighted;
  const highlights = overlay.selection.highlights;
  if (highlighted == null && (!highlights || highlights.length === 0)) return;
  for (let i = 0; i < map.towers.length; i++) {
    const tower = map.towers[i]!;
    const { x: cx, y: cy } = towerCenterPx(tower);
    if (highlighted === i) {
      drawTowerHighlight(overlayCtx, cx, cy, undefined, now);
    }
    if (highlights) {
      for (const highlight of highlights) {
        if (highlight.towerIdx === i) {
          const c = getPlayerColor(highlight.playerId).interiorLight;
          drawTowerHighlight(overlayCtx, cx, cy, rgb(c), now);
        }
      }
    }
  }
}

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

/** Draw phase transition banner sweeping across the screen.
 *  A modifier reveal banner recolors the title and top/bottom rules with
 *  the modifier's palette so players can distinguish it from an ordinary
 *  phase banner at a glance. */
export function drawBanner(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.banner) return;
  const { top: by, bottom } = overlay.ui.banner;
  const bannerH = bottom - by;
  const paletteKey = overlay.ui.banner.paletteKey;
  const palette = paletteKey
    ? MODIFIER_COLORS[paletteKey as keyof typeof MODIFIER_COLORS]
    : undefined;
  const borderColor = palette?.border ?? GOLD;
  const titleColor = palette?.title ?? GOLD_LIGHT;
  const subtitleColor = palette?.title ?? GOLD_SUBTITLE;
  overlayCtx.fillStyle = PANEL_BG(BG_BANNER);
  overlayCtx.fillRect(0, by, W, bannerH);
  overlayCtx.fillStyle = borderColor;
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
    titleColor,
  );
  if (hasSubtitle) {
    overlayCtx.font = FONT_FLOAT_SM;
    overlayCtx.fillStyle = subtitleColor;
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

/** Draw status bar in the reserved top safe margin of the canvas. */
export function drawStatusBar(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.ui?.statusBar) return;
  const statusBar = overlay.ui.statusBar;
  const barH = STATUSBAR_HEIGHT;
  const by = 0;

  overlayCtx.fillStyle = PANEL_BG(BG_OVERLAY);
  overlayCtx.fillRect(0, by, W, barH);
  overlayCtx.fillStyle = GOLD_BG(OP_ACCENT);
  overlayCtx.fillRect(0, by + barH - 1, W, 1);

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
    if (entry.lives <= 0) {
      overlayCtx.fillStyle = ELIMINATED_RED;
      overlayCtx.fillText("Eliminated", cx, py + 40);
    } else if (entry.choice === LifeLostChoice.ABANDON) {
      overlayCtx.fillStyle = ELIMINATED_RED;
      overlayCtx.fillText("Abandoned", cx, py + 40);
    } else {
      overlayCtx.fillStyle = GOLD_LIGHT;
      overlayCtx.fillText(
        `${entry.lives} ${entry.lives === 1 ? "life" : "lives"} left`,
        cx,
        py + 40,
      );
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

  // Progressive-reveal clip is pre-computed by the overlay builder; the
  // renderer is pure geometry here.
  const mask = pick.fadeMask;
  if (mask) {
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(0, mask.rectTop, W, mask.rectBottom - mask.rectTop);
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
  if (!mask) {
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
  if (!mask && pick.entries.some((entry) => entry.interactive)) {
    overlayCtx.font = FONT_HINT;
    overlayCtx.fillStyle = TEXT_DIM;
    overlayCtx.textAlign = TEXT_ALIGN_CENTER;
    overlayCtx.fillText(
      "\u2190 \u2192 to browse  |  Enter to pick",
      W / 2,
      H * 0.94,
    );
  }

  if (mask) {
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

/** Draw a corner-bracket selector around a tower position. */
function drawTowerHighlight(
  overlayCtx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string | undefined,
  now: number,
): void {
  const margin = 4 + TILE_SIZE / 2;
  const bx = cx - 15 - margin;
  const by = cy - 16 - margin;
  const w = 30 + margin * 2;
  const h = 32 + margin * 2;
  const corner = 10;
  const thickness = 4;
  const flash = 0.7 + 0.3 * Math.sin(now / TOWER_FLASH_MS);
  overlayCtx.save();
  overlayCtx.globalAlpha = flash;
  overlayCtx.fillStyle = color ?? "#ffcc00";
  // Top-left
  overlayCtx.fillRect(bx, by, corner, thickness);
  overlayCtx.fillRect(bx, by + thickness, thickness, corner - thickness);
  // Top-right
  overlayCtx.fillRect(bx + w - corner, by, corner, thickness);
  overlayCtx.fillRect(
    bx + w - thickness,
    by + thickness,
    thickness,
    corner - thickness,
  );
  // Bottom-left
  overlayCtx.fillRect(bx, by + h - thickness, corner, thickness);
  overlayCtx.fillRect(bx, by + h - corner, thickness, corner - thickness);
  // Bottom-right
  overlayCtx.fillRect(bx + w - corner, by + h - thickness, corner, thickness);
  overlayCtx.fillRect(
    bx + w - thickness,
    by + h - corner,
    thickness,
    corner - thickness,
  );
  overlayCtx.restore();
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
  } else if (entry.choice === LifeLostChoice.CONTINUE && entry.lives > 0) {
    // Resolved CONTINUE — ABANDON/eliminated label is already rendered at top
    ctx.font = FONT_LABEL;
    ctx.fillStyle = BTN_CONTINUE.stroke;
    ctx.fillText("Continuing...", cx, py + PANEL_H - 18);
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
  // Focus border: GOLD for the interactive local player (paired with the
  // flashing outline below), player color for AI entries cycling through
  // their offers during the auto-pick delay.
  const borderColor = card.picked
    ? rgb(playerColor)
    : card.focused
      ? isInteractive
        ? GOLD
        : rgb(playerColor)
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
