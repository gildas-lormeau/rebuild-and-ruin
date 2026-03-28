import {
  type GameState,
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
} from "./types.ts";

interface ResolveLifeLostDialogDeps {
  lifeLostDialog: LifeLostDialogState | null;
  afterLifeLostResolved: (continuing: readonly number[]) => boolean;
}

interface TickLifeLostDialogDeps {
  dt: number;
  lifeLostDialog: LifeLostDialogState | null;
  lifeLostAiDelay: number;
  lifeLostMaxTimer: number;
  isHost: boolean;
  render: () => void;
  logResolved: (dialog: LifeLostDialogState) => void;
  resolveHostDialog: (
    dialog: LifeLostDialogState,
  ) => LifeLostDialogState | null;
  onNonHostResolved: (dialog: LifeLostDialogState) => void;
}

interface CreateLifeLostDialogDeps {
  needsReselect: readonly number[];
  eliminated: readonly number[];
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  remoteHumanSlots: ReadonlySet<number>;
  isHumanController: (playerId: number) => boolean;
}

interface ResolveAfterLifeLostDeps {
  state: GameState;
  continuing: readonly number[];
  onEndGame: (winner: { id: number } | null) => void;
  onStartReselection: (continuing: readonly number[]) => void;
  onAdvanceToCannonPhase: () => void;
}

export function resolveLifeLostDialogRuntime(
  deps: ResolveLifeLostDialogDeps,
): LifeLostDialogState | null {
  const { lifeLostDialog, afterLifeLostResolved } = deps;
  if (!lifeLostDialog) return null;

  const continuing = lifeLostDialog.entries
    .filter((e) => e.choice === LifeLostChoice.CONTINUE)
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
    isHost,
    render,
    logResolved,
    resolveHostDialog,
    onNonHostResolved,
  } = deps;

  if (!lifeLostDialog) return null;

  lifeLostDialog.timer += dt;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING) continue;
    if (entry.isAi) {
      entry.aiTimer += dt;
      if (entry.aiTimer >= lifeLostAiDelay)
        entry.choice = LifeLostChoice.CONTINUE;
    }
  }

  if (lifeLostDialog.timer >= lifeLostMaxTimer) {
    for (const entry of lifeLostDialog.entries) {
      if (entry.choice === LifeLostChoice.PENDING)
        entry.choice = LifeLostChoice.CONTINUE;
    }
  }

  render();

  if (
    !lifeLostDialog.entries.every((e) => e.choice !== LifeLostChoice.PENDING)
  ) {
    return lifeLostDialog;
  }

  logResolved(lifeLostDialog);

  if (isHost) {
    return resolveHostDialog(lifeLostDialog);
  }

  onNonHostResolved(lifeLostDialog);
  return null;
}

export function createLifeLostDialogState(
  deps: CreateLifeLostDialogDeps,
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
    choice: LifeLostChoice.PENDING,
    aiTimer: 0,
    focused: 0,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      isAi: true,
      choice: LifeLostChoice.ABANDON,
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
