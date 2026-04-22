# Dialog Completion Patterns

The runtime has three modal-dialog sub-systems — score-delta display, life-lost, and upgrade-pick — that each hand a driving phase-machine a "fire once when done" callback. Callback storage is **shared**: all three use a closure-scoped [`FireOnceSlot`](../src/runtime/fire-once-slot.ts). The real axis of variation between them is **tick scope**.

## The three systems

| System | File | Tick scope |
|---|---|---|
| Score deltas | [runtime-score-deltas.ts](../src/runtime/runtime-score-deltas.ts) | Mode-independent |
| Life lost | [runtime-life-lost.ts](../src/runtime/runtime-life-lost.ts) | `Mode.LIFE_LOST` only |
| Upgrade pick | [runtime-upgrade-pick.ts](../src/runtime/runtime-upgrade-pick.ts) | `Mode.UPGRADE_PICK` only |

## Tick scope

**Mode-independent** — the score-delta overlay plays during the whole post-build transition chain (banners, castle construction, reselect handoff). Its timer is driven unconditionally from the main loop so the overlay can finish on its own wall-clock schedule while other mode-owning systems animate alongside it.

**Mode-scoped** — life-lost and upgrade-pick own their mode for the duration of the dialog. When the dialog resolves, the mode flips to whatever comes next; when the mode is set elsewhere (host-driven watcher, shutdown), the dialog goes away with it. Mode-scoping means no re-entrancy check is needed at tick time.

## Callback storage (shared)

All three sub-systems create a closure-scoped `FireOnceSlot` at factory-init time:

```ts
const pendingOnDone = createFireOnceSlot();
// ...later:
pendingOnDone.set(onDone); // when show()/tryShow() accepts the callback
pendingOnDone.fire();      // exactly once, when the dialog resolves
pendingOnDone.clear();     // when a watcher-role force-clear wipes the dialog
```

The slot handles null-before-call ordering internally, so a callback that re-enters the owning sub-system can safely call `set` again without being swallowed. Life-lost parameterises the slot with a `[readonly ValidPlayerSlot[]]` args tuple to pass the continuing-player list through to its resolver.

## Adding a fourth dialog

1. Pick the tick scope that matches your needs (mode-independent if you need to play during banners; mode-scoped otherwise).
2. Create a `FireOnceSlot` at the top of your factory and rename it `pendingOnDone` for consistency with the other three.
3. Gate tick on your mode (or don't, if mode-independent) and `fire()` exactly once on completion.
