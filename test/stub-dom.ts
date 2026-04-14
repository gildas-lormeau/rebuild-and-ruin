/**
 * Shared DOM-element stub used by headless test infrastructure. The
 * runtime touches a handful of non-event HTMLElement properties on its
 * canvas host:
 *   - `clientHeight` / `clientWidth` (camera, layout)
 *   - `classList.{add,remove,contains,toggle}` (mode toggles in main.ts)
 *   - `querySelector` (touch UI lookup, returns null)
 *   - `style.cursor` (input-mouse writes this on every mousemove)
 *
 * `EventTarget` already provides `addEventListener` / `dispatchEvent`, so
 * composing the two gives us a full fake with the same surface.
 */

export function createStubElement(): HTMLElement {
  const target = new EventTarget();
  const props = {
    clientHeight: 720,
    clientWidth: 1280,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    style: { cursor: "default" },
  };
  return Object.assign(target, props) as unknown as HTMLElement;
}
