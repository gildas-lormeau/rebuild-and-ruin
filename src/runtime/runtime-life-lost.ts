import { eliminatePlayers } from "../game/index.ts";
import {
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { createFireOnceSlot } from "./fire-once-slot.ts";
import {
  abandonedPlayers,
  applyLifeLostChoice,
  confirmLifeLostFocusedChoice,
  continuingPlayers,
  createLifeLostDialogState,
  isLifeLostAllResolved,
  tickLifeLostDialog,
  toggleLifeLostFocus,
} from "./runtime-life-lost-core.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";
import type { RuntimeLifeLost } from "./runtime-types.ts";

interface LifeLostSystemDeps {
  runtimeState: RuntimeState;

  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerSlot,
  ) => void;
  log: (msg: string) => void;

  requestRender: () => void;
  panelPos: (playerId: ValidPlayerSlot) => { px: number; py: number };

  /** Online-only drain for wire-arrived choices that landed before the
   *  local sim built the dialog. Called once inside `show()` immediately
   *  after the dialog is written to runtime state. The drain iterates
   *  its session-side queue, calls `apply` for each entry, then clears
   *  the queue. The system owns the find/validate/write of each entry.
   *  Undefined in local play. */
  applyEarlyChoices?: (
    apply: (playerId: ValidPlayerSlot, choice: ResolvedChoice) => boolean,
  ) => void;
}

/** Callback signature used by every resolution path (immediate skip
 *  or dialog-tick). Receives the list of players who chose CONTINUE;
 *  the caller (phase machine) routes the next transition based on it. */
type OnLifeLostResolved = (continuing: readonly ValidPlayerSlot[]) => void;

/** Extended return type: RuntimeLifeLost + extras for game-runtime wiring. */
export type LifeLostSystem = RuntimeLifeLost & {
  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerSlot,
  ) => void;
  /** Toggle continue/abandon focus for a player's pending entry. */
  toggleFocus: (playerId: ValidPlayerSlot) => void;
  /** Confirm the currently focused choice for a player (applies the focused option). */
  confirmChoice: (playerId: ValidPlayerSlot) => void;
  /** Apply a direct choice (e.g. from spatial click on a specific button). */
  applyChoice: (playerId: ValidPlayerSlot, choice: ResolvedChoice) => void;
};

export function createLifeLostSystem(deps: LifeLostSystemDeps): LifeLostSystem {
  const { runtimeState } = deps;

  /** Set when a dialog is shown; cleared once resolution fires. The
   *  tick loop reads it to invoke the caller's onResolved callback.
   *  Shared `FireOnceSlot` shape — same storage pattern as score-delta
   *  and upgrade-pick. Tick is gated on Mode.LIFE_LOST (the only axis
   *  that actually differs). See docs/dialog-completion-patterns.md. */
  const pendingOnDone = createFireOnceSlot<[readonly ValidPlayerSlot[]]>();

  /** Drive the life-lost flow to completion. Either resolves
   *  immediately (nothing to show) and calls `onResolved([])`, or
   *  shows the modal dialog and calls `onResolved(continuing)` once
   *  the dialog's tick loop resolves every entry.
   *
   *  Drains queued early-arrived wire choices (online only) before
   *  returning, so the dialog's first tick observes them as if they
   *  arrived after the dialog opened.
   *
   *  Returns true when a dialog was actually shown. */
  function show(
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
    onResolved: OnLifeLostResolved,
  ): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    deps.log(
      `show lifeLost: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    const dialog = createLifeLostDialogState({
      needsReselect,
      eliminated,
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remotePlayerSlots,
      needsLocalInput: (playerId) =>
        !runtimeState.controllers[playerId]!.autoResolvesLifeLost(),
    });
    // Skip dialog if all entries are already resolved (e.g. only eliminations).
    if (isLifeLostAllResolved(dialog)) {
      deps.log("show lifeLost: all pre-resolved, skipping dialog");
      eliminatePlayers(runtimeState.state, abandonedPlayers(dialog));
      onResolved(continuingPlayers(dialog));
      return false;
    }
    runtimeState.dialogs.lifeLost = dialog;
    pendingOnDone.set(onResolved);
    setMode(runtimeState, Mode.LIFE_LOST);
    deps.applyEarlyChoices?.((playerId, choice) => {
      const entry = dialog.entries.find(
        (candidate) =>
          candidate.playerId === playerId &&
          candidate.choice === LifeLostChoice.PENDING,
      );
      if (!entry) return false;
      entry.choice = choice;
      return true;
    });
    return true;
  }

  /**
   * Tick the life-lost dialog; when every entry is resolved, eliminate
   * abandoned players and fire the caller's onResolved callback with
   * the continuing list. The callback chain is synchronous: postDisplay
   * runs inline, dispatches the next transition, and that transition's
   * setMode call overwrites Mode.LIFE_LOST before any frame renders.
   */
  function tickLifeLostDialogSystem(dt: number) {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return;

    const state = runtimeState.state;
    const dialogResolved = tickLifeLostDialog(
      dialog,
      dt,
      LIFE_LOST_MAX_TIMER,
      (entry) =>
        runtimeState.controllers[entry.playerId]!.tickLifeLost(
          entry,
          dt,
          LIFE_LOST_AUTO_DELAY,
          state,
        ),
    );

    deps.requestRender();

    if (!dialogResolved) return;

    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );

    eliminatePlayers(runtimeState.state, abandonedPlayers(dialog));

    const continuing = continuingPlayers(dialog);
    runtimeState.dialogs.lifeLost = null;

    pendingOnDone.fire(continuing);
  }

  function toggleFocus(playerId: ValidPlayerSlot): void {
    withPendingEntry(playerId, (entry) => toggleLifeLostFocus(entry));
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    withPendingEntry(playerId, (entry) => {
      const choice = confirmLifeLostFocusedChoice(entry);
      deps.sendLifeLostChoice(choice, entry.playerId);
    });
  }

  /** Apply a direct choice (e.g. from a mouse click on a specific button).
   *  Unlike confirmChoice, this sets the choice directly without reading focus. */
  function applyChoice(
    playerId: ValidPlayerSlot,
    choice: ResolvedChoice,
  ): void {
    withPendingEntry(playerId, (entry) => {
      applyLifeLostChoice(entry, choice);
      deps.sendLifeLostChoice(choice, playerId);
    });
  }

  function findPendingEntry(
    playerId: ValidPlayerSlot,
  ): LifeLostEntry | undefined {
    return runtimeState.dialogs.lifeLost?.entries.find(
      (entry) =>
        entry.playerId === playerId && entry.choice === LifeLostChoice.PENDING,
    );
  }

  function withPendingEntry(
    playerId: ValidPlayerSlot,
    action: (entry: LifeLostEntry) => void,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    action(entry);
  }

  return {
    /** Read current dialog state. Used by input-gate and remote-choice handlers
     *  to check whether a dialog is active. */
    get: () => runtimeState.dialogs.lifeLost,
    /** Clear dialog state on session reset / host promote (only ever called
     *  with null in production; the type permits a value for symmetry). */
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.dialogs.lifeLost = dialog;
      if (dialog === null) pendingOnDone.clear();
    },
    show,
    tick: tickLifeLostDialogSystem,
    panelPos: deps.panelPos,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice: deps.sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
    applyChoice,
  };
}
