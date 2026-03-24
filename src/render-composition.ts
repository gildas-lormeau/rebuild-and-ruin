import type { GameOverOverlay, LifeLostDialogOverlay } from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import { CHOICE_ABANDON, CHOICE_CONTINUE, CHOICE_PENDING, type LifeLostDialogState, type ResolvedChoice } from "./life-lost.ts";
import type { BannerState } from "./phase-banner.ts";
import type { RGB } from "./player-config.ts";
import {
  LIFE_LOST_BTN_H as BTN_H,
  LIFE_LOST_BTN_W as BTN_W,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_PANEL_W as PANEL_W,
} from "./render-theme.ts";
import type { CastleData, RenderOverlay } from "./render-types.ts";
import type { SelectionState } from "./selection.ts";
import type { GameState, Impact } from "./types.ts";
import { Phase } from "./types.ts";

function buildCastleOverlay(state: GameState): CastleData[] {
  return state.players
    .filter((p) => p.castle)
    .map((p) => ({
      walls: p.walls,
      interior: p.interior,
      cannons: p.cannons,
      playerId: p.id,
    }));
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

export function buildRenderSummaryMessage(params: {
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

export function buildBannerUi(
  active: boolean,
  text: string,
  progress: number,
  subtitle?: string,
): { text: string; subtitle?: string; y: number } | undefined {
  if (!active) return undefined;
  const h = GRID_ROWS * TILE_SIZE;
  const bannerH = h * 0.15;
  const startY = -bannerH / 2;
  const endY = h + bannerH / 2;
  return {
    text,
    subtitle,
    y: startY + progress * (endY - startY),
  };
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
  cannonballs: Array<{
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
      incendiary: b.incendiary || undefined,
    };
  });
}

function buildBattleBalloonsPayload(
  flights: Array<{
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

const PHASE_LABELS = new Map<Phase, string>([
  [Phase.CASTLE_SELECT, "Select"],
  [Phase.CASTLE_RESELECT, "Select"],
  [Phase.WALL_BUILD, "Build"],
  [Phase.CANNON_PLACE, "Cannons"],
  [Phase.BATTLE, "Battle"],
]);

export function buildStatusBar(state: GameState, playerColors: readonly { interiorLight: RGB }[]) {
  return {
    round: state.battleLength === Infinity ? `R${state.round}` : `R${state.round}/${state.battleLength}`,
    phase: PHASE_LABELS.get(state.phase) ?? "",
    timer: state.timer > 0 ? `${Math.ceil(state.timer)}s` : "",
    players: state.players.map((p, i) => ({
      score: p.score,
      cannons: p.cannons.filter(c => c.hp > 0).length,
      lives: p.lives,
      color: playerColors[i % playerColors.length]!.interiorLight,
      eliminated: p.eliminated,
    })),
  };
}

// ---------------------------------------------------------------------------
// Selection overlay (moved from selection.ts to decouple from render-map)
// ---------------------------------------------------------------------------

export function syncSelectionOverlay(
  overlay: RenderOverlay,
  selectionStates: Map<number, SelectionState>,
  isLocalHuman?: (pid: number) => boolean,
): void {
  if (!overlay.selection) {
    overlay.selection = { highlighted: null, selected: null };
  }
  overlay.selection.highlights = [];
  for (const [pid, ss] of selectionStates) {
    if (isLocalHuman && !isLocalHuman(pid)) continue;
    overlay.selection.highlights.push({
      towerIdx: ss.highlighted,
      playerId: pid,
      confirmed: ss.confirmed,
    });
  }
}

// ---------------------------------------------------------------------------
// Life-lost panel layout (moved from life-lost.ts to decouple from render-theme)
// ---------------------------------------------------------------------------

export function lifeLostPanelPos(
  state: GameState,
  playerId: number,
): { px: number; py: number } {
  const zone = state.playerZones[playerId] ?? 0;
  const zoneTowers = state.map.towers.filter((t) => t.zone === zone);
  const tsW = GRID_COLS * TILE_SIZE;
  const tsH = GRID_ROWS * TILE_SIZE;

  const cx =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((s, t) => s + t.col, 0) / zoneTowers.length + 1) *
        TILE_SIZE
      : tsW / 2;
  const cy =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((s, t) => s + t.row, 0) / zoneTowers.length + 1) *
        TILE_SIZE
      : tsH / 2;

  return {
    px: Math.max(2, Math.min(tsW - PANEL_W - 2, Math.round(cx - PANEL_W / 2))),
    py: Math.max(2, Math.min(tsH - PANEL_H - 2, Math.round(cy - PANEL_H / 2))),
  };
}

export function handleLifeLostDialogClick(params: {
  state: GameState;
  lifeLostDialog: LifeLostDialogState;
  canvasWidth: number;
  canvasHeight: number;
  canvasX: number;
  canvasY: number;
  firstHumanPlayerId: number;
}): { playerId: number; choice: ResolvedChoice } | null {
  const {
    state,
    lifeLostDialog,
    canvasWidth,
    canvasHeight,
    canvasX,
    canvasY,
    firstHumanPlayerId,
  } = params;

  const tsW = GRID_COLS * TILE_SIZE;
  const tsH = GRID_ROWS * TILE_SIZE;
  const x = canvasX * (tsW / canvasWidth);
  const y = canvasY * (tsH / canvasHeight);

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== CHOICE_PENDING || entry.isAi) continue;
    if (entry.playerId !== firstHumanPlayerId) continue;

    const { px, py } = lifeLostPanelPos(state, entry.playerId);
    const btnY = py + PANEL_H - BTN_H - 10;
    const contX = px + PANEL_W / 2 - BTN_W - 5;
    const abX = px + PANEL_W / 2 + 5;

    if (x >= contX && x <= contX + BTN_W && y >= btnY && y <= btnY + BTN_H) {
      entry.choice = CHOICE_CONTINUE;
      return { playerId: entry.playerId, choice: CHOICE_CONTINUE };
    }

    if (x >= abX && x <= abX + BTN_W && y >= btnY && y <= btnY + BTN_H) {
      entry.choice = CHOICE_ABANDON;
      return { playerId: entry.playerId, choice: CHOICE_ABANDON };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Online overlay composition
// ---------------------------------------------------------------------------

export function buildOnlineOverlay(params: {
  previousSelection: RenderOverlay["selection"];
  state: GameState;
  banner: Pick<BannerState, "active" | "oldCastles" | "oldTerritory" | "oldWalls" | "oldHouses" | "oldBonusSquares" | "newTerritory" | "newWalls">;
  battleAnim: {
    territory: Set<number>[];
    walls: Set<number>[];
    flights: Array<{
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
  lifeLostMaxTimer: number;
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
    lifeLostMaxTimer,
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
    castles: buildCastleOverlay(state),
    entities: {
      houses: state.map.houses,
      grunts: state.grunts,
      towerAlive: state.towerAlive,
      burningPits: state.burningPits,
      bonusSquares: state.bonusSquares,
      homeTowers: homeTowers.size > 0 ? homeTowers : undefined,
    },
    battle: {
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
      bannerOldHouses: banner.active ? banner.oldHouses : undefined,
      bannerOldBonusSquares: banner.active ? banner.oldBonusSquares : undefined,
      announcement: frame.announcement,
      gameOver: frame.gameOver,
      lifeLostDialog: buildLifeLostDialogUi(
        lifeLostDialog,
        playerNames,
        playerColors,
        lifeLostMaxTimer,
        getLifeLostPanelPos,
      ),
    },
  };
}
