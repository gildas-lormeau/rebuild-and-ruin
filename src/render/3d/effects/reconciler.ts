/**
 * Generic incremental reconciliation between an entry list and per-entry
 * hosts (impacts / cannon-burns / tile-burst). `createReconciler` takes
 * (keyOf, build, dispose, animate) and returns `update(entries)` that
 * only builds new entries, disposes departed hosts, and animates every
 * still-live pairing — replacing the earlier signature-rebuild pattern
 * that thrashed GPU resources during battle peaks.
 */

interface ReconcilerOpts<Entry, Host, Key = Entry> {
  /** Stable identity for an entry. Defaults to the entry object itself
   *  (works when entries are mutated in-place across frames, which is
   *  the natural pattern for the ageImpacts-style array). Pass a
   *  function returning a string / number when entries are recreated
   *  per frame and a derived key is more stable. */
  readonly keyOf?: (entry: Entry) => Key;
  /** Allocate the per-entry host the first time `entry` appears. */
  readonly build: (entry: Entry) => Host;
  /** Free GPU / scene-graph resources for an aged-out host. */
  readonly dispose: (host: Host) => void;
  /** Per-frame update — called for every still-live (host, entry) pair. */
  readonly animate: (host: Host, entry: Entry) => void;
}

interface Reconciler<Entry> {
  /** Reconcile `hosts` against `entries` and animate every survivor. */
  update(entries: readonly Entry[]): void;
  /** Dispose every live host (call from the manager's `dispose`). */
  disposeAll(): void;
}

export function createReconciler<Entry extends object, Host, Key = Entry>(
  opts: ReconcilerOpts<Entry, Host, Key>,
): Reconciler<Entry> {
  const keyOf = opts.keyOf ?? ((entry: Entry) => entry as unknown as Key);
  const hosts = new Map<Key, Host>();
  // Scratch set reused across frames so steady-state updates don't
  // allocate. Cleared at the start of every `update`.
  const seen = new Set<Key>();

  return {
    update(entries) {
      seen.clear();
      for (const entry of entries) {
        const key = keyOf(entry);
        seen.add(key);
        let host = hosts.get(key);
        if (!host) {
          host = opts.build(entry);
          hosts.set(key, host);
        }
        opts.animate(host, entry);
      }
      for (const [key, host] of hosts) {
        if (seen.has(key)) continue;
        opts.dispose(host);
        hosts.delete(key);
      }
    },
    disposeAll() {
      for (const host of hosts.values()) opts.dispose(host);
      hosts.clear();
    },
  };
}
