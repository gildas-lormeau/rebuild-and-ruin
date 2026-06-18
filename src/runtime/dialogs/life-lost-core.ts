import {
  type AutoResolveDeps,
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
  shouldAutoResolve,
} from "../../shared/core/dialog-state.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type { GameState } from "../../shared/core/types.ts";
import { tickDialogWithFallback } from "./dialog-tick.ts";

interface CreateLifeLostDialogDeps extends AutoResolveDeps {
  needsReselect: readonly ValidPlayerId[];
  eliminated: readonly ValidPlayerId[];
  state: GameState;
}

interface ResolveAfterLifeLostDeps {
  continuing: readonly ValidPlayerId[];
  onReselect: (continuing: readonly ValidPlayerId[]) => void;
  onAdvance: () => void;
}

/** Per-entry auto-resolve tick. Dispatched by the runtime to the owning
 *  controller (`controller.tickLifeLost`). Closes over the per-call
 *  GameState, `dt`, and `autoDelaySeconds`. */
type ControllerLifeLostTick = (entry: LifeLostEntry) => void;

/** Tick the life-lost dialog.
 *
 *  Drives dialog-layer state only: increments `dialog.timer`, delegates
 *  each pending auto-resolve entry to the per-entry `tickEntry` callback,
 *  and delegates max-timer expiry to `forceResolve`. Both callbacks
 *  dispatch to the subsystem, which owns ownership routing (owner-funnel
 *  vs grace backstop) and the entry write.
 *
 *  Returns true when all entries are resolved.
 *  @param dt — Delta time in seconds (not ms).
 *  @param maxTimer — Global force-resolve deadline in seconds.
 *  @param tickEntry — Per-entry tick (closed over state + dt + autoDelay).
 *  @param forceResolve — Called every tick past `maxTimer` for each
 *    still-pending entry; must eventually resolve it. */
// Shares the auto-resolve + force-resolve loop with tickUpgradePickDialog via tickDialogWithFallback.
export function tickLifeLostDialog(
  dialog: LifeLostDialogState,
  dt: number,
  maxTimer: number,
  tickEntry: ControllerLifeLostTick,
  forceResolve: (entry: LifeLostEntry) => void,
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
    forceResolve,
  });
}

/** True when every entry has been resolved (no PENDING choices remain). */
export function isLifeLostAllResolved(dialog: LifeLostDialogState): boolean {
  return dialog.entries.every((e) => e.choice !== LifeLostChoice.PENDING);
}

/** Extract the player IDs that chose CONTINUE from a resolved dialog. */
export function continuingPlayers(
  dialog: LifeLostDialogState,
): ValidPlayerId[] {
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

/** Extract the player IDs that chose ABANDON from a resolved dialog. */
export function abandonedPlayers(dialog: LifeLostDialogState): ValidPlayerId[] {
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

/** Apply a direct choice (e.g. from a spatial click on a specific button). */
export function applyLifeLostChoice(
  entry: LifeLostEntry,
  choice: ResolvedChoice,
): void {
  entry.choice = choice;
}

/** Read the focused button as a resolved choice without mutating the entry.
 *  Used by the lockstep schedule path — the mutation happens later in the
 *  scheduled `apply` closure, not at click time. */
export function focusedLifeLostChoice(entry: LifeLostEntry): ResolvedChoice {
  return entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE
    ? LifeLostChoice.CONTINUE
    : LifeLostChoice.ABANDON;
}

/** Apply a lockstep-scheduled life-lost choice to whichever peer's dialog
 *  state is live at drain time. Shared between originator and receiver so
 *  the apply behaves identically on every peer; a choice that lost the
 *  first-wins race (entry already resolved) or arrived with no dialog
 *  open is a silent no-op — the RECEIVER's schedule closure handles the
 *  no-dialog case by round-stamped early-queueing (see
 *  `handleLifeLostChoice` in online-server-events.ts). */
export function applyLifeLostChoiceToDialog(
  playerId: ValidPlayerId,
  choice: ResolvedChoice,
  dialog: LifeLostDialogState | null,
): void {
  if (!dialog) return;
  const entry = dialog.entries.find((e) => e.playerId === playerId);
  if (entry && entry.choice === LifeLostChoice.PENDING) {
    entry.choice = choice;
  }
}

/** Dispatch the continue / reselect branch after the life-lost dialog
 *  resolves. Game-over is no longer decided here — the round-end mutate
 *  peeks the outcome via `peekGameOverOutcome` before the dialog, and
 *  `routeLifeLostResolution` re-checks last-player-standing after the
 *  dialog's own ABANDON/AFK eliminations; both route to `onGameOver`
 *  without reaching this function. So by the time we get here, we know
 *  the game continues; the only question is whether any player has to
 *  reselect their castle. */
export function resolveAfterLifeLost(deps: ResolveAfterLifeLostDeps): void {
  const { continuing, onReselect, onAdvance } = deps;
  if (continuing.length > 0) onReselect(continuing);
  else onAdvance();
}
