# `src/input/` — Input handlers

The **input** domain owns browser input (keyboard, mouse, touch) and
touch UI wiring. These are the "talk to the browser hardware"
subsystems, the bottom layer that converts physical events into
game-visible actions.

Sound and haptics do NOT live here: sound lives in
`src/runtime/audio/` + `src/runtime/subsystems/audio.ts`, haptics in
`src/runtime/subsystems/haptics.ts` (the `HapticsObserver` interface
is in `src/shared/core/system-interfaces.ts`).

## Read these first

1. **[input-dispatch.ts](./input-dispatch.ts)** — Shared input
   dispatch helpers: `dispatchPointerMove` routes a pointer event
   to the right player based on which slot owns the pointer input.
2. **[input-keyboard.ts](./input-keyboard.ts)** — Keyboard handler
   registration. Each player has their own key bindings; the
   handler routes events to the right controller. **Start here to
   understand the keyboard → action → controller → intent flow.**

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

## Per-player key bindings

Shared-screen play means each player has their own keybindings. The
`KeyBindings` type lives in `src/shared/core/input-action.ts` (alongside
the `Action` vocabulary it maps); the default binding *data* is in
`PLAYER_KEY_BINDINGS` in `src/shared/ui/player-config.ts`. The keyboard handler routes
events by checking `event.key` against each player's bindings in
turn. First match wins. Don't assume keys are unique across players —
the user can (and does) rebind.

The options menu's keybinding UI is in `src/runtime/subsystems/options.ts`
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
1. Add a new `Action` to the enum in `src/shared/core/input-action.ts`.
2. Add a default binding in `PLAYER_KEY_BINDINGS` in
   `shared/ui/player-config.ts`.
3. Handle the action in `input-keyboard.ts` or wherever relevant.
4. If it's a UI-rebindable action, add to the options menu entry
   list in `src/runtime/subsystems/options.ts`.

### Debug "click does nothing"
Start at `input-mouse.ts` / `input-touch-canvas.ts` to verify the
event fires. Then step into `input-dispatch.ts` to see pointer
routing. Then into `subsystems/input.ts` to see action dispatch. Then
into `controller-human.ts` to see intent generation.

## Gotchas

- **Touch UI factory functions are called ONCE.** The runtime
  stores the returned handles in `touchHandles` and calls their
  `update()` methods each frame. Don't try to recreate them on every
  frame — it would leak event listeners.

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

- **[src/runtime/subsystems/input.ts](../runtime/subsystems/input.ts)** —
  The runtime subsystem that wires input handlers to controllers
  via the deps bag.
- **[src/controllers/controller-human.ts](../controllers/controller-human.ts)**
  — The human controller that consumes the events this folder emits.
- **[src/shared/core/input-action.ts](../shared/core/input-action.ts)**
  — `Action` vocabulary + the `KeyBindings` type.
- **[src/shared/ui/player-config.ts](../shared/ui/player-config.ts)**
  — `PLAYER_KEY_BINDINGS` (default binding data).
- **[test/input-lobby.test.ts](../../test/input-lobby.test.ts)** —
  Example of driving lobby input through the real dispatch path.
