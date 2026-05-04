/**
 * Browser-DOM bindings shared by the composition root.
 *
 * Each helper here follows the same shape: read a DOM-derived value once,
 * observe changes via a DOM API, and surface the result through a small
 * runtime-friendly closure. All helpers self-gate on `typeof document` (or
 * the relevant global) so headless tests with the stub DOM stay green —
 * they fall back to a one-shot read with no observer registration.
 */

/** Cached container-height getter. `clientHeight` is a layout-triggering
 *  DOM read; the per-frame render path calls this from inside multiple
 *  `render()` sites per sub-step, so a naive read crosses the JS↔DOM
 *  bridge dozens of times per browser frame. The cache refreshes via
 *  `ResizeObserver` (which only fires on actual resize / orientation
 *  change), so steady-state reads become a closure variable lookup.
 *  ResizeObserver is unavailable in the deno test stub (test/stub-dom.ts
 *  pins clientHeight to a fixed value); the headless path captures the
 *  initial value and never refreshes — fine because the stub's
 *  clientHeight is constant by design. */

export function createCachedContainerHeight(
  container: HTMLElement,
): () => number {
  let cached = container.clientHeight;
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      cached = container.clientHeight;
    });
    observer.observe(container);
  }
  return () => cached;
}

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
