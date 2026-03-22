import { GRID_ROWS } from "./grid.ts";
import { TILE } from "./map-renderer.ts";
import type { CastleData, RenderOverlay } from "./map-renderer.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import type { RGB } from "./player-config.ts";
import { Phase } from "./types.ts";
import type { GameState, Impact } from "./types.ts";

export function buildCastleOverlay(state: GameState): CastleData[] {
  return state.players
    .filter((p) => p.castle)
    .map((p) => ({
      walls: p.walls,
      interior: p.interior,
      cannons: p.cannons,
      playerId: p.id,
    }));
}

export function buildHomeTowersByIndex(state: GameState): Map<number, number> {
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
  const h = GRID_ROWS * TILE;
  const bannerH = h * 0.15;
  const startY = -bannerH / 2;
  const endY = h + bannerH / 2;
  return {
    text,
    subtitle,
    y: startY + progress * (endY - startY),
  };
}

export function buildLifeLostDialogUi(
  dialog: LifeLostDialogState | null,
  playerNames: ReadonlyArray<string>,
  playerColors: ReadonlyArray<{ wall: RGB }>,
  maxTimer: number,
  getPanelPos: (playerId: number) => { px: number; py: number },
):
  | {
      entries: {
        playerId: number;
        name: string;
        lives: number;
        color: RGB;
        choice: "pending" | "continue" | "abandon";
        focused: number;
        px: number;
        py: number;
      }[];
      timer: number;
      maxTimer: number;
    }
  | undefined {
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

export function buildBattleCannonballsPayload(
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

export function buildBattleBalloonsPayload(
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

export function buildOnlineOverlay(params: {
  previousSelection: RenderOverlay["selection"];
  state: GameState;
  banner: {
    active: boolean;
    oldCastles?: CastleData[];
    oldTerritory?: Set<number>[];
    oldWalls?: Set<number>[];
    newTerritory?: Set<number>[];
    newWalls?: Set<number>[];
  };
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
    gameOver?: {
      winner: string;
      scores: {
        name: string;
        score: number;
        color: RGB;
        eliminated: boolean;
      }[];
    };
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
        state.phase !== Phase.BATTLE && !banner.active
          ? state.timer
          : undefined,
      banner: bannerUi,
      bannerOldCastles: banner.active ? banner.oldCastles : undefined,
      bannerOldBattleTerritory: banner.active ? banner.oldTerritory : undefined,
      bannerOldBattleWalls: banner.active ? banner.oldWalls : undefined,
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
