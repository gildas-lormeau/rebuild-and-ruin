import {
  type AutoResolveDeps,
  shouldAutoResolve,
} from "./controller-interfaces.ts";
import {
  type GameState,
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
} from "./types.ts";

interface CreateLifeLostDialogDeps extends AutoResolveDeps {
  needsReselect: readonly number[];
  eliminated: readonly number[];
  state: GameState;
}

/** Tick the life-lost dialog. Auto-resolve entries tick their timers;
 *  max timer force-resolves all pending entries.
 *  Returns true when all entries are resolved. */
export function tickLifeLostDialog(
  dialog: LifeLostDialogState,
  dt: number,
  autoDelay: number,
  maxTimer: number,
): boolean {
  dialog.timer += dt;

  for (const entry of dialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING) continue;
    if (entry.autoResolve) {
      entry.autoTimer += dt;
      if (entry.autoTimer >= autoDelay) entry.choice = LifeLostChoice.CONTINUE;
    }
  }

  if (dialog.timer >= maxTimer) {
    for (const entry of dialog.entries) {
      if (entry.choice === LifeLostChoice.PENDING)
        entry.choice = LifeLostChoice.CONTINUE;
    }
  }

  return dialog.entries.every((e) => e.choice !== LifeLostChoice.PENDING);
}

/** Extract the player IDs that chose CONTINUE from a resolved dialog. */
export function continuingPlayers(dialog: LifeLostDialogState): number[] {
  return dialog.entries
    .filter((e) => e.choice === LifeLostChoice.CONTINUE)
    .map((e) => e.playerId);
}

export function createLifeLostDialogState(
  deps: CreateLifeLostDialogDeps,
): LifeLostDialogState {
  const { needsReselect, eliminated, state } = deps;

  const entries: LifeLostEntry[] = needsReselect.map((playerId) => ({
    playerId,
    lives: state.players[playerId]!.lives,
    autoResolve: shouldAutoResolve(playerId, deps),
    choice: LifeLostChoice.PENDING,
    autoTimer: 0,
    focused: 0,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      autoResolve: true,
      choice: LifeLostChoice.ABANDON,
      autoTimer: 0,
      focused: 0,
    });
  }

  return { entries, timer: 0 };
}
