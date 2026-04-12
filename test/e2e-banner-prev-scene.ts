/**
 * E2E test: capture canvas screenshots at key banner-sweep frames so we
 * can verify (visually, at first) that:
 *
 *   1. During a modifier banner (cannon→battle), the prev-scene below
 *      the sweep line shows the cannon-place scene, NOT the post-battle
 *      territory polygons.
 *
 *   2. During the build banner (after an upgrade-pick round), the
 *      upgrade-pick dialog progressively fades out with the sweep —
 *      visible at the top of the screen, hidden at the bottom.
 *
 * First-pass usage: run the test and look at the dumped PNGs in
 * `test/screenshots/`. If they look correct, the screenshots can be
 * locked in as references and future runs compared against them with
 * a pixel-diff tolerance.
 *
 * This is a deliberate departure from observer/state-based tests: it
 * captures the real pixel output of the real renderer, driven by the
 * real AI, with no reconstruction layer between the test and what the
 * user sees.
 *
 * Run: `deno run -A test/e2e-banner-prev-scene.ts`
 * Requires: `npm run dev` (vite on port 5173)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { E2EGame, E2ETest } from "./e2e-helpers.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };

interface CapturedShot {
  /** base64 PNG payload returned from canvas.toDataURL */
  dataUrl: string;
  bannerText: string;
  modifierId: string | null;
  bannerY: number;
  bannerProgress: number;
  round: number;
  phase: string;
  label: string;
  canvasW: number;
  canvasH: number;
}

interface CaptureResult {
  modifierShot: CapturedShot | null;
  upgradeShot: CapturedShot | null;
  framesChecked: number;
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function run(): Promise<void> {
  const test = new E2ETest("banner screenshots (visual-first)");

  // Seed covers both modifier:wildfire and upgrade:small_pieces (from
  // seed-fixtures.json — seed 0 in modern mode fires several modifiers
  // and several upgrade picks within 10 rounds).
  const seed = (SEED_FIXTURES as Record<string, number>)["modifier:wildfire"];
  if (seed === undefined) {
    console.error(
      "missing seed for modifier:wildfire — run `npm run record-seeds`",
    );
    Deno.exit(1);
  }

  const game = await E2EGame.create({
    seed,
    humans: 0,
    headless: true,
    rounds: 10,
    mode: "modern",
  });

  try {
    await game.page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;

      const result: CaptureResult = {
        modifierShot: null,
        upgradeShot: null,
        framesChecked: 0,
      };
      win.__bannerShotCapture = result;

      // Snapshot helper: downscales the live canvas onto a 400x???-sized
      // offscreen canvas (so the saved PNG is small enough for the
      // session-context budget) and returns the encoded PNG payload.
      const TARGET_W = 400;
      function snapshot(label: string): CapturedShot | null {
        const e2e = win.__e2e as Record<string, unknown> | undefined;
        if (!e2e) return null;
        const overlay = e2e.overlay as Record<string, unknown> | undefined;
        const banner = overlay?.banner as
          | { y: number; text: string; modifierDiff: { id: string } | null }
          | null
          | undefined;

        const aspect = canvas.height / canvas.width;
        const targetH = Math.round(TARGET_W * aspect);
        const small = document.createElement("canvas");
        small.width = TARGET_W;
        small.height = targetH;
        const smallCtx = small.getContext("2d");
        if (!smallCtx) return null;
        smallCtx.imageSmoothingEnabled = true;
        smallCtx.drawImage(canvas, 0, 0, TARGET_W, targetH);

        return {
          dataUrl: small.toDataURL("image/png"),
          bannerText: banner?.text ?? "",
          modifierId: banner?.modifierDiff?.id ?? null,
          bannerY: banner?.y ?? 0,
          bannerProgress: -1, // progress not on bridge; ignore for now
          round: (e2e.round as number) ?? 0,
          phase: (e2e.phase as string) ?? "",
          label,
          canvasW: TARGET_W,
          canvasH: targetH,
        };
      }

      const prevRAF = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
        prevRAF((time: number) => {
          cb(time);
          result.framesChecked++;
          if (result.modifierShot !== null && result.upgradeShot !== null) {
            return;
          }

          const e2e = win.__e2e as Record<string, unknown> | undefined;
          if (!e2e) return;
          const round = (e2e.round as number) ?? 0;
          const overlay = e2e.overlay as Record<string, unknown> | undefined;
          const banner = overlay?.banner as
            | { y: number; text: string; modifierDiff: unknown }
            | null
            | undefined;
          if (!banner) return;

          // Want to capture each shot in the middle of its sweep — banner.y
          // is roughly in [-bannerH/2, H+bannerH/2], so mid-sweep is y ≈ H/2.
          // H is the map-pixel height = 448.
          const MID_LOW = 200;
          const MID_HIGH = 280;
          const yInMid = banner.y >= MID_LOW && banner.y <= MID_HIGH;
          if (!yInMid) return;

          // Modifier banner — cannon→battle with modifierDiff set, round ≥ 3.
          if (
            round >= 3 &&
            banner.modifierDiff !== null &&
            result.modifierShot === null
          ) {
            result.modifierShot = snapshot("modifier-mid-sweep");
            return;
          }

          // Build banner AFTER upgrades — identified by the exact banner
          // title string ("Build & Repair"). The upgrade-pick banner
          // ("Choose Upgrade") runs before this and would otherwise
          // match the `modifierDiff === null` filter. We also wait for
          // round ≥ 4 so we're past the first upgrade-pick round.
          if (
            round >= 4 &&
            banner.text === "Build & Repair" &&
            banner.modifierDiff === null &&
            result.upgradeShot === null
          ) {
            result.upgradeShot = snapshot("build-banner-after-upgrade");
            return;
          }
        });
    });

    // Give the game 2 minutes of fast-mode RAF to reach both captures.
    await game.page.waitForFunction(
      () => {
        const win = globalThis as unknown as Record<string, unknown>;
        const cap = win.__bannerShotCapture as CaptureResult | undefined;
        return cap?.modifierShot !== null && cap?.upgradeShot !== null;
      },
      undefined,
      { timeout: 120_000 },
    );

    const result = (await game.page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      return win.__bannerShotCapture as CaptureResult;
    })) as CaptureResult;

    mkdirSync("test/screenshots", { recursive: true });

    for (const shot of [result.modifierShot, result.upgradeShot]) {
      if (!shot) {
        test.check("captured shot", false, "shot was null");
        continue;
      }
      const pngBase64 = shot.dataUrl.replace(/^data:image\/png;base64,/, "");
      const pngBytes = Uint8Array.from(atob(pngBase64), (ch) =>
        ch.charCodeAt(0),
      );
      const path = `test/screenshots/${shot.label}.png`;
      writeFileSync(path, pngBytes);
      console.log(
        `Saved ${path} (${pngBytes.length} bytes) — ` +
          `round=${shot.round} phase=${shot.phase} banner.y=${shot.bannerY.toFixed(1)} ` +
          `text="${shot.bannerText}" modifierId=${shot.modifierId}`,
      );
      test.check(`captured ${shot.label}`, pngBytes.length > 0);
    }
  } finally {
    await game.close();
  }

  test.done();
}
