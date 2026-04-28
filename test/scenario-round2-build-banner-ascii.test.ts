import { createScenario } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { BANNER_PLACE_CANNONS } from "../src/runtime/banner-messages.ts";

/** Prints the last rendered frame before the round-2 "Place Cannons" banner
 *  fires — i.e. the pre-sweep scene captured as the banner's prev-scene
 *  right before finalizeRound deletes isolated walls and revives
 *  pending towers. */
Deno.test("ascii: map just before round-2 Place Cannons banner", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2, renderer: "ascii" });
  const ascii = sc.renderer!;

  let frameBefore: string | null = null;
  let roundAtCapture = -1;
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (frameBefore !== null) return;
    if (ev.text !== BANNER_PLACE_CANNONS) return;
    if (ev.round !== 2) return;
    const f = ascii.frames;
    frameBefore = f[f.length - 1] ?? "";
    roundAtCapture = ev.round;
  });

  sc.runUntil(() => frameBefore !== null, { timeoutMs: 120_000 });

  console.log(
    `\n=== Frame just BEFORE "${BANNER_PLACE_CANNONS}" banner (round ${roundAtCapture}) ===\n${frameBefore}`,
  );
});
