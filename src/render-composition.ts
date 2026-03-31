/**
 * Overlay composition, layout, and hit-test utilities.
 *
 * Parameter convention: functions with ≤3 closely-related args use positional
 * parameters; functions with >3 args or heterogeneous config use a `params`
 * object for readability at the call site.
 */

import {
  ENCLOSURE_REVEAL_DELAY_MS,
  LIFE_LOST_MAX_TIMER,
} from "./game-constants.ts";
import type { RGB } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import type { BannerState } from "./phase-banner.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
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
} from "./render-theme.ts";
import {
  type GameOverOverlay,
  type LifeLostDialogOverlay,
  type RenderOverlay,
} from "./render-types.ts";
import {
  type CastleData,
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  type GameState,
  type Impact,
  LifeLostChoice,
  type LifeLostDialogState,
  Phase,
  type ResolvedChoice,
  type SelectionState,
} from "./types.ts";

/** Result of a lobby click hit-test. */
export type LobbyHit = { type: "gear" } | { type: "slot"; slotId: number };

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

const PHASE_LABELS = new Map<Phase, string>([
  [Phase.CASTLE_SELECT, "Select"],
  [Phase.CASTLE_RESELECT, "Select"],
  [Phase.WALL_BUILD, "Build"],
  [Phase.CANNON_PLACE, "Cannons"],
  [Phase.BATTLE, "Battle"],
]);
const GAMEOVER_PANEL_W_RATIO = 0.65;
const GEAR_X = GRID_COLS * TILE_SIZE - 32;
const GEAR_Y = 4;
const GEAR_SIZE = 28;
/** Per-player snapshot of previous interior, used to detect newly enclosed tiles. */
const prevInterior = new Map<number, ReadonlySet<number>>();
/** Tiles waiting to be revealed after ENCLOSURE_REVEAL_DELAY_MS elapses. */
const pendingReveal = new Map<number, number>();
export const GAMEOVER_ROW_H = 14;
export const GAMEOVER_HEADER_H = 36;
export const GAMEOVER_BTN_H = 20;
/** Scoreboard column X positions as ratios of panel width: Score, Walls, Cannons, Territory. */
export const SCOREBOARD_COL_RATIOS = [0.38, 0.56, 0.74, 0.92] as const;

export function createRenderSummaryMessage(params: {
  phaseName: string;
  timer: number;
  crosshairs: Array<{ x: number; y: number; playerId: number }>;
  aiPhantomsCount: number;
  humanPhantomsCount: number;
  aiCannonPhantomsCount: number;
  impactsCount: number;
  cannonballsCount: number;
  selectionHighlights?: Array<{
    playerId: number;
    towerIdx: number;
    confirmed?: boolean;
  }>;
}): string {
  const {
    phaseName,
    timer,
    crosshairs,
    aiPhantomsCount,
    humanPhantomsCount,
    aiCannonPhantomsCount,
    impactsCount,
    cannonballsCount,
    selectionHighlights,
  } = params;

  const crosshairDetail = crosshairs
    .map((c) => `P${c.playerId}(${Math.round(c.x)},${Math.round(c.y)})`)
    .join(",");
  const phantomCount =
    aiPhantomsCount + humanPhantomsCount + aiCannonPhantomsCount;
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
  const h = GRID_ROWS * TILE_SIZE;
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
) {
  return {
    round:
      state.battleLength === Infinity
        ? `R${state.round}`
        : `R${state.round}/${state.battleLength}`,
    phase: PHASE_LABELS.get(state.phase) ?? "",
    timer: state.timer > 0 ? `${Math.ceil(state.timer)}s` : "",
    players: state.players.map((player, i) => ({
      score: player.score,
      cannons: player.cannons.filter((c) => c.hp > 0).length,
      lives: player.lives,
      color: playerColors[i % playerColors.length]!.interiorLight,
      eliminated: player.eliminated,
    })),
  };
}

/** Writes selection highlights into overlay.selection (mutates in-place). */
export function updateSelectionOverlay(
  overlay: RenderOverlay,
  selectionStates: Map<number, SelectionState>,
  isLocalHuman?: (pid: number) => boolean,
): void {
  if (!overlay.selection) {
    overlay.selection = { highlighted: null, selected: null };
  }
  overlay.selection.highlights = [];
  for (const [pid, selectionState] of selectionStates) {
    if (selectionState.confirmed) continue;
    if (isLocalHuman && !isLocalHuman(pid)) continue;
    overlay.selection.highlights.push({
      towerIdx: selectionState.highlighted,
      playerId: pid,
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
  firstHumanPlayerId: number;
}): { playerId: number; choice: ResolvedChoice } | null {
  const { state, lifeLostDialog, screenX, screenY, firstHumanPlayerId } =
    params;

  const gameX = screenX / SCALE;
  const gameY = screenY / SCALE;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING || entry.isAi) continue;
    if (entry.playerId !== firstHumanPlayerId) continue;

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

/** Position the life-lost dialog panel centered over the player's zone towers.
 *  Falls back to the map center if no zone towers exist.
 *  Result is clamped to keep the panel 2px inside the tile-space edges. */
export function lifeLostPanelPos(
  state: GameState,
  playerId: number,
): { px: number; py: number } {
  const zone = state.playerZones[playerId] ?? 0;
  const zoneTowers = state.map.towers.filter((tower) => tower.zone === zone);
  const tsW = GRID_COLS * TILE_SIZE;
  const tsH = GRID_ROWS * TILE_SIZE;

  // Tower centroid (+1 offset for 2×2 tower center), or map center as fallback
  const cx =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((sum, tower) => sum + tower.col, 0) /
          zoneTowers.length +
          1) *
        TILE_SIZE
      : tsW / 2;
  const cy =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((sum, tower) => sum + tower.row, 0) /
          zoneTowers.length +
          1) *
        TILE_SIZE
      : tsH / 2;

  return {
    px: Math.max(2, Math.min(tsW - PANEL_W - 2, Math.round(cx - PANEL_W / 2))),
    py: Math.max(2, Math.min(tsH - PANEL_H - 2, Math.round(cy - PANEL_H / 2))),
  };
}

export function createOnlineOverlay(params: {
  previousSelection: RenderOverlay["selection"];
  state: GameState;
  banner: Pick<
    BannerState,
    | "active"
    | "oldCastles"
    | "oldTerritory"
    | "oldWalls"
    | "oldEntities"
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
      playerId: number;
      cannonReady?: boolean;
    }>;
    phantoms: RenderOverlay["phantoms"];
    announcement?: string;
    gameOver?: GameOverOverlay;
  };
  bannerUi?: { text: string; subtitle?: string; y: number };
  lifeLostDialog: LifeLostDialogState | null;
  playerNames: ReadonlyArray<string>;
  playerColors: ReadonlyArray<{ wall: RGB }>;
  getLifeLostPanelPos: (playerId: number) => { px: number; py: number };
}): RenderOverlay {
  const {
    previousSelection,
    state,
    banner,
    battleAnim,
    frame,
    bannerUi,
    lifeLostDialog,
    playerNames,
    playerColors,
    getLifeLostPanelPos,
  } = params;

  const homeTowers = buildHomeTowersByIndex(state);
  const battleTerritory =
    banner.active && banner.newTerritory
      ? banner.newTerritory
      : state.phase === Phase.BATTLE
        ? battleAnim.territory
        : undefined;
  const battleWalls =
    banner.active && banner.newTerritory
      ? banner.newWalls
      : state.phase === Phase.BATTLE
        ? battleAnim.walls
        : undefined;

  return {
    selection: previousSelection,
    castles: buildCastleOverlay(state, banner.wallsBeforeSweep),
    entities: banner.oldEntities ?? {
      houses: state.map.houses,
      grunts: state.grunts,
      towerAlive: state.towerAlive,
      burningPits: state.burningPits,
      bonusSquares: state.bonusSquares,
      homeTowers: homeTowers.size > 0 ? homeTowers : undefined,
    },
    battle: {
      inBattle: !!battleTerritory,
      battleTerritory,
      battleWalls,
      cannonballs: buildBattleCannonballsPayload(
        state.phase === Phase.BATTLE,
        state.cannonballs,
      ),
      impacts: state.phase === Phase.BATTLE ? battleAnim.impacts : undefined,
      crosshairs: state.phase === Phase.BATTLE ? frame.crosshairs : undefined,
      balloons: buildBattleBalloonsPayload(battleAnim.flights),
    },
    phantoms: frame.phantoms,
    ui: {
      timer:
        state.phase !== Phase.BATTLE && !banner.active && state.timer > 0
          ? state.timer
          : undefined,
      banner: bannerUi,
      bannerOldCastles: banner.active ? banner.oldCastles : undefined,
      bannerOldBattleTerritory: banner.active ? banner.oldTerritory : undefined,
      bannerOldBattleWalls: banner.active ? banner.oldWalls : undefined,
      bannerOldEntities: banner.active ? banner.oldEntities : undefined,
      announcement: frame.announcement,
      gameOver: frame.gameOver,
      lifeLostDialog: buildLifeLostDialogUi(
        lifeLostDialog,
        playerNames,
        playerColors,
        LIFE_LOST_MAX_TIMER,
        getLifeLostPanelPos,
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
    x >= GEAR_X &&
    x <= GEAR_X + GEAR_SIZE &&
    y >= GEAR_Y &&
    y <= GEAR_Y + GEAR_SIZE
  ) {
    return { type: "gear" };
  }

  const { gap, rectW, rectH, rectY } = computeLayout(tsW, tsH, slotCount);
  for (let i = 0; i < slotCount; i++) {
    const rx = gap + i * (rectW + gap);
    if (x >= rx && x <= rx + rectW && y >= rectY && y <= rectY + rectH) {
      return { type: "slot", slotId: i };
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

function buildCastleOverlay(
  state: GameState,
  wallsBeforeSweep?: readonly Set<number>[],
): CastleData[] {
  const now = performance.now();
  for (const [key, revealAt] of pendingReveal) {
    if (now >= revealAt) pendingReveal.delete(key);
  }

  return state.players
    .filter((player) => player.castle)
    .map((player) => {
      const cached = prevInterior.get(player.id);
      if (cached && cached !== player.interior) {
        for (const key of player.interior) {
          if (!cached.has(key)) {
            pendingReveal.set(key, now + ENCLOSURE_REVEAL_DELAY_MS);
          }
        }
      }
      prevInterior.set(player.id, player.interior);

      let displayInterior: ReadonlySet<number> = player.interior;
      if (pendingReveal.size > 0) {
        const filtered = new Set<number>();
        for (const key of player.interior) {
          if (!pendingReveal.has(key)) filtered.add(key);
        }
        displayInterior = filtered;
      }

      return {
        walls: wallsBeforeSweep?.[player.id] ?? player.walls,
        interior: displayInterior,
        cannons: player.cannons,
        playerId: player.id,
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
  getPanelPos: (playerId: number) => { px: number; py: number },
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
        focused: e.focused,
        px,
        py,
      };
    }),
    timer: dialog.timer,
    maxTimer,
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
