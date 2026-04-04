/**
 * Overlay composition, layout, and hit-test utilities.
 *
 * Parameter convention: functions with ≤3 closely-related args use positional
 * parameters; functions with >3 args or heterogeneous config use a `params`
 * object for readability at the call site.
 *
 * Coordinate spaces (parameter naming convention across all render-* files):
 *   - screenX / screenY — raw canvas pixels (CSS × devicePixelRatio)
 *   - tileX / tileY    — game-grid tile indices (after ÷ TILE_SIZE)
 *   - overlayCtx       — canvas 2D context for overlay drawing
 */

import type { BannerState } from "../game/phase-banner.ts";
import { UPGRADE_PICK_MAX_TIMER } from "../game/upgrade-pick.ts";
import type { Impact } from "../shared/battle-types.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
  type UpgradePickDialogState,
} from "../shared/dialog-types.ts";
import {
  LIFE_LOST_MAX_TIMER,
  modifierLabel,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { RGB } from "../shared/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
  TILE_SIZE,
} from "../shared/grid.ts";
import {
  type CastleData,
  type GameOverOverlay,
  type LifeLostDialogOverlay,
  type RenderOverlay,
  type UpgradePickOverlay,
} from "../shared/overlay-types.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  BANNER_HEIGHT_RATIO,
  LIFE_LOST_BTN_H as BTN_H,
  LIFE_LOST_BTN_W as BTN_W,
  LOBBY_RECT_H_RATIO,
  LOBBY_RECT_H_RATIO_TOUCH,
  LOBBY_RECT_Y_RATIO,
  LOBBY_RECT_Y_RATIO_TOUCH,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_PANEL_W as PANEL_W,
} from "../shared/theme.ts";
import { type GameState, type SelectionState } from "../shared/types.ts";
import { UPGRADE_POOL } from "../shared/upgrade-defs.ts";

/** Result of a lobby click hit-test. */
export type LobbyHit =
  | { type: "gear" }
  | { type: "slot"; slotId: ValidPlayerSlot };

interface GameOverLayout {
  panelW: number;
  panelH: number;
  px: number;
  py: number;
  btnW: number;
  btnY: number;
  rematchX: number;
  menuX: number;
}

export type CreateBannerUiFn = (
  active: boolean,
  text: string,
  progress: number,
  subtitle?: string,
) => { text: string; subtitle?: string; y: number } | undefined;

export type CreateOnlineOverlayFn = (
  params: OnlineOverlayParams,
) => RenderOverlay;

/** Parameter object for createOnlineOverlay — extracted so consumers can import the type. */
export interface OnlineOverlayParams {
  previousSelection: RenderOverlay["selection"];
  state: GameState;
  banner: Pick<
    BannerState,
    | "active"
    | "prevCastles"
    | "prevTerritory"
    | "prevWalls"
    | "prevEntities"
    | "newTerritory"
    | "newWalls"
    | "wallsBeforeSweep"
  >;
  battleAnim: {
    territory: Set<number>[];
    walls: Set<number>[];
    flights: ReadonlyArray<{
      flight: { startX: number; startY: number; endX: number; endY: number };
      progress: number;
    }>;
    impacts: Impact[];
  };
  frame: {
    crosshairs: Array<{
      x: number;
      y: number;
      playerId: ValidPlayerSlot;
      cannonReady?: boolean;
    }>;
    phantoms: RenderOverlay["phantoms"];
    announcement?: string;
    gameOver?: GameOverOverlay;
  };
  bannerUi?: { text: string; subtitle?: string; y: number };
  lifeLostDialog: LifeLostDialogState | null;
  upgradePickDialog: UpgradePickDialogState | null;
  inBattle: boolean;
  povPlayerId: ValidPlayerSlot;
  hasPointerPlayer: boolean;
  upgradePickInteractiveId: PlayerSlotId;
  playerNames: ReadonlyArray<string>;
  playerColors: ReadonlyArray<{ wall: RGB }>;
  getLifeLostPanelPos: (playerId: ValidPlayerSlot) => {
    px: number;
    py: number;
  };
}

export type CreateRenderSummaryMessageFn = (params: {
  phaseName: string;
  timer: number;
  crosshairs: Array<{ x: number; y: number; playerId: ValidPlayerSlot }>;
  piecePhantomsCount: number;
  cannonPhantomsCount: number;
  impactsCount: number;
  cannonballsCount: number;
  selectionHighlights?: Array<{
    playerId: ValidPlayerSlot;
    towerIdx: number;
    confirmed?: boolean;
  }>;
}) => string;

export type CreateStatusBarFn = (
  state: GameState,
  playerColors: readonly { interiorLight: RGB }[],
  povPlayerId?: number,
  hasPointerPlayer?: boolean,
) => {
  round: string;
  phase: string;
  timer: string;
  modifier: string | undefined;
  upgrades: string[] | undefined;
  players: {
    score: number;
    cannons: number;
    lives: number;
    color: RGB;
    eliminated: boolean;
  }[];
};

export type ComputeLobbyLayoutFn = (
  W: number,
  H: number,
  count: number,
) => { gap: number; rectW: number; rectH: number; rectY: number };

export type LobbyClickHitTestFn = (params: {
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  tileSize: number;
  slotCount: number;
  computeLayout: (
    W: number,
    H: number,
    count: number,
  ) => { gap: number; rectW: number; rectH: number; rectY: number };
}) => LobbyHit | null;

const PHASE_LABELS = new Map<Phase, string>([
  [Phase.CASTLE_SELECT, "Select"],
  [Phase.CASTLE_RESELECT, "Select"],
  [Phase.WALL_BUILD, "Build"],
  [Phase.CANNON_PLACE, "Cannons"],
  [Phase.BATTLE, "Battle"],
]);
const GAMEOVER_PANEL_W_RATIO = 0.65;
const SETTINGS_GEAR_X = MAP_PX_W - 32;
const SETTINGS_GEAR_Y = 4;
const SETTINGS_GEAR_SIZE = 28;
const UPGRADE_CARDS_PER_ROW = 3;
const UPGRADE_NAME_H = 18;
export const UPGRADE_ROW_GAP = 8;
/** Per-player snapshot of previous interior, used to detect newly enclosed tiles. */
export const GAMEOVER_ROW_H = 14;
export const GAMEOVER_HEADER_H = 36;
export const GAMEOVER_BTN_H = 20;
/** Scoreboard column X positions as ratios of panel width: Score, Walls, Cannons, Territory. */
export const SCOREBOARD_COL_RATIOS = [0.38, 0.56, 0.74, 0.92] as const;
/** Card layout constants — must match drawUpgradePick in render-ui.ts. */
export const UPGRADE_CARD_W = 120;
export const UPGRADE_CARD_H = 100;
export const UPGRADE_CARD_GAP = 10;
const UPGRADE_ROW_W =
  UPGRADE_CARDS_PER_ROW * UPGRADE_CARD_W +
  (UPGRADE_CARDS_PER_ROW - 1) * UPGRADE_CARD_GAP;

export function createRenderSummaryMessage(params: {
  phaseName: string;
  timer: number;
  crosshairs: Array<{ x: number; y: number; playerId: ValidPlayerSlot }>;
  piecePhantomsCount: number;
  cannonPhantomsCount: number;
  impactsCount: number;
  cannonballsCount: number;
  selectionHighlights?: Array<{
    playerId: ValidPlayerSlot;
    towerIdx: number;
    confirmed?: boolean;
  }>;
}): string {
  const {
    phaseName,
    timer,
    crosshairs,
    piecePhantomsCount,
    cannonPhantomsCount,
    impactsCount,
    cannonballsCount,
    selectionHighlights,
  } = params;

  const crosshairDetail = crosshairs
    .map((c) => `P${c.playerId}(${Math.round(c.x)},${Math.round(c.y)})`)
    .join(",");
  const phantomCount = piecePhantomsCount + cannonPhantomsCount;
  const selectionDetail = selectionHighlights
    ? ` sel=[${selectionHighlights.map((h) => `P${h.playerId}:T${h.towerIdx}${h.confirmed ? "✓" : ""}`).join(",")}]`
    : "";

  return `render: phase=${phaseName} ch=${crosshairs.length}[${crosshairDetail}] phantoms=${phantomCount} impacts=${impactsCount} balls=${cannonballsCount} timer=${timer.toFixed(0)}${selectionDetail}`;
}

export function createBannerUi(
  active: boolean,
  text: string,
  progress: number,
  subtitle?: string,
): { text: string; subtitle?: string; y: number } | undefined {
  if (!active) return undefined;
  const h = MAP_PX_H;
  const bannerH = h * BANNER_HEIGHT_RATIO;
  const startY = -bannerH / 2;
  const endY = h + bannerH / 2;
  return {
    text,
    subtitle,
    y: startY + progress * (endY - startY),
  };
}

export function createStatusBar(
  state: GameState,
  playerColors: readonly { interiorLight: RGB }[],
  povPlayerId?: number,
  hasPointerPlayer?: boolean,
) {
  // Modifier label (modern mode only)
  const modifier = state.modern?.activeModifier
    ? modifierLabel(state.modern.activeModifier)
    : undefined;

  // POV player's active upgrade labels (skip when no human is playing)
  let upgrades: string[] | undefined;
  if (hasPointerPlayer && povPlayerId !== undefined && povPlayerId >= 0) {
    const player = state.players[povPlayerId];
    if (player && player.upgrades.size > 0) {
      upgrades = [];
      for (const [id, count] of player.upgrades) {
        const def = UPGRADE_POOL.find((up) => up.id === id);
        const label = def?.label ?? id;
        upgrades.push(count > 1 ? `${label} x${count}` : label);
      }
    }
  }

  return {
    round:
      state.maxRounds === Infinity
        ? `R${state.round}`
        : `R${state.round}/${state.maxRounds}`,
    phase: PHASE_LABELS.get(state.phase) ?? "",
    timer: state.timer > 0 ? `${Math.ceil(state.timer)}s` : "",
    modifier,
    upgrades,
    players: state.players.map((player, i) => ({
      score: player.score,
      cannons: player.cannons.filter((c) => c.hp > 0).length,
      lives: player.lives,
      color: playerColors[i % playerColors.length]!.interiorLight,
      eliminated: player.eliminated,
    })),
  };
}

/** Writes selection highlights into overlay.selection (mutates in-place).
 *  @param visiblePlayers — set of player IDs whose highlights should be shown.
 *  If omitted, all unconfirmed players are shown. */
export function updateSelectionOverlay(
  overlay: RenderOverlay,
  selectionStates: Map<number, SelectionState>,
  visiblePlayers?: ReadonlySet<number>,
): void {
  if (!overlay.selection) {
    overlay.selection = { highlighted: null, selected: null };
  }
  overlay.selection.highlights = [];
  for (const [pid, selectionState] of selectionStates) {
    if (selectionState.confirmed) continue;
    if (visiblePlayers && !visiblePlayers.has(pid)) continue;
    overlay.selection.highlights.push({
      towerIdx: selectionState.highlighted,
      playerId: pid as ValidPlayerSlot,
      confirmed: false,
    });
  }
}

export function handleLifeLostDialogClick(params: {
  state: GameState;
  lifeLostDialog: LifeLostDialogState;
  /** Canvas-pixel X coordinate (divided by SCALE internally for game-space hit testing). */
  screenX: number;
  /** Canvas-pixel Y coordinate (divided by SCALE internally for game-space hit testing). */
  screenY: number;
}): { playerId: ValidPlayerSlot; choice: ResolvedChoice } | null {
  const { state, lifeLostDialog, screenX, screenY } = params;

  const gameX = screenX / SCALE;
  const gameY = screenY / SCALE;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING) continue;

    const { px, py } = lifeLostPanelPos(state, entry.playerId);
    const { btnY, contX, abX } = lifeLostButtonLayout(px, py);

    if (
      gameX >= contX &&
      gameX <= contX + BTN_W &&
      gameY >= btnY &&
      gameY <= btnY + BTN_H
    ) {
      return { playerId: entry.playerId, choice: LifeLostChoice.CONTINUE };
    }

    if (
      gameX >= abX &&
      gameX <= abX + BTN_W &&
      gameY >= btnY &&
      gameY <= btnY + BTN_H
    ) {
      return { playerId: entry.playerId, choice: LifeLostChoice.ABANDON };
    }
  }

  return null;
}

export function lifeLostButtonLayout(
  px: number,
  py: number,
): {
  btnY: number;
  contX: number;
  abX: number;
} {
  return {
    btnY: py + PANEL_H - BTN_H - 10,
    contX: px + PANEL_W / 2 - BTN_W - 5,
    abX: px + PANEL_W / 2 + 5,
  };
}

/** Pure spatial hit-test for upgrade pick cards.
 *  Returns the playerId and card index of the clicked card, or null. */
export function handleUpgradePickClick(params: {
  W: number;
  H: number;
  dialog: UpgradePickDialogState;
  screenX: number;
  screenY: number;
}): { playerId: ValidPlayerSlot; cardIdx: number } | null {
  const { W, H, dialog, screenX, screenY } = params;
  const entryH = upgradePickEntryH();
  const startY = upgradePickStartY(H, dialog.entries.length);
  const rowX = (W - UPGRADE_ROW_W) / 2;

  for (let ei = 0; ei < dialog.entries.length; ei++) {
    const entry = dialog.entries[ei]!;
    if (entry.choice !== null) continue;
    const cardsY = startY + ei * entryH + UPGRADE_NAME_H;

    for (let ci = 0; ci < UPGRADE_CARDS_PER_ROW; ci++) {
      const cx = rowX + ci * (UPGRADE_CARD_W + UPGRADE_CARD_GAP);
      if (
        screenX >= cx &&
        screenX <= cx + UPGRADE_CARD_W &&
        screenY >= cardsY &&
        screenY <= cardsY + UPGRADE_CARD_H
      ) {
        return { playerId: entry.playerId, cardIdx: ci };
      }
    }
  }
  return null;
}

/** Position the life-lost dialog panel centered over the player's zone towers.
 *  Falls back to the map center if no zone towers exist.
 *  Result is clamped to keep the panel 2px inside the tile-space edges. */
export function lifeLostPanelPos(
  state: GameState,
  playerId: ValidPlayerSlot,
): { px: number; py: number } {
  const zone = state.playerZones[playerId] ?? 0;
  const zoneTowers = state.map.towers.filter((tower) => tower.zone === zone);
  // Tower centroid (+1 offset for 2×2 tower center), or map center as fallback
  const cx =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((sum, tower) => sum + tower.col, 0) /
          zoneTowers.length +
          1) *
        TILE_SIZE
      : MAP_PX_W / 2;
  const cy =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((sum, tower) => sum + tower.row, 0) /
          zoneTowers.length +
          1) *
        TILE_SIZE
      : MAP_PX_H / 2;

  return {
    px: Math.max(
      2,
      Math.min(MAP_PX_W - PANEL_W - 2, Math.round(cx - PANEL_W / 2)),
    ),
    py: Math.max(
      2,
      Math.min(MAP_PX_H - PANEL_H - 2, Math.round(cy - PANEL_H / 2)),
    ),
  };
}

export function createOnlineOverlay(
  params: OnlineOverlayParams,
): RenderOverlay {
  const {
    previousSelection,
    state,
    banner,
    battleAnim,
    frame,
    bannerUi,
    inBattle,
    lifeLostDialog,
    upgradePickDialog,
    povPlayerId,
    hasPointerPlayer,
    upgradePickInteractiveId,
    playerNames,
    playerColors,
    getLifeLostPanelPos,
  } = params;

  const homeTowers = buildHomeTowersByIndex(state);
  const battleTerritory =
    banner.active && banner.newTerritory
      ? banner.newTerritory
      : inBattle
        ? battleAnim.territory
        : undefined;
  const battleWalls =
    banner.active && banner.newTerritory
      ? banner.newWalls
      : inBattle
        ? battleAnim.walls
        : undefined;

  return {
    selection: previousSelection,
    castles: buildCastleOverlay(state, banner.wallsBeforeSweep),
    entities: {
      houses: state.map.houses,
      grunts: state.grunts,
      towerAlive: state.towerAlive,
      burningPits: state.burningPits,
      bonusSquares: state.bonusSquares,
      homeTowers: homeTowers.size > 0 ? homeTowers : undefined,
      frozenTiles: state.modern?.frozenTiles ?? undefined,
    },
    battle: {
      inBattle: !!battleTerritory,
      battleTerritory,
      battleWalls,
      cannonballs: buildBattleCannonballsPayload(inBattle, state.cannonballs),
      impacts: inBattle ? battleAnim.impacts : undefined,
      crosshairs: inBattle ? frame.crosshairs : undefined,
      balloons: buildBattleBalloonsPayload(battleAnim.flights),
    },
    phantoms: frame.phantoms,
    ui: {
      timer:
        !inBattle && !banner.active && state.timer > 0
          ? state.timer
          : undefined,
      banner: bannerUi,
      bannerPrevCastles: banner.active ? banner.prevCastles : undefined,
      bannerPrevBattleTerritory: banner.active
        ? banner.prevTerritory
        : undefined,
      bannerPrevBattleWalls: banner.active ? banner.prevWalls : undefined,
      bannerPrevEntities: banner.active ? banner.prevEntities : undefined,
      announcement: frame.announcement,
      gameOver: frame.gameOver,
      lifeLostDialog: buildLifeLostDialogUi(
        lifeLostDialog,
        playerNames,
        playerColors,
        LIFE_LOST_MAX_TIMER,
        getLifeLostPanelPos,
      ),
      comboFloats: hasPointerPlayer
        ? povPlayerId < 0
          ? state.modern?.comboTracker?.events
          : state.modern?.comboTracker?.events.filter(
              (ev) => ev.playerId === povPlayerId,
            )
        : undefined,
      upgradePick: buildUpgradePickUi(
        upgradePickDialog,
        upgradePickInteractiveId,
        playerNames,
        playerColors,
      ),
    },
  };
}

/** Hit-test the game-over Rematch / Menu buttons. Coordinates in tile-pixel space. */
export function gameOverButtonHitTest(
  tileX: number,
  tileY: number,
  W: number,
  H: number,
  gameOver: GameOverOverlay,
): GameOverFocus | null {
  const { btnW, btnY, rematchX, menuX } = gameOverLayout(W, H, gameOver.scores);

  if (
    tileX >= rematchX &&
    tileX <= rematchX + btnW &&
    tileY >= btnY &&
    tileY <= btnY + GAMEOVER_BTN_H
  ) {
    return FOCUS_REMATCH;
  }
  if (
    tileX >= menuX &&
    tileX <= menuX + btnW &&
    tileY >= btnY &&
    tileY <= btnY + GAMEOVER_BTN_H
  ) {
    return FOCUS_MENU;
  }
  return null;
}

export function gameOverLayout(
  W: number,
  H: number,
  scores: GameOverOverlay["scores"],
): GameOverLayout {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const hasStats = sorted.some((e) => e.stats);
  const statsH = hasStats ? GAMEOVER_ROW_H : 0;
  const tableH = sorted.length * GAMEOVER_ROW_H + statsH;
  const panelW = Math.round(W * GAMEOVER_PANEL_W_RATIO);
  const panelH = GAMEOVER_HEADER_H + tableH + 16 + GAMEOVER_BTN_H + 12;
  const px = Math.round((W - panelW) / 2);
  const py = Math.round((H - panelH) / 2);
  const btnW = Math.round((panelW - 30) / 2);
  return {
    panelW,
    panelH,
    px,
    py,
    btnW,
    btnY: py + panelH - GAMEOVER_BTN_H - 10,
    rematchX: px + 10,
    menuX: px + panelW - 10 - btnW,
  };
}

/**
 * Hit-test a lobby click against player panels and gear button.
 * Returns { type: "gear" } for gear click, { type: "slot", slotId }
 * for a player slot click, or null if nothing was hit.
 */
export function lobbyClickHitTest(params: {
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  tileSize: number;
  slotCount: number;
  computeLayout: (
    tsW: number,
    tsH: number,
    count: number,
  ) => { gap: number; rectW: number; rectH: number; rectY: number };
}): LobbyHit | null {
  const {
    canvasX,
    canvasY,
    canvasW,
    canvasH,
    tileSize,
    slotCount,
    computeLayout,
  } = params;

  const tsW = GRID_COLS * tileSize;
  const tsH = GRID_ROWS * tileSize;
  const x = canvasX * (tsW / canvasW);
  const y = canvasY * (tsH / canvasH);

  if (
    x >= SETTINGS_GEAR_X &&
    x <= SETTINGS_GEAR_X + SETTINGS_GEAR_SIZE &&
    y >= SETTINGS_GEAR_Y &&
    y <= SETTINGS_GEAR_Y + SETTINGS_GEAR_SIZE
  ) {
    return { type: "gear" };
  }

  const { gap, rectW, rectH, rectY } = computeLayout(tsW, tsH, slotCount);
  for (let i = 0; i < slotCount; i++) {
    const rx = gap + i * (rectW + gap);
    if (x >= rx && x <= rx + rectW && y >= rectY && y <= rectY + rectH) {
      return { type: "slot", slotId: i as ValidPlayerSlot };
    }
  }
  return null;
}

/** Compute lobby panel layout (shared by drawing and hit-testing). */
export function computeLobbyLayout(W: number, H: number, count: number) {
  const touch = IS_TOUCH_DEVICE;
  const gap = touch ? 8 : 12;
  const rectW = Math.round((W - gap * (count + 1)) / count);
  const rectH = Math.round(
    H * (touch ? LOBBY_RECT_H_RATIO_TOUCH : LOBBY_RECT_H_RATIO),
  );
  const rectY = Math.round(
    H * (touch ? LOBBY_RECT_Y_RATIO_TOUCH : LOBBY_RECT_Y_RATIO),
  );
  return { gap, rectW, rectH, rectY };
}

function upgradePickStartY(H: number, entryCount: number): number {
  const totalH = entryCount * upgradePickEntryH() - UPGRADE_ROW_GAP;
  return Math.max(H * 0.14, (H - totalH - 30) / 2);
}

function upgradePickEntryH(): number {
  return UPGRADE_NAME_H + UPGRADE_CARD_H + UPGRADE_ROW_GAP;
}

function buildCastleOverlay(
  state: GameState,
  wallsBeforeSweep?: readonly ReadonlySet<number>[],
): CastleData[] {
  return state.players
    .filter((player) => player.castle)
    .map((player) => {
      return {
        walls: wallsBeforeSweep?.[player.id] ?? player.walls,
        interior: player.interior,
        cannons: player.cannons,
        playerId: player.id,
        damagedWalls:
          player.damagedWalls.size > 0 ? player.damagedWalls : undefined,
      };
    });
}

function buildHomeTowersByIndex(state: GameState): Map<number, number> {
  const homeTowers = new Map<number, number>();
  for (const player of state.players) {
    if (player.homeTower) {
      homeTowers.set(player.homeTower.index, player.id);
    }
  }
  return homeTowers;
}

function buildLifeLostDialogUi(
  dialog: LifeLostDialogState | null,
  playerNames: ReadonlyArray<string>,
  playerColors: ReadonlyArray<{ wall: RGB }>,
  maxTimer: number,
  getPanelPos: (playerId: ValidPlayerSlot) => { px: number; py: number },
): LifeLostDialogOverlay | undefined {
  if (!dialog) return undefined;

  return {
    entries: dialog.entries.map((e) => {
      const { px, py } = getPanelPos(e.playerId);
      return {
        playerId: e.playerId,
        name: playerNames[e.playerId] ?? `P${e.playerId + 1}`,
        lives: e.lives,
        color: playerColors[e.playerId % playerColors.length]!.wall,
        choice: e.choice,
        focusedButton: e.focusedButton,
        px,
        py,
      };
    }),
    timer: dialog.timer,
    maxTimer,
  };
}

function buildUpgradePickUi(
  dialog: UpgradePickDialogState | null,
  interactivePlayerId: PlayerSlotId,
  playerNames: ReadonlyArray<string>,
  playerColors: ReadonlyArray<{ wall: RGB }>,
): UpgradePickOverlay | undefined {
  if (!dialog) return undefined;

  const entries = dialog.entries.map((entry) => {
    return {
      playerName: playerNames[entry.playerId] ?? `P${entry.playerId + 1}`,
      color: playerColors[entry.playerId % playerColors.length]!.wall,
      resolved: entry.choice !== null,
      interactive: entry.playerId === interactivePlayerId,
      cards: entry.offers.map((upgradeId, ci) => {
        const def = UPGRADE_POOL.find((ud) => ud.id === upgradeId);
        return {
          id: upgradeId,
          label: def?.label ?? upgradeId,
          description: def?.description ?? "",
          category: def?.category ?? "",
          focused: entry.choice === null && entry.focusedCard === ci,
          picked: entry.choice === upgradeId,
        };
      }),
    };
  });

  return {
    entries,
    timer: dialog.timer,
    maxTimer: UPGRADE_PICK_MAX_TIMER,
  };
}

function buildBattleCannonballsPayload(
  inBattle: boolean,
  cannonballs: ReadonlyArray<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    targetX: number;
    targetY: number;
    incendiary?: boolean;
  }>,
):
  | Array<{ x: number; y: number; progress: number; incendiary?: boolean }>
  | undefined {
  if (!inBattle) return undefined;

  return cannonballs.map((b) => {
    const totalDist = Math.hypot(b.targetX - b.startX, b.targetY - b.startY);
    const remaining = Math.hypot(b.targetX - b.x, b.targetY - b.y);
    const progress = totalDist > 0 ? 1 - remaining / totalDist : 1;
    return {
      x: b.x,
      y: b.y,
      progress,
      incendiary: b.incendiary,
    };
  });
}

function buildBattleBalloonsPayload(
  flights: ReadonlyArray<{
    flight: { startX: number; startY: number; endX: number; endY: number };
    progress: number;
  }>,
):
  | Array<{
      x: number;
      y: number;
      targetX: number;
      targetY: number;
      progress: number;
    }>
  | undefined {
  if (flights.length === 0) return undefined;

  return flights.map((b) => ({
    x: b.flight.startX,
    y: b.flight.startY,
    targetX: b.flight.endX,
    targetY: b.flight.endY,
    progress: b.progress,
  }));
}
