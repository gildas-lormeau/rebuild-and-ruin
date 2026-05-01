import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  type AutoResolveDeps,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
  shouldAutoResolve,
} from "../shared/ui/interaction-types.ts";
import { tickDialogWithFallback } from "./dialog-tick.ts";

interface CreateLifeLostDialogDeps extends AutoResolveDeps {
  needsReselect: readonly ValidPlayerSlot[];
  eliminated: readonly ValidPlayerSlot[];
  state: GameState;
}

interface ResolveAfterLifeLostDeps {
  continuing: readonly ValidPlayerSlot[];
  onReselect: (continuing: readonly ValidPlayerSlot[]) => void;
  onContinue: () => void;
}

/** Per-entry auto-resolve tick. Dispatched by the runtime to the owning
 *  controller (`controller.tickLifeLost`). Closes over the per-call
 *  GameState, `dt`, and `autoDelaySeconds`. */
type ControllerLifeLostTick = (entry: LifeLostEntry) => void;

/** Tick the life-lost dialog.
 *
 *  Drives dialog-layer state only: increments `dialog.timer`, delegates
 *  each pending auto-resolve entry to the per-entry `tickEntry` callback,
 *  and applies the max-timer safety net (ABANDON) as a hard fallback.
 *  `tickEntry` dispatches to the controller that owns each slot.
 *
 *  Returns true when all entries are resolved.
 *  @param dt — Delta time in seconds (not ms).
 *  @param maxTimer — Global force-resolve deadline in seconds.
 *  @param tickEntry — Per-entry tick (closed over state + dt + autoDelay). */
// Shares the auto-resolve + force-resolve loop with tickUpgradePickDialog via tickDialogWithFallback.
export function tickLifeLostDialog(
  dialog: LifeLostDialogState,
  dt: number,
  maxTimer: number,
  tickEntry: ControllerLifeLostTick,
): boolean {
  return tickDialogWithFallback<LifeLostEntry>({
    dialog,
    dt,
    maxTimer,
    isPending: (entry) => entry.choice === LifeLostChoice.PENDING,
    isAutoResolving: (entry) => entry.autoResolve,
    tickEntry: (entry) => {
      tickEntry(entry);
    },
    forceResolve: (entry) => {
      entry.choice = LifeLostChoice.ABANDON;
    },
  });
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
    plannedChoice: null,
  }));

  for (const playerId of eliminated) {
    entries.push({
      playerId,
      lives: 0,
      autoResolve: true,
      choice: LifeLostChoice.ABANDON,
      autoTimer: 0,
      focusedButton: 0,
      plannedChoice: LifeLostChoice.ABANDON,
    });
  }

  return { entries, timer: 0 };
}

/** Extract the player IDs that chose ABANDON from a resolved dialog. */
export function abandonedPlayers(
  dialog: LifeLostDialogState,
): ValidPlayerSlot[] {
  return dialog.entries
    .filter((e) => e.choice === LifeLostChoice.ABANDON)
    .map((e) => e.playerId);
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

/** Dispatch the continue / reselect branch after the life-lost dialog
 *  resolves. Game-over is no longer decided here — the round-end mutate
 *  has already peeked the outcome via `peekGameOverOutcome` and routed
 *  to `onGameOver` directly (skipping this dialog entirely when the
 *  game is going to end). So by the time we get here, we know the game
 *  continues; the only question is whether any player has to reselect
 *  their castle. */
export function resolveAfterLifeLost(deps: ResolveAfterLifeLostDeps): void {
  const { continuing, onReselect, onContinue } = deps;
  if (continuing.length > 0) onReselect(continuing);
  else onContinue();
}
