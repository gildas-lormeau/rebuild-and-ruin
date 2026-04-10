/**
 * Test-environment DOM polyfills.
 *
 * The headless runtime registers the real browser input handlers
 * (`registerKeyboardHandlers`, `registerMouseHandlers`,
 * `registerTouchHandlers`) so tests can drive the game end-to-end through
 * the same code path a browser session would use. Those handlers reference
 * a few DOM globals that don't exist in Deno:
 *
 *   - `KeyboardEvent` / `MouseEvent` — handlers read `e.key`, `e.clientX`,
 *     `e.button`, etc. Tests construct these directly and dispatch them at
 *     a real `EventTarget`.
 *
 *   - `HTMLInputElement` / `HTMLSelectElement` — `input-keyboard.ts` does
 *     `e.target instanceof HTMLInputElement` to early-out when typing into
 *     a text field. Without the class on globalThis, the handler throws
 *     a `ReferenceError` the first time a key is dispatched.
 *
 * The polyfills are minimal: just enough to satisfy `instanceof` checks
 * and to carry the field shape that handlers read. Importing this module
 * is a side-effect — it installs the shims on `globalThis` if missing.
 *
 * Importing from `test/scenario.ts` ensures every test that constructs a
 * scenario has the polyfills loaded before any handler runs.
 */

interface MutableGlobal {
  KeyboardEvent?: unknown;
  MouseEvent?: unknown;
  HTMLInputElement?: unknown;
  HTMLSelectElement?: unknown;
  HTMLElement?: unknown;
}

const target = globalThis as MutableGlobal;

if (typeof target.KeyboardEvent === "undefined") {
  class KeyboardEventShim extends Event {
    readonly key: string;
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly repeat: boolean;
    constructor(
      type: string,
      init: {
        key?: string;
        code?: string;
        ctrlKey?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        repeat?: boolean;
      } = {},
    ) {
      super(type, { bubbles: true, cancelable: true });
      this.key = init.key ?? "";
      this.code = init.code ?? "";
      this.ctrlKey = init.ctrlKey ?? false;
      this.shiftKey = init.shiftKey ?? false;
      this.altKey = init.altKey ?? false;
      this.metaKey = init.metaKey ?? false;
      this.repeat = init.repeat ?? false;
    }
  }
  target.KeyboardEvent = KeyboardEventShim;
}

if (typeof target.MouseEvent === "undefined") {
  class MouseEventShim extends Event {
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
    readonly buttons: number;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    constructor(
      type: string,
      init: {
        clientX?: number;
        clientY?: number;
        button?: number;
        buttons?: number;
        ctrlKey?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
      } = {},
    ) {
      super(type, { bubbles: true, cancelable: true });
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
      this.button = init.button ?? 0;
      this.buttons = init.buttons ?? 0;
      this.ctrlKey = init.ctrlKey ?? false;
      this.shiftKey = init.shiftKey ?? false;
      this.altKey = init.altKey ?? false;
      this.metaKey = init.metaKey ?? false;
    }
  }
  target.MouseEvent = MouseEventShim;
}

// Empty marker classes — `e.target instanceof HTMLInputElement` returns false
// for any test-dispatched event whose target is the EventTarget itself, which
// matches the production behavior of "the user is not typing in a text field".
if (typeof target.HTMLElement === "undefined") {
  target.HTMLElement = class HTMLElementShim {};
}
if (typeof target.HTMLInputElement === "undefined") {
  target.HTMLInputElement = class HTMLInputElementShim {};
}
if (typeof target.HTMLSelectElement === "undefined") {
  target.HTMLSelectElement = class HTMLSelectElementShim {};
}

export {};
