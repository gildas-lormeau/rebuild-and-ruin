/**
 * Shared helpers for the auto-resolving dialog systems (life-lost,
 * upgrade-pick): the per-frame tick loop (timer bump → per-entry tick →
 * max-deadline force-resolve) plus the lockstep-choice trio (ownership
 * predicate, pending-entry lookup, schedule-or-apply). Generic over
 * entry shape; predicates + callbacks inject dialog-specific logic.
 * Bus-event emission stays in the caller callbacks.
 */

import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";

interface DialogTickState<TEntry> {
  timer: number;
  readonly entries: readonly TEntry[];
}

interface DialogTickParams<TEntry> {
  readonly dialog: DialogTickState<TEntry>;
  readonly dt: number;
  readonly maxTimer: number;
  /** True when the entry is still pending (no choice yet). */
  readonly isPending: (entry: TEntry) => boolean;
  /** True when the entry opts into auto-resolve ticking (before max-timer). */
  readonly isAutoResolving: (entry: TEntry) => boolean;
  /** Per-entry auto-resolve tick; invoked only for pending auto-resolving entries. */
  readonly tickEntry: (entry: TEntry, entryIdx: number) => void;
  /** Max-timer fallback; invoked only for still-pending entries when timer >= maxTimer. */
  readonly forceResolve: (entry: TEntry, entryIdx: number) => void;
}

interface LockstepChoiceParams {
  /** Online signal — false in local play, where the choice applies
   *  immediately instead of round-tripping through the action schedule. */
  readonly online: boolean;
  readonly playerId: ValidPlayerId;
  /** Slots with a broadcast choice awaiting its applyAt tick. Blocks
   *  duplicate sends while the entry still reads as pending — both from
   *  a repeat press and from the max-timer force loop re-firing every
   *  tick. */
  readonly inFlight: Set<ValidPlayerId>;
  readonly simTick: number;
  readonly schedule: (action: {
    applyAt: number;
    playerId: ValidPlayerId;
    apply: () => void;
  }) => void;
  /** Local-play apply — mutate the entry now. */
  readonly applyLocal: () => void;
  /** Online: broadcast the choice with the lockstep stamp (and any
   *  cosmetic immediate feedback, e.g. focus snap). */
  readonly send: (applyAt: number) => void;
  /** Online: the scheduled apply that lands at `applyAt` on every peer. */
  readonly applyAtTick: () => void;
}

/** Drive one frame of a dialog's auto-resolve loop.
 *  Returns true when every entry has been resolved. */
export function tickDialogWithFallback<TEntry>(
  params: DialogTickParams<TEntry>,
): boolean {
  const {
    dialog,
    dt,
    maxTimer,
    isPending,
    isAutoResolving,
    tickEntry,
    forceResolve,
  } = params;

  dialog.timer += dt;

  for (let entryIdx = 0; entryIdx < dialog.entries.length; entryIdx++) {
    const entry = dialog.entries[entryIdx]!;
    if (!isPending(entry)) continue;
    if (!isAutoResolving(entry)) continue;
    tickEntry(entry, entryIdx);
  }

  if (dialog.timer >= maxTimer) {
    for (let entryIdx = 0; entryIdx < dialog.entries.length; entryIdx++) {
      const entry = dialog.entries[entryIdx]!;
      if (isPending(entry)) forceResolve(entry, entryIdx);
    }
  }

  for (const entry of dialog.entries) {
    if (isPending(entry)) return false;
  }
  return true;
}

/** True when this machine owns the entry's input: not auto-resolving
 *  (real human) and not driven by a remote peer. The owning peer funnels
 *  clicks AND max-timer force-resolves for its entries through the
 *  lockstep choice path; every other peer only backstops after the
 *  force grace window. */
export function isLocallyDrivenEntry(
  entry: { readonly playerId: ValidPlayerId; readonly autoResolve: boolean },
  remotePlayerSlots: ReadonlySet<ValidPlayerId>,
): boolean {
  return !entry.autoResolve && !remotePlayerSlots.has(entry.playerId);
}

/** Find `playerId`'s still-pending entry, or undefined when the dialog
 *  is closed or the entry already resolved. */
export function findPendingDialogEntry<
  TEntry extends { readonly playerId: ValidPlayerId },
>(
  entries: readonly TEntry[] | undefined,
  playerId: ValidPlayerId,
  isPending: (entry: TEntry) => boolean,
): TEntry | undefined {
  return entries?.find(
    (entry) => entry.playerId === playerId && isPending(entry),
  );
}

/** Lockstep-when-online dialog choice. Local play mutates the entry
 *  immediately; online play broadcasts with `applyAt` and schedules the
 *  local apply at the same `applyAt`, so every peer's entry mutation
 *  lands at the same logical tick. Shared by life-lost choices and
 *  upgrade picks. */
export function scheduleOrApplyDialogChoice(
  params: LockstepChoiceParams,
): void {
  if (!params.online) {
    params.applyLocal();
    return;
  }
  if (params.inFlight.has(params.playerId)) return;
  params.inFlight.add(params.playerId);
  const applyAt = params.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
  params.send(applyAt);
  params.schedule({
    applyAt,
    playerId: params.playerId,
    apply: () => {
      params.inFlight.delete(params.playerId);
      params.applyAtTick();
    },
  });
}
