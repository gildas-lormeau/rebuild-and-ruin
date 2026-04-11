# `src/input/` — Input, sound, and haptics subsystems

The **input** domain owns browser input (keyboard, mouse, touch),
touch UI rendering, the sound system (jsfxr + Web Audio), and the
haptics system (navigator.vibrate). These are the "talk to the
browser hardware" subsystems, the bottom layer that converts physical
events into game-visible actions.

Despite the name "input", this folder ALSO holds the sound and
haptics systems. They live here because they're all "browser-device"
concerns that the runtime wires in the same way: factory +
per-event handler + observer seam for tests.

## Read these first

1. **[input-dispatch.ts](./input-dispatch.ts)** — Shared input
   dispatch helpers: `dispatchPointerMove` routes a pointer event
   to the right player based on which slot owns the pointer input.
2. **[input-keyboard.ts](./input-keyboard.ts)** — Keyboard handler
   registration. Each player has their own key bindings; the
   handler routes events to the right controller. **Start here to
   understand the keyboard → action → controller → intent flow.**
3. **[sound-system.ts](./sound-system.ts)** — Sound factory with an
   observer seam for tests. Worth reading to see the "factory +
   observer" pattern that haptics mirrors.

## File categories

### Input event handlers (browser → runtime)
- **`input-keyboard.ts`** — `registerKeyboardHandlers()` — per-slot
  keydown/keyup routing based on `KeyBindings`. Each player's keys
  are different.
- **`input-mouse.ts`** — `registerMouseHandlers()` — mouse move,
  click, rotate (shift+click).
- **`input-touch-canvas.ts`** — `registerTouchHandlers()` — touch
  start/move/end on the canvas.
- **`input-seed-field.ts`** — `createSeedField()` — an in-DOM digit
  entry widget for the lobby seed field.
- **`input-dispatch.ts`** — Shared dispatch helpers (pointer-to-player
  routing, event normalization).
- **`input.ts`** — Shared input type definitions (no logic, just types).

### Touch UI (mobile on-screen controls)
- **`input-touch-ui.ts`** — Factory functions that wire event handlers
  to the static touch controls in `index.html`: d-pad, confirm,
  rotate, zoom buttons, quit button, floating actions menu. Called
  once by the composition root, returns handles stored in
  `touchHandles`.
- **`input-touch-update.ts`** — Per-frame update logic for the touch
  controls: show/hide d-pad based on phase, loupe zoom on long-press,
  floating action menu visibility.

### Device output (sound + haptics)
- **`sound-system.ts`** — Sound factory: jsfxr for one-shot SFX,
  Web Audio API for multi-layered sounds (cannon boom, impact,
  cannonball whistle, building). Exposes a `SoundSystem` handle with
  `played(reason)` observer seam.
- **`haptics-system.ts`** — Vibration factory. No-op on devices
  without vibration support. Same observer seam pattern.

### Dev tool
- **`input-recorder.ts`** — Captures touch/mouse/keyboard events
  for replay testing. In-page widget, guarded by a query param.

## The observer seam (test-first design)

Both `sound-system.ts` and `haptics-system.ts` expose a mandatory
observer interface:

```ts
export interface HapticsObserver {
  vibrate?(reason: HapticsReason, ms: number, minLevel: HapticsLevel): void;
}

export function createHapticsSystem(opts: {
  observer?: HapticsObserver;
}): HapticsSystem {
  // ... real impl calls observer?.vibrate(...) before the platform gate
}
```

The observer fires **before** the platform/level gate, so tests can
assert on intended haptic/sound events without needing a real
`navigator.vibrate` or `AudioContext`. Production callers omit the
observer — it's for test inspection only.

If you're adding a new output system (e.g., screen shake, flashlight
pulse on mobile), follow the same pattern:
1. Define a typed `Reason` enum for the distinct events.
2. Define an `XxxObserver` interface.
3. The factory takes an optional observer and calls it before the
   platform gate.
4. Tests plug in an observer via `HeadlessRuntimeOptions`.

See `test/haptics-observer.test.ts` and `test/sound-observer.test.ts`
for examples.

## Per-player key bindings

Shared-screen play means each player has their own keybindings.
`KeyBindings` lives in `src/shared/ui/player-config.ts`. Default
bindings are in `PLAYER_KEY_BINDINGS`. The keyboard handler routes
events by checking `event.key` against each player's bindings in
turn. First match wins. Don't assume keys are unique across players —
the user can (and does) rebind.

The options menu's keybinding UI is in `src/runtime/runtime-options.ts`
— it interacts with this folder only through `KeyBindings` objects,
not through handler state.

## Touch on desktop fallback

`IS_TOUCH_DEVICE` in `src/shared/platform/platform.ts` is the truth
source. On desktop, touch handlers are still registered (for
dev tools + laptops with touchscreens), but the touch UI is hidden.
Don't gate touch event handling on `IS_TOUCH_DEVICE` — gate only
the UI visibility.

## Common operations

### Add a new key binding
1. Add a new `Action` to the enum in `src/shared/ui/input-action.ts`.
2. Add a default binding in `PLAYER_KEY_BINDINGS` in
   `shared/ui/player-config.ts`.
3. Handle the action in `input-keyboard.ts` or wherever relevant.
4. If it's a UI-rebindable action, add to the options menu entry
   list in `src/runtime/runtime-options.ts`.

### Add a new sound effect
1. Add the reason to `SoundReason` enum in `sound-system.ts`.
2. Add a jsfxr params entry or Web Audio synth call.
3. Call `sound.play(SoundReason.X)` from the relevant game event
   handler (usually in a runtime subsystem, not game/).
4. If tests should observe it, add a case to the observer interface.

### Add a new haptic event
Similar to sound: add reason, add case in `createHapticsSystem`,
call from event handler.

### Debug "click does nothing"
Start at `input-mouse.ts` / `input-touch-canvas.ts` to verify the
event fires. Then step into `input-dispatch.ts` to see pointer
routing. Then into `runtime-input.ts` to see action dispatch. Then
into `controller-human.ts` to see intent generation.

## Gotchas

- **Touch UI factory functions are called ONCE.** The runtime
  stores the returned handles in `touchHandles` and calls their
  `update()` methods each frame. Don't try to recreate them on every
  frame — it would leak event listeners.

- **Sound system has a lazy Web Audio init.** The `AudioContext`
  can't be created until after user interaction (browser policy).
  The factory defers `new AudioContext()` until the first play call.
  Don't try to preload audio at module init time.

- **`input-recorder.ts` is dev-only.** Guarded by a URL query param;
  not wired into production builds. If you touch it, verify
  `IS_DEV` gating still holds.

- **Keyboard handlers are registered against `document`, not the
  canvas.** This means focus matters — if a DOM input field has
  focus, keystrokes go there instead of the game. The lobby seed
  field (`input-seed-field.ts`) explicitly detects this and refocuses
  the game on blur.

- **`input-touch-ui.ts` queries static DOM elements from
  `index.html`.** If you rename a touch control's ID in the HTML,
  the factory will silently return a non-functional handle. Keep
  IDs in sync.

## Related reading

- **[src/runtime/runtime-input.ts](../runtime/runtime-input.ts)** —
  The runtime subsystem that wires input handlers to controllers
  via the deps bag.
- **[src/player/controller-human.ts](../player/controller-human.ts)**
  — The human controller that consumes the events this folder emits.
- **[src/shared/ui/player-config.ts](../shared/ui/player-config.ts)**
  — `KeyBindings` + `PLAYER_KEY_BINDINGS` (default bindings).
- **[test/input-lobby.test.ts](../../test/input-lobby.test.ts)** —
  Example of driving lobby input through the real dispatch path.
- **[test/haptics-observer.test.ts](../../test/haptics-observer.test.ts)**
  — Example of an observer-seam test.
