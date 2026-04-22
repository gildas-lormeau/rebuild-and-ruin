/**
 * E2E port of test/scenario-round2-build-to-cannon-ticks.test.ts.
 *
 * Captures screenshots from the round-2 "Build & Repair" banner leaving
 * the screen through the round-2 "Place Cannons" banner leaving — the
 * full WALL_BUILD phase (where the AI places pieces), the score overlay,
 * and the cannons banner. Per-tick sampling at 1-in-5 stride to keep
 * the output bounded.
 *
 * Run: npm run dev  (in another shell)
 *      deno run -A test/e2e-round2-build-to-cannon.ts [--visible]
 */

import { mkdirSync } from "node:fs";
import { createE2EScenario, E2ETest, GAME_EVENT } from "./e2e-scenario.ts";

const OUTPUT_DIR = "tmp/screenshots/round2-build-to-cannon";
const TICK_STRIDE = 5;

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function main(): Promise<void> {
  const test = new E2ETest(
    `round 2 build-to-cannon (tick stride=${TICK_STRIDE})`,
  );

  const sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    rounds: 2,
    mode: "classic",
    headless: !Deno.args.includes("--visible"),
  });

  try {
    // Milestones: every phase / banner / score-overlay boundary.
    await sc.captureOn(GAME_EVENT.PHASE_START);
    await sc.captureOn(GAME_EVENT.PHASE_END);
    await sc.captureOn(GAME_EVENT.BANNER_START);
    await sc.captureOn(GAME_EVENT.BANNER_HIDDEN);
    await sc.captureOn(GAME_EVENT.BANNER_REPLACED);
    await sc.captureOn(GAME_EVENT.SCORE_OVERLAY_START);
    await sc.captureOn(GAME_EVENT.SCORE_OVERLAY_END);

    // TICK: sample every Nth. The predicate uses a globalThis-backed
    // counter so it can maintain state across invocations despite being
    // stringified across the process boundary.
    await sc.captureOn(GAME_EVENT.TICK, () => {
      const g = globalThis as unknown as { __tickStride?: number };
      g.__tickStride = (g.__tickStride ?? 0) + 1;
      return g.__tickStride % 5 === 0;
    });

    await sc.runGame({ timeoutMs: 180_000 });

    const events = await sc.bus.events();
    const window = sliceWindow(events);
    test.check(
      "window bounded by round-2 Build & Repair END → Place Cannons END",
      window !== null,
      window ? `${window.length} events` : "not found",
    );
    if (!window) {
      test.done();
      return;
    }

    const captured = window.filter(
      (ev): ev is typeof ev & { capture: string } =>
        typeof ev.capture === "string",
    );

    mkdirSync(OUTPUT_DIR, { recursive: true });
    captured.forEach((ev, idx) => {
      const seq = String(idx + 1).padStart(4, "0");
      const slug = slugForEvent(ev);
      const path = `${OUTPUT_DIR}/${seq}-${slug}.png`;
      savePng(path, ev.capture);
    });

    test.check(
      `saved ${captured.length} screenshots (from ${window.length} window events)`,
      captured.length > 0,
    );
    console.log(`\n  ${captured.length} screenshots saved to ${OUTPUT_DIR}/`);
  } finally {
    await sc.close();
  }

  test.done();
}

/** Returns the busLog slice from the round-2 "Build & Repair" banner
 *  leaving the screen (exclusive) through the round-2 "Place Cannons"
 *  banner leaving (inclusive), or null if the window could not be
 *  located. "Leaving" = either BANNER_HIDDEN (explicit hide) or
 *  BANNER_REPLACED (next banner overwrites — `prevText` identifies the
 *  outgoing banner). */
function sliceWindow<
  T extends {
    type: string;
    round?: number;
    text?: string;
    prevText?: string;
  },
>(events: readonly T[]): readonly T[] | null {
  const isBannerLeaving = (ev: T, targetText: string): boolean => {
    if (ev.round !== 2) return false;
    if (ev.type === "bannerHidden" && ev.text === targetText) return true;
    if (ev.type === "bannerReplaced" && ev.prevText === targetText) return true;
    return false;
  };
  const startIdx = events.findIndex((ev) =>
    isBannerLeaving(ev, "Build & Repair"),
  );
  if (startIdx < 0) return null;
  const endIdx = events.findIndex(
    (ev, idx) => idx > startIdx && isBannerLeaving(ev, "Place Cannons"),
  );
  if (endIdx < 0) return null;
  return events.slice(startIdx + 1, endIdx + 1);
}

function slugForEvent(ev: unknown): string {
  const rec = ev as Record<string, unknown>;
  const tokens: string[] = [];
  if (typeof rec.round === "number") tokens.push(`r${rec.round}`);
  tokens.push(String(rec.type));
  if (typeof rec.phase === "string") tokens.push(rec.phase);
  if (typeof rec.text === "string") tokens.push(rec.text);
  return tokens
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function savePng(path: string, dataUrl: string): void {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  Deno.writeFileSync(path, bytes);
}
