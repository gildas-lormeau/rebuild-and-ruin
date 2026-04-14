/**
 * Thin wrappers around Playwright primitives used by E2E tests.
 *
 * The canonical one is `waitForPageFn`, which forces `timeoutMs` to be
 * an explicit positional argument. Playwright's native
 * `page.waitForFunction(fn, arg, options)` treats a 2nd-arg options
 * object as `arg` (not `options`), silently dropping custom timeouts
 * back to the 30s default — a footgun this wrapper removes. Use
 * `waitForPageFn` everywhere; `lint-raw-playwright.ts` forbids raw
 * `page.waitForFunction(` outside this file.
 */

import type { Page } from "playwright";

export async function waitForPageFn(
  page: Page,
  fn: () => boolean,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(fn, undefined, { timeout: timeoutMs });
}

/** String-expression variant for dynamic predicates (e.g. from config files). */
export async function waitForPageExpr(
  page: Page,
  expression: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(expression, undefined, { timeout: timeoutMs });
}
