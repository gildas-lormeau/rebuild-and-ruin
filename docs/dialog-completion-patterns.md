# Dialog Completion Patterns

The runtime has four sub-systems that hand a driving phase-machine a "fire once when done" callback — three modal dialogs (score-delta display, life-lost, upgrade-pick) and the banner sweep animator. Callback storage is **shared**: all four use a closure-scoped [`FireOnceSlot`](../src/runtime/fire-once-slot.ts). The real axes of variation are **tick scope** (when the slot is allowed to fire) and **trigger** (what condition fires it).

## The four systems

| System | File | Tick scope | Fire trigger |
|---|---|---|---|
| Score deltas | [runtime-score-deltas.ts](../src/runtime/runtime-score-deltas.ts) | Mode-independent | `deltaTimer` reaches 0 |
| Life lost | [runtime-life-lost.ts](../src/runtime/runtime-life-lost.ts) | `Mode.LIFE_LOST` only | All entries resolved |
| Upgrade pick | [runtime-upgrade-pick.ts](../src/runtime/runtime-upgrade-pick.ts) | `Mode.UPGRADE_PICK` only | All entries picked |
| Banner sweep | [runtime-banner.ts](../src/runtime/runtime-banner.ts) | Banner status `sweeping` | `progress` reaches 1 |

## Tick scope

**Mode-independent** — the score-delta overlay plays during the whole post-build transition chain (banners, castle construction, reselect handoff). Its timer is driven unconditionally from the main loop so the overlay can finish on its own wall-clock schedule while other mode-owning systems animate alongside it.

**Mode-scoped** — life-lost and upgrade-pick own their mode for the duration of the dialog. When the dialog resolves, the mode flips to whatever comes next; when the mode is set elsewhere (host-driven watcher, shutdown), the dialog goes away with it. Mode-scoping means no re-entrancy check is needed at tick time.

**Status-scoped** — the banner is gated on `runtimeState.banner.status === "sweeping"` rather than a `Mode.X`. The banner system runs under `Mode.TRANSITION` (set by `showBanner` itself) but multiple banners chain back-to-back through one transition; status discriminates which one is animating now. `pendingOnDone.set` is called on each `showBanner` (overwriting the previous pending callback if a new banner arrives mid-sweep — same semantics as the old field-based design).

## Callback storage (shared)

All four sub-systems create a closure-scoped `FireOnceSlot` at factory-init time:

```ts
const pendingOnDone = createFireOnceSlot();
// ...later:
pendingOnDone.set(onDone); // when show()/tryShow() accepts the callback
pendingOnDone.fire();      // exactly once, when the dialog resolves
pendingOnDone.clear();     // when a watcher-role force-clear wipes the dialog
```

The slot handles null-before-call ordering internally, so a callback that re-enters the owning sub-system can safely call `set` again without being swallowed. Life-lost parameterises the slot with a `[readonly ValidPlayerSlot[]]` args tuple to pass the continuing-player list through to its resolver.

## Adding a fifth user

1. Pick the tick scope that matches your needs (mode-independent if you need to play during banners; mode-scoped if you own a `Mode.X`; status-scoped if you live under a shared mode but need to discriminate which animation is active).
2. Create a `FireOnceSlot` at the top of your factory and rename it `pendingOnDone` for consistency with the other four.
3. Gate fire on your scope (mode, status, or unconditional) and `fire()` exactly once on completion. Call `clear()` from any teardown path that drops the pending callback without firing.
