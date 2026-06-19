/**
 * Two ways to accelerate the game loop, both by overriding the timestamp the
 * runtime reads from its `requestAnimationFrame` callback (the loop derives
 * `dt` from that arg, never `performance.now()` directly):
 *
 *  - JUMP mode (default, `factor` omitted): replace RAF with a tight
 *    `setTimeout(1ms)` loop that advances a fake clock by 100ms per frame —
 *    ~100× sim speed, fully decoupled from the wall clock. Great for a single
 *    headless peer; useless for cross-peer parity (each page's fake clock
 *    free-runs, so two co-hosted sims drift apart by frame count).
 *
 *  - SCALED mode (`factor` given, e.g. 2): keep RAF at its REAL ~60fps wall
 *    cadence but advance the reported timestamp by `factor ×` the real elapsed
 *    wall time. Sim runs `factor ×` faster while staying ANCHORED to the wall
 *    clock, so two peers drift only as much as real RAF jitter × factor — the
 *    same regime as no fast-mode, just scaled. Use this when parity must hold.
 *
 * Run after `page.goto` and before any flow that exercises the game loop.
 */

import type { Page } from "playwright";

export async function installFastMode(
  page: Page,
  factor?: number,
): Promise<void> {
  await page.evaluate((mult: number | null) => {
    if (mult === null) {
      // JUMP mode: fixed 100ms/frame fake clock, as fast as setTimeout allows.
      let fakeTime = performance.now();
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => {
          fakeTime += 100;
          cb(fakeTime);
        }, 1) as unknown) as typeof requestAnimationFrame;
      return;
    }
    // SCALED mode: real RAF cadence, virtual time advances `mult ×` real time.
    const realRaf = globalThis.requestAnimationFrame.bind(globalThis);
    let lastReal = performance.now();
    let virt = lastReal;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      realRaf((real: number) => {
        virt += (real - lastReal) * mult;
        lastReal = real;
        cb(virt);
      })) as typeof requestAnimationFrame;
  }, factor ?? null);
}
