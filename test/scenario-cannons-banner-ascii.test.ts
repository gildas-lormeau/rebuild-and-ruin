import { assertEquals } from "@std/assert";
import { createScenario } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { BANNER_PLACE_CANNONS } from "../src/runtime/banner-messages.ts";
import { diffAsciiSnapshots } from "../src/runtime/dev-console-grid.ts";

/** Round-1 "Place Cannons" banner invariant: the rendered scene at the
 *  last frame before the banner fires must match the scene captured for
 *  the banner's prev-scene. If they diverge, houses / bonus squares /
 *  walls have popped in between the capture and the banner start, and
 *  the sweep will have nothing to reveal under the curtain. */
Deno.test("banner reveal: no tile pops between capture and first Place Cannons banner (round 1)", async () => {
  const sc = await createScenario({ seed: 42, rounds: 1, renderer: "ascii" });
  const ascii = sc.renderer!;

  let beforeFinalize: string | null = null;
  let atBannerStart: string | null = null;
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (beforeFinalize !== null) return;
    if (ev.text !== BANNER_PLACE_CANNONS) return;
    const f = ascii.frames;
    // frames[len-2] is the last castle-build render (pre-finalizeCastleConstruction).
    // frames[len-1] is the first render after the capture point — should match
    // the captured prev-scene: same tiles, no pops.
    beforeFinalize = f[f.length - 2] ?? "";
    atBannerStart = f[f.length - 1] ?? "";
  });

  sc.runUntil(() => beforeFinalize !== null, { timeoutMs: 60_000 });

  const diff = diffAsciiSnapshots(beforeFinalize!, atBannerStart!);
  assertEquals(
    diff,
    "(no tile differences)",
    `Expected zero tile pops between the prev-scene capture and banner start.\nPopped tiles (should be revealed under the banner sweep, not before it):\n${diff}\n\nBEFORE:\n${beforeFinalize}\n\nAT BANNER_START:\n${atBannerStart}`,
  );
});
