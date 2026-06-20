/**
 * Browser-DOM bindings shared by the composition root. Each helper reads
 * a DOM-derived value once, observes changes via a DOM API, and surfaces
 * the result through a runtime-friendly closure. All helpers self-gate on
 * `typeof document` (or the relevant global) so headless tests with the
 * stub DOM stay green — they fall back to a one-shot read with no
 * observer registration.
 */

/** Wire a `visibilitychange` listener. Invokes `onChange` once at
 *  construction with the current `document.hidden` value, then on every
 *  `visibilitychange` event afterward. In headless (no `document`) the
 *  initial call fires with `hidden = false` and no listener is registered.
 *  The listener is never removed — composition runs once per page, so the
 *  subscription lives for the page lifetime. */

export function createVisibilityListener(opts: {
  onChange: (hidden: boolean) => void;
}): void {
  const hasDocument = typeof document !== "undefined";
  opts.onChange(hasDocument && document.hidden);
  if (hasDocument) {
    document.addEventListener("visibilitychange", () => {
      opts.onChange(document.hidden);
    });
  }
}
