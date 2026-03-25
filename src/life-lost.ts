import type { GameState } from "./types.ts";

export type LifeLostChoice = typeof CHOICE_PENDING | typeof CHOICE_CONTINUE | typeof CHOICE_ABANDON;

export type ResolvedChoice = typeof CHOICE_CONTINUE | typeof CHOICE_ABANDON;

export interface LifeLostEntry {
  playerId: number;
  lives: number;
  isAi: boolean;
  choice: LifeLostChoice;
  aiTimer: number;
  focused: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

interface ResolveLifeLostDialogDeps {
  lifeLostDialog: LifeLostDialogState | null;
  state: GameState;
  afterLifeLostResolved: (continuing: number[]) => boolean;
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

interface BuildLifeLostDialogDeps {
  needsReselect: number[];
  eliminated: number[];
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  remoteHumanSlots: ReadonlySet<number>;
  isHumanController: (playerId: number) => boolean;
}

interface ResolveAfterLifeLostDeps {
  state: GameState;
  continuing: number[];
  onEndGame: (winner: { id: number } | null) => void;
  onStartReselection: (continuing: number[]) => void;
  onAdvanceToCannonPhase: () => void;
}

export const CHOICE_PENDING = "pending" as const;
export const CHOICE_CONTINUE = "continue" as const;
export const CHOICE_ABANDON = "abandon" as const;

export function resolveLifeLostDialogRuntime(
  deps: ResolveLifeLostDialogDeps,
): LifeLostDialogState | null {
  const { lifeLostDialog, state, afterLifeLostResolved } = deps;
  if (!lifeLostDialog) return null;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice === CHOICE_ABANDON && entry.lives > 0) {
      const player = state.players[entry.playerId]!;
      player.eliminated = true;
      player.lives = 0;
    }
  }

  const continuing = lifeLostDialog.entries
    .filter((e) => e.choice === CHOICE_CONTINUE)
    .map((e) => e.playerId);

  afterLifeLostResolved(continuing);
  return null;
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
    if (entry.choice !== CHOICE_PENDING) continue;
    if (entry.isAi) {
      entry.aiTimer += dt;
      if (entry.aiTimer >= lifeLostAiDelay) entry.choice = CHOICE_CONTINUE;
    }
  }

  if (lifeLostDialog.timer >= lifeLostMaxTimer) {
    for (const entry of lifeLostDialog.entries) {
      if (entry.choice === CHOICE_PENDING) entry.choice = CHOICE_CONTINUE;
    }
  }

  render();

  if (!lifeLostDialog.entries.every((e) => e.choice !== CHOICE_PENDING)) {
    return lifeLostDialog;
  }

  logResolved(lifeLostDialog);

  if (isHost) {
    return resolveHostDialog(lifeLostDialog);
  }

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== CHOICE_ABANDON) continue;
    const player = state.players[entry.playerId];
    if (!player) continue;
    player.eliminated = true;
    player.lives = 0;
  }

  onNonHostResolved();
  return null;
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
    choice: CHOICE_PENDING,
    aiTimer: 0,
    focused: 0,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      isAi: true,
      choice: CHOICE_ABANDON,
      aiTimer: 0,
      focused: 0,
    });
  }

  return { entries, timer: 0 };
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
