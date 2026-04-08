import {
  type AutoResolveDeps,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
  shouldAutoResolve,
} from "../shared/interaction-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { eliminatePlayer, type Player } from "../shared/player-types.ts";
import { type GameState } from "../shared/types.ts";

interface CreateLifeLostDialogDeps extends AutoResolveDeps {
  needsReselect: readonly ValidPlayerSlot[];
  eliminated: readonly ValidPlayerSlot[];
  state: GameState;
}

interface ResolveAfterLifeLostDeps {
  state: GameState;
  continuing: readonly ValidPlayerSlot[];
  onGameOver: (winner: { id: ValidPlayerSlot }) => void;
  onReselect: (continuing: readonly ValidPlayerSlot[]) => void;
  onContinue: () => void;
}

/** Tick the life-lost dialog. Auto-resolve entries tick their timers;
 *  max timer force-resolves all pending entries.
 *  Returns true when all entries are resolved. */
// Parallel structure with tickUpgradePickDialog (upgrade-pick.ts) — both loop entries for auto-resolve + force-resolve.
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
        entry.choice = LifeLostChoice.ABANDON;
    }
  }

  return isLifeLostAllResolved(dialog);
}

/** True when every entry has been resolved (no PENDING choices remain). */
export function isLifeLostAllResolved(dialog: LifeLostDialogState): boolean {
  return dialog.entries.every((e) => e.choice !== LifeLostChoice.PENDING);
}

/** Extract the player IDs that chose CONTINUE from a resolved dialog. */
export function continuingPlayers(
  dialog: LifeLostDialogState,
): ValidPlayerSlot[] {
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
    focusedButton: 0,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      autoResolve: true,
      choice: LifeLostChoice.ABANDON,
      autoTimer: 0,
      focusedButton: 0,
    });
  }

  return { entries, timer: 0 };
}

/** Eliminate all players who chose ABANDON in a resolved life-lost dialog.
 *  Game rule: iterates entries, marks each ABANDON player as eliminated. */
export function eliminateAbandoned(
  dialog: LifeLostDialogState,
  players: readonly Player[],
): void {
  for (const entry of dialog.entries) {
    if (entry.choice !== LifeLostChoice.ABANDON) continue;
    const player = players[entry.playerId];
    if (player) eliminatePlayer(player);
  }
}

/** Toggle the focused button between CONTINUE and ABANDON. */
export function toggleLifeLostFocus(entry: LifeLostEntry): void {
  entry.focusedButton =
    entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE
      ? LIFE_LOST_FOCUS_ABANDON
      : LIFE_LOST_FOCUS_CONTINUE;
}

/** Confirm the currently focused choice. Returns the resolved choice. */
export function confirmLifeLostFocusedChoice(
  entry: LifeLostEntry,
): ResolvedChoice {
  const choice =
    entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE
      ? LifeLostChoice.CONTINUE
      : LifeLostChoice.ABANDON;
  entry.choice = choice;
  return choice;
}

/** Apply a direct choice (e.g. from a spatial click on a specific button). */
export function applyLifeLostChoice(
  entry: LifeLostEntry,
  choice: ResolvedChoice,
): void {
  entry.choice = choice;
}

/** Determine the game outcome after the life-lost dialog resolves.
 *  Checks win conditions (last player standing, round limit) and
 *  dispatches to the appropriate callback. */
export function resolveAfterLifeLost(deps: ResolveAfterLifeLostDeps): boolean {
  const { state, continuing, onGameOver, onReselect, onContinue } = deps;

  const alive = state.players.filter((player) => !player.eliminated);
  if (alive.length <= 1) {
    const winner =
      alive[0] ??
      state.players.reduce((best, player) =>
        player.score > best.score ? player : best,
      );
    onGameOver(winner);
    return true;
  }

  if (state.round > state.maxRounds) {
    const winner = alive.reduce(
      (best, player) => (player.score > best.score ? player : best),
      alive[0]!,
    );
    onGameOver(winner);
    return true;
  }

  if (continuing.length > 0) {
    onReselect(continuing);
    return true;
  }

  onContinue();
  return true;
}
