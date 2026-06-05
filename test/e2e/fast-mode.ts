/**
 * Replace `requestAnimationFrame` with a tight `setTimeout` loop that
 * advances a fake clock by 100ms per frame — yields ~100× sim speed
 * without touching `__dev`. Run after `page.goto` and before any flow
 * that exercises the game loop.
 */

import type { Page } from "playwright";

export async function installFastMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    let fakeTime = performance.now();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => {
        fakeTime += 100;
        cb(fakeTime);
      }, 1) as unknown) as typeof requestAnimationFrame;
  });
}
