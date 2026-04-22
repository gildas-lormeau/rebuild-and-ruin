/**
 * Shared loop driver for auto-resolving dialog systems.
 *
 * Both life-lost and upgrade-pick dialogs follow the same tick shape:
 *   1. Increment a shared timer.
 *   2. For each entry that is still pending AND opts into auto-resolve,
 *      dispatch a per-entry tick (controller-owned).
 *   3. Once the timer hits a max deadline, force-resolve any remaining
 *      pending entries via a fallback callback.
 *   4. Return true once no entries remain pending.
 *
 * The helper is generic over entry shape; predicates and callbacks inject
 * the dialog-specific logic (pending check, auto-resolve flag, force
 * strategy). Bus-event emission stays in the caller callbacks — this
 * helper only drives the loop order.
 */

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
