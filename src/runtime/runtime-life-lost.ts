import {
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  applyLifeLostChoice,
  confirmLifeLostFocusedChoice,
  continuingPlayers,
  createLifeLostDialogState,
  eliminateAbandoned,
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

  render: () => void;
  panelPos: (playerId: ValidPlayerSlot) => { px: number; py: number };
  /** Permanently disable auto-zoom. Fired when the pov player abandons
   *  (or is force-eliminated) so the camera stops following the game.
   *  Spec: `life lost popup → abandon → unzoom → spectator mode
   *  (no more auto-zoom anymore)`. */
  disableAutoZoom: () => void;
}

/** Callback signature used by every resolution path (immediate skip,
 *  dialog-tick on host, dialog-tick on watcher). Receives the list of
 *  players who chose CONTINUE; the caller (phase machine) routes the
 *  next transition based on it. */
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
   *  tick loop reads it to invoke the caller's onResolved callback. */
  let pendingOnResolved: OnLifeLostResolved | undefined;

  /** Drive the life-lost flow to completion. Either resolves
   *  immediately (nothing to show) and calls `onResolved([])`, or
   *  shows the modal dialog and calls `onResolved(continuing)` once
   *  the dialog's tick loop resolves every entry.
   *
   *  Returns true when a dialog was actually shown (so watcher-side
   *  wiring can apply any early-arrived choices before the first
   *  tick). */
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
      eliminateAbandoned(dialog, runtimeState.state);
      disableAutoZoomIfPovEliminated();
      onResolved(continuingPlayers(dialog));
      return false;
    }
    runtimeState.dialogs.lifeLost = dialog;
    pendingOnResolved = onResolved;
    setMode(runtimeState, Mode.LIFE_LOST);
    return true;
  }

  /**
   * Tick the life-lost dialog; when every entry is resolved, eliminate
   * abandoned players, disable PoV auto-zoom if needed, and fire the
   * caller's onResolved callback with the continuing list. On the
   * watcher-role, the callback's implementation is usually a no-op for
   * the continue / reselect paths (server drives the next phase); the
   * machine's postDisplay still runs the same resolve-branch logic so
   * local game-over can flip Mode.STOPPED.
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

    deps.render();

    if (!dialogResolved) return;

    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );

    eliminateAbandoned(dialog, runtimeState.state);
    disableAutoZoomIfPovEliminated();

    const continuing = continuingPlayers(dialog);
    const onResolved = pendingOnResolved;
    pendingOnResolved = undefined;
    runtimeState.dialogs.lifeLost = null;

    // Non-host: flip back to Mode.GAME so the server's next checkpoint
    // takes over. The machine's postDisplay still runs the shared
    // resolve-branch logic but its watcher-role handlers are no-ops
    // except for the game-over branch (Mode.STOPPED).
    if (!runtimeState.frameMeta.hostAtFrameStart) {
      setMode(runtimeState, Mode.GAME);
    }

    onResolved?.(continuing);
  }

  /** Flip the camera permanently to spectator mode if the pov player
   *  just got eliminated (lives hit 0 — covers abandon and forced
   *  eliminations alike). Runs right after `eliminateAbandoned` so the
   *  check sees the post-resolution player state. */
  function disableAutoZoomIfPovEliminated(): void {
    const povId = runtimeState.frameMeta.povPlayerId;
    const povPlayer = runtimeState.state.players[povId];
    if (povPlayer && isPlayerEliminated(povPlayer)) {
      deps.disableAutoZoom();
    }
  }

  function findPendingEntry(playerId: ValidPlayerSlot) {
    return runtimeState.dialogs.lifeLost?.entries.find(
      (e) => e.playerId === playerId && e.choice === LifeLostChoice.PENDING,
    );
  }

  function toggleFocus(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (entry) toggleLifeLostFocus(entry);
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    const choice = confirmLifeLostFocusedChoice(entry);
    deps.sendLifeLostChoice(choice, entry.playerId);
  }

  /** Apply a direct choice (e.g. from a mouse click on a specific button).
   *  Unlike confirmChoice, this sets the choice directly without reading focus. */
  function applyChoice(
    playerId: ValidPlayerSlot,
    choice: ResolvedChoice,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    applyLifeLostChoice(entry, choice);
    deps.sendLifeLostChoice(choice, playerId);
  }

  return {
    /** Read current dialog state. Used by watcher-mode to sync overlay display. */
    get: () => runtimeState.dialogs.lifeLost,
    /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.dialogs.lifeLost = dialog;
      if (dialog === null) pendingOnResolved = undefined;
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
