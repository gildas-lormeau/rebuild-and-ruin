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
 *
 * ── Cross-phase pattern: per-slot done + wire signal ──
 *
 * Four phases share the same exit shape — "all active slots flagged
 * done, OR timer fallback resolves the rest". The storage differs per
 * phase but the contract is identical:
 *
 *   • SELECT / RESELECT — per-slot `selection.states[pid].confirmed`
 *     (Map). Predicate: `allSelectionsConfirmed` (game/selection.ts).
 *     Wire: `OPPONENT_TOWER_SELECTED confirmed:true`. Timer fallback:
 *     auto-confirm.
 *   • CANNON_PLACE — `state.cannonPlaceDone: Set<ValidPlayerSlot>`.
 *     Predicate: `allCannonPlaceDone` (game/cannon-system.ts). Wire:
 *     `OPPONENT_CANNON_PHASE_DONE`. Timer fallback: discard unfinished.
 *   • UPGRADE_PICK — per-entry `entry.choice !== null`. Driven by this
 *     helper. Wire: `UPGRADE_PICK`. Timer fallback: force-resolve.
 *   • LIFE_LOST — per-entry `entry.choice !== PENDING`. Driven by this
 *     helper. Wire: `LIFE_LOST_CHOICE`. Timer fallback: force-resolve.
 *
 * Architectural invariants any new phase in this family must respect:
 *   1. Local controllers flip the slot's done flag via deterministic
 *      logic. Human-kind controllers also broadcast a wire signal so
 *      remote peers can mirror the flip.
 *   2. The phase-exit predicate iterates ALL active slots — not the
 *      `local` subset. A remote-driven slot's done flag arrives via
 *      the wire; an early exit on `local.every(...)` is a parity bug.
 *   3. RNG-touching decisions cache via a "decision/commit split"
 *      (e.g. `UpgradePickEntry.plannedChoice`, `LifeLostEntry
 *      .plannedChoice`). The local tick computes the decision once
 *      regardless of whether the wire has filled the commit field —
 *      otherwise a wire-arrived commit short-circuits the local
 *      RNG draw and drifts `state.rng` between peers.
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
