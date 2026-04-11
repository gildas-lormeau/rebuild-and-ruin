import { emitGameEvent, GAME_EVENT } from "../shared/game-event-bus.ts";
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
import { eliminatePlayer, isPlayerAlive } from "../shared/player-types.ts";
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

/** AI decision callback for auto-resolving life-lost entries. Injected by
 *  the runtime from `ai/ai-life-lost.ts` so game/ stays decoupled from AI. */
type AiLifeLostChoose = (entry: LifeLostEntry) => ResolvedChoice;

/** Tick the life-lost dialog.
 *
 *  Drives dialog-layer state only: increments timers and delegates the
 *  actual choice for auto-resolve entries to the injected `aiChoose`
 *  callback (AI decision lives in `ai/ai-life-lost.ts`). The max-timer
 *  fallback picks ABANDON as a hard safety net, not as a decision.
 *
 *  Returns true when all entries are resolved.
 *  @param dt — Delta time in seconds (not ms).
 *  @param autoDelay — Per-entry auto-resolve delay in seconds.
 *  @param maxTimer — Global force-resolve deadline in seconds.
 *  @param aiChoose — AI decision callback (closed over GameState). */
// Parallel structure with tickUpgradePickDialog (upgrade-pick.ts) — both loop entries for auto-resolve + force-resolve.
export function tickLifeLostDialog(
  dialog: LifeLostDialogState,
  dt: number,
  autoDelay: number,
  maxTimer: number,
  aiChoose: AiLifeLostChoose,
): boolean {
  dialog.timer += dt;

  for (const entry of dialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING) continue;
    if (entry.autoResolve) {
      entry.autoTimer += dt;
      if (entry.autoTimer >= autoDelay) entry.choice = aiChoose(entry);
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
  state: GameState,
): void {
  for (const entry of dialog.entries) {
    if (entry.choice !== LifeLostChoice.ABANDON) continue;
    const player = state.players[entry.playerId];
    if (player) {
      eliminatePlayer(player);
      emitGameEvent(state.bus, GAME_EVENT.PLAYER_ELIMINATED, {
        playerId: player.id,
        round: state.round,
      });
    }
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

  const alive = state.players.filter(isPlayerAlive);
  if (alive.length <= 1) {
    const winner =
      alive[0] ??
      state.players.reduce((best, player) =>
        player.score > best.score ? player : best,
      );
    emitGameEvent(state.bus, GAME_EVENT.GAME_END, { round: state.round });
    onGameOver(winner);
    return true;
  }

  if (state.round > state.maxRounds) {
    const winner = alive.reduce(
      (best, player) => (player.score > best.score ? player : best),
      alive[0]!,
    );
    emitGameEvent(state.bus, GAME_EVENT.GAME_END, { round: state.round });
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
