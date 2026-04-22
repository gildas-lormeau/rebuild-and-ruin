# Dialog Completion Patterns

The runtime has three modal-dialog systems — score-delta display, life-lost, and upgrade-pick — that each track a "fire once when done" callback. They store that callback three different ways on purpose. This doc explains the decision so a fourth dialog doesn't re-invent it (or, worse, copy the wrong pattern).

## The three systems

| System | File | Callback field | Tick scope |
|---|---|---|---|
| Score deltas | [runtime-score-deltas.ts](../src/runtime/runtime-score-deltas.ts) | `runtimeState.scoreDisplay.deltaOnDone` (on state) | Mode-independent |
| Life lost | [runtime-life-lost.ts](../src/runtime/runtime-life-lost.ts) | `pendingOnResolved` (closure) | `Mode.LIFE_LOST` only |
| Upgrade pick | [runtime-upgrade-pick.ts](../src/runtime/runtime-upgrade-pick.ts) | `resolveCallback` (closure) | `Mode.UPGRADE_PICK` only |

## Decision rules

Two independent axes drive the choice:

### 1. Where the callback lives

**On `runtimeState`** when the callback must survive across arbitrary mode transitions. The score-delta display ticks during banners and castle-build animations — its timer is driven from the main loop regardless of mode — so the callback needs a stable home reachable from anywhere in the mode graph.

**In a closure** when the dialog is only ever ticked in its own mode. Life-lost and upgrade-pick gate their tick on `mode === Mode.LIFE_LOST` / `Mode.UPGRADE_PICK`; once the mode flips away, nothing ticks, so a closure-scoped `let` is enough and keeps the field out of serialized state.

### 2. When the timer ticks

**Mode-independent** — score-delta display overlays the map during the whole post-build transition chain (banners, castle construction, reselect handoff). The overlay must finish on its own wall-clock schedule even while other mode-owning systems animate.

**Mode-scoped** — life-lost and upgrade-pick own their mode for the duration of the dialog. When the dialog resolves, the mode flips to whatever comes next; when the mode is set elsewhere (host-driven watcher, shutdown), the dialog goes away with it. Mode-scoping means no re-entrancy check is needed at tick time.

## How to pick when adding a fourth dialog

1. Does your dialog need to tick while the mode is something else (banner animation, cross-phase overlay)? → put the callback on `runtimeState`.
2. Otherwise → keep it in the closure and gate tick on your mode.

Whichever you pick, fire the callback exactly once (the existing three use `fireOnce` / explicit-clear patterns — mirror one of them). Do not store both a closure callback *and* a state field; pick one home, document why near the field, and link back to this file.

## Why not unify

A shared `DialogCompletionController` abstraction was considered and rejected:

- The two storage strategies serve genuinely different invariants (mode-independence vs. mode-scoping). Collapsing them would force score-delta's state-field into life-lost/upgrade-pick, growing `RuntimeState` for no gain, or force life-lost/upgrade-pick's closure semantics onto score-delta, breaking its cross-mode tick.
- The tick guards are already one-liners (`if (dialog.timer <= 0) return`, `if (!dialog) return`). There's nothing meaningful to factor out.
- The three call sites are 12–30 lines each. A shared abstraction would be longer than what it replaces.

Three parallel implementations with a shared decision doc is the right weight for this surface. Revisit if a fourth dialog lands and matches one of the existing patterns byte-for-byte.
