/**
 * E2E port of the round-1 section of
 * test/scenario-round1-to-round2-timeline.test.ts.
 *
 * Registers `captureOn` filters for every phase + banner event in round 1,
 * runs the game, then saves a PNG for each matching busLog entry. Same
 * number of screenshots as the ASCII test has maps, captured at the same
 * bus events.
 *
 * Run: npm run dev  (in another shell)
 *      deno run -A test/e2e-round1-cannons-banner.ts [--visible]
 */

import { mkdirSync } from "node:fs";
import { createE2EScenario, E2ETest, GAME_EVENT } from "./e2e-scenario.ts";

const OUTPUT_DIR = "tmp/screenshots/round1-cannons-banner";

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function main(): Promise<void> {
  const test = new E2ETest("round 1 timeline screenshots");

  const sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    rounds: 2,
    mode: "classic",
    headless: !Deno.args.includes("--visible"),
  });

  try {
    // Register filters BEFORE running. Each matching event will get a
    // canvas PNG attached to its busLog entry as `entry.capture`.
    await sc.captureOn(GAME_EVENT.PHASE_START);
    await sc.captureOn(GAME_EVENT.PHASE_END);
    await sc.captureOn(GAME_EVENT.BANNER_START);
    await sc.captureOn(GAME_EVENT.BANNER_END);
    await sc.captureOn(GAME_EVENT.SCORE_OVERLAY_START);
    await sc.captureOn(GAME_EVENT.SCORE_OVERLAY_END);

    await sc.runGame({ timeoutMs: 120_000 });

    const events = await sc.bus.events();
    const captured = events.filter(
      (ev): ev is typeof ev & { capture: string } =>
        typeof ev.capture === "string",
    );

    mkdirSync(OUTPUT_DIR, { recursive: true });
    captured.forEach((ev, idx) => {
      const seq = String(idx + 1).padStart(2, "0");
      const slug = slugForEvent(ev);
      const path = `${OUTPUT_DIR}/${seq}-${slug}.png`;
      savePng(path, ev.capture);
      test.check(`${ev.type}${describe(ev)} → ${seq}-${slug}.png`, true);
    });

    test.check(
      "captured at least one screenshot",
      captured.length > 0,
      `${captured.length} total`,
    );

    console.log(`\n  ${captured.length} screenshots saved to ${OUTPUT_DIR}/`);
  } finally {
    await sc.close();
  }

  test.done();
}

function describe(ev: unknown): string {
  const rec = ev as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.round === "number") parts.push(`r${rec.round}`);
  if (typeof rec.text === "string") parts.push(`"${rec.text}"`);
  if (typeof rec.phase === "string") parts.push(rec.phase);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
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
