import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import type { GameState } from "./types.ts";
import {
  LIFE_LOST_PANEL_W as PANEL_W,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_BTN_W as BTN_W,
  LIFE_LOST_BTN_H as BTN_H,
} from "./render-theme.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LifeLostEntry {
  playerId: number;
  lives: number;
  isAi: boolean;
  choice: "pending" | "continue" | "abandon";
  aiTimer: number;
  focused: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

// ---------------------------------------------------------------------------
// Runtime (resolve + tick)
// ---------------------------------------------------------------------------

interface ResolveLifeLostDialogDeps {
  lifeLostDialog: LifeLostDialogState | null;
  state: GameState;
  afterLifeLostResolved: (continuing: number[]) => boolean;
}

export function resolveLifeLostDialogRuntime(
  deps: ResolveLifeLostDialogDeps,
): LifeLostDialogState | null {
  const { lifeLostDialog, state, afterLifeLostResolved } = deps;
  if (!lifeLostDialog) return null;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice === "abandon" && entry.lives > 0) {
      const player = state.players[entry.playerId]!;
      player.eliminated = true;
      player.lives = 0;
    }
  }

  const continuing = lifeLostDialog.entries
    .filter((e) => e.choice === "continue")
    .map((e) => e.playerId);

  afterLifeLostResolved(continuing);
  return null;
}

interface TickLifeLostDialogDeps {
  dt: number;
  lifeLostDialog: LifeLostDialogState | null;
  lifeLostAiDelay: number;
  lifeLostMaxTimer: number;
  state: GameState;
  isHost: boolean;
  render: () => void;
  logResolved: (dialog: LifeLostDialogState) => void;
  resolveHostDialog: (
    dialog: LifeLostDialogState,
  ) => LifeLostDialogState | null;
  onNonHostResolved: () => void;
}

export function tickLifeLostDialogRuntime(
  deps: TickLifeLostDialogDeps,
): LifeLostDialogState | null {
  const {
    dt,
    lifeLostDialog,
    lifeLostAiDelay,
    lifeLostMaxTimer,
    state,
    isHost,
    render,
    logResolved,
    resolveHostDialog,
    onNonHostResolved,
  } = deps;

  if (!lifeLostDialog) return null;

  lifeLostDialog.timer += dt;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== "pending") continue;
    if (entry.isAi) {
      entry.aiTimer += dt;
      if (entry.aiTimer >= lifeLostAiDelay) entry.choice = "continue";
    }
  }

  if (lifeLostDialog.timer >= lifeLostMaxTimer) {
    for (const entry of lifeLostDialog.entries) {
      if (entry.choice === "pending") entry.choice = "continue";
    }
  }

  render();

  if (!lifeLostDialog.entries.every((e) => e.choice !== "pending")) {
    return lifeLostDialog;
  }

  logResolved(lifeLostDialog);

  if (isHost) {
    return resolveHostDialog(lifeLostDialog);
  }

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== "abandon") continue;
    const player = state.players[entry.playerId];
    if (!player) continue;
    player.eliminated = true;
    player.lives = 0;
  }

  onNonHostResolved();
  return null;
}

// ---------------------------------------------------------------------------
// UI (panel position + click handling)
// ---------------------------------------------------------------------------

const TILE = TILE_SIZE;

export function lifeLostPanelPos(
  state: GameState,
  playerId: number,
): { px: number; py: number } {
  const zone = state.playerZones[playerId] ?? 0;
  const zoneTowers = state.map.towers.filter((t) => t.zone === zone);
  const tsW = GRID_COLS * TILE;
  const tsH = GRID_ROWS * TILE;

  const cx =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((s, t) => s + t.col, 0) / zoneTowers.length + 1) *
        TILE
      : tsW / 2;
  const cy =
    zoneTowers.length > 0
      ? (zoneTowers.reduce((s, t) => s + t.row, 0) / zoneTowers.length + 1) *
        TILE
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
}): { playerId: number; choice: "continue" | "abandon" } | null {
  const {
    state,
    lifeLostDialog,
    canvasWidth,
    canvasHeight,
    canvasX,
    canvasY,
    firstHumanPlayerId,
  } = params;

  const tsW = GRID_COLS * TILE;
  const tsH = GRID_ROWS * TILE;
  const x = canvasX * (tsW / canvasWidth);
  const y = canvasY * (tsH / canvasHeight);

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== "pending" || entry.isAi) continue;
    if (entry.playerId !== firstHumanPlayerId) continue;

    const { px, py } = lifeLostPanelPos(state, entry.playerId);
    const btnY = py + PANEL_H - BTN_H - 10;
    const contX = px + PANEL_W / 2 - BTN_W - 5;
    const abX = px + PANEL_W / 2 + 5;

    if (x >= contX && x <= contX + BTN_W && y >= btnY && y <= btnY + BTN_H) {
      entry.choice = "continue";
      return { playerId: entry.playerId, choice: "continue" };
    }

    if (x >= abX && x <= abX + BTN_W && y >= btnY && y <= btnY + BTN_H) {
      entry.choice = "abandon";
      return { playerId: entry.playerId, choice: "abandon" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Coordinator (build dialog state + resolve after life lost)
// ---------------------------------------------------------------------------

interface BuildLifeLostDialogDeps {
  needsReselect: number[];
  eliminated: number[];
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  remoteHumanSlots: Set<number>;
  isHumanController: (playerId: number) => boolean;
}

export function buildLifeLostDialogState(
  deps: BuildLifeLostDialogDeps,
): LifeLostDialogState {
  const {
    needsReselect,
    eliminated,
    state,
    isHost,
    myPlayerId,
    remoteHumanSlots,
    isHumanController,
  } = deps;

  const entries: LifeLostEntry[] = needsReselect.map((playerId) => ({
    playerId,
    lives: state.players[playerId]!.lives,
    isAi: isHost
      ? !isHumanController(playerId) && !remoteHumanSlots.has(playerId)
      : playerId !== myPlayerId,
    choice: "pending" as const,
    aiTimer: 0,
    focused: 0,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      isAi: true,
      choice: "abandon" as const,
      aiTimer: 0,
      focused: 0,
    });
  }

  return { entries, timer: 0 };
}

interface ResolveAfterLifeLostDeps {
  state: GameState;
  continuing: number[];
  onEndGame: (winner: { id: number } | null) => void;
  onStartReselection: (continuing: number[]) => void;
  onAdvanceToCannonPhase: () => void;
}

export function resolveAfterLifeLost(deps: ResolveAfterLifeLostDeps): boolean {
  const {
    state,
    continuing,
    onEndGame,
    onStartReselection,
    onAdvanceToCannonPhase,
  } = deps;

  const alive = state.players.filter((p) => !p.eliminated);
  if (alive.length <= 1) {
    onEndGame(alive[0] ?? null);
    return true;
  }

  if (state.round > state.battleLength) {
    const winner = alive.reduce(
      (best, p) => (p.score > best.score ? p : best),
      alive[0]!,
    );
    onEndGame(winner);
    return true;
  }

  if (continuing.length > 0) {
    onStartReselection(continuing);
    return true;
  }

  onAdvanceToCannonPhase();
  return true;
}
