/**
 * E2E test: capture 5 frames per banner transition and verify boundaries.
 *
 * For EVERY banner that fires during a 10-round modern-mode game:
 *   1-previous: last frame before banner appeared
 *   2-first:    first frame with banner visible
 *   3-mid:      mid-sweep frame
 *   4-last:     last frame with banner strip on screen
 *   5-next:     first frame after banner disappeared
 *
 * Assertions: previous ≈ first, last ≈ next (masking banner strip + status bar).
 * All frames saved to tmp/screenshots/<banner-label>/ for visual inspection.
 *
 * Run: deno run -A test/e2e-banner-prev-scene.ts
 * Requires: npm run dev
 */

import { mkdirSync } from "node:fs";
import { E2EGame, E2ETest } from "./e2e-helpers.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };

const TARGET_W = 400;
const DIFF_THRESHOLD = 30;
const MAX_DIFF_PERCENT = 1.0;
const MAP_H = 448;
const BANNER_RATIO = 0.15;

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function run(): Promise<void> {
  const test = new E2ETest("all banner transitions");

  const seed = (SEED_FIXTURES as Record<string, number>)["modifier:wildfire"];
  if (seed === undefined) {
    console.error("missing seed");
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
    const banners = await game.page.evaluate(
      ([targetW, diffThresh, mapH, bannerRatio]: [
        number,
        number,
        number,
        number,
      ]) => {
        const win = globalThis as unknown as Record<string, unknown>;
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");

        const bannerHMap = Math.round(mapH * bannerRatio);

        function smallPng(): string {
          const aspect = canvas.height / canvas.width;
          const th = Math.round(targetW * aspect);
          const small = document.createElement("canvas");
          small.width = targetW;
          small.height = th;
          const sctx = small.getContext("2d")!;
          sctx.imageSmoothingEnabled = true;
          sctx.drawImage(canvas, 0, 0, targetW, th);
          return small.toDataURL("image/png");
        }

        function fullPixels(): Uint8ClampedArray {
          return ctx!.getImageData(0, 0, canvas.width, canvas.height).data;
        }

        function diffPct(
          bufA: Uint8ClampedArray,
          bufB: Uint8ClampedArray,
          ySkipA: number,
          ySkipB: number,
        ): number {
          const cw = canvas.width;
          const gameH = canvas.height - 40;
          let diff = 0;
          let total = 0;
          for (let y = 0; y < gameH; y++) {
            if (y >= ySkipA && y < ySkipB) continue;
            for (let x = 0; x < cw; x++) {
              const idx = (y * cw + x) * 4;
              const dr = Math.abs(bufA[idx]! - bufB[idx]!);
              const dg = Math.abs(bufA[idx + 1]! - bufB[idx + 1]!);
              const db = Math.abs(bufA[idx + 2]! - bufB[idx + 2]!);
              if (dr + dg + db > diffThresh) diff++;
              total++;
            }
          }
          return total > 0 ? (diff / total) * 100 : 0;
        }

        // Per-banner tracker.
        interface BannerCapture {
          label: string;
          round: number;
          modifierId: string | null;
          previous: string | null;
          first: string | null;
          mid: string | null;
          last: string | null;
          next: string | null;
          startDiffPct: number;
          endDiffPct: number;
          done: boolean;
          /** True if this banner starts right after another ends (same tick). */
          chainedStart: boolean;
          /** True if this banner ends right before another starts (same tick). */
          chainedEnd: boolean;
        }

        type BannerEvent = {
          type: "start" | "end";
          text: string;
          modifierId?: string;
          round: number;
        };

        const captures: BannerCapture[] = [];
        let activeTracker: BannerCapture | null = null;
        let prevPng: string | null = null;
        let prevPixels: Uint8ClampedArray | null = null;
        let lastCandidatePng: string | null = null;
        let lastCandidatePixels: Uint8ClampedArray | null = null;
        let prevEventCount = 0;
        // After a banner ends, capture "next" on the following rAF.
        let pendingNextTracker: BannerCapture | null = null;
        // Set true when a banner ends, cleared after one rAF tick.
        // If a new start fires while this is true, they're chained.
        let bannerJustEnded = false;

        return new Promise<BannerCapture[]>((resolve) => {
          const prevRAF = globalThis.requestAnimationFrame;
          globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
            prevRAF((time: number) => {
              cb(time);

              const e2e = win.__e2e as Record<string, unknown> | undefined;
              if (!e2e) return;
              const mode = e2e.mode as string | undefined;
              if (mode === "STOPPED") {
                resolve(captures);
                return;
              }

              const events = (e2e.bannerEvents ?? []) as BannerEvent[];
              const overlay = e2e.overlay as
                | Record<string, unknown>
                | undefined;
              const banner = overlay?.banner as
                | { y: number }
                | null
                | undefined;
              const newEvents = events.slice(prevEventCount);
              prevEventCount = events.length;

              const curPng = smallPng();
              const curPixels = fullPixels();

              // ── "next" capture (one frame after previous banner ended) ──
              if (pendingNextTracker) {
                pendingNextTracker.next = curPng;
                if (
                  !pendingNextTracker.done &&
                  lastCandidatePixels
                ) {
                  const scale = canvas.height / (mapH + 32);
                  const bannerHPx = Math.round(bannerHMap * scale);
                  const skipA = canvas.height - 40 - bannerHPx - 8;
                  pendingNextTracker.endDiffPct = diffPct(
                    lastCandidatePixels,
                    curPixels,
                    skipA,
                    canvas.height,
                  );
                }
                pendingNextTracker.done = true;
                pendingNextTracker = null;
              }

              // ── Detect chaining ──
              const prevJustEnded = bannerJustEnded;
              bannerJustEnded = false;

              // ── Process new bus events ──
              for (const ev of newEvents) {
                if (ev.type === "start") {
                  const chainedStart = prevJustEnded;
                  if (chainedStart && captures.length > 0) {
                    captures[captures.length - 1]!.chainedEnd = true;
                  }
                  const tracker: BannerCapture = {
                    label: ev.modifierId
                      ? `${ev.text} [${ev.modifierId}]`
                      : ev.text,
                    round: ev.round,
                    modifierId: ev.modifierId ?? null,
                    previous: prevPng,
                    first: curPng,
                    mid: null,
                    last: null,
                    next: null,
                    startDiffPct: -1,
                    endDiffPct: -1,
                    done: false,
                    chainedStart,
                    chainedEnd: false,
                  };
                  if (!chainedStart && prevPixels) {
                    const scale = canvas.height / (mapH + 32);
                    const bannerHPx = Math.round(bannerHMap * scale);
                    tracker.startDiffPct = diffPct(
                      prevPixels,
                      curPixels,
                      0,
                      bannerHPx + 8,
                    );
                  }
                  captures.push(tracker);
                  activeTracker = tracker;
                  lastCandidatePng = null;
                  lastCandidatePixels = null;
                }

                if (ev.type === "end" && activeTracker) {
                  bannerJustEnded = true;
                  activeTracker.last = lastCandidatePng ?? curPng;
                  pendingNextTracker = activeTracker;
                  activeTracker = null;
                }
              }

              // ── Active banner: capture mid + track last candidate ──
              if (activeTracker && banner) {
                if (
                  banner.y >= mapH * 0.4 &&
                  banner.y <= mapH * 0.6 &&
                  !activeTracker.mid
                ) {
                  activeTracker.mid = curPng;
                }
                // Strip is on screen when its top edge is above screen bottom.
                if (banner.y - bannerHMap / 2 < mapH) {
                  lastCandidatePng = curPng;
                  lastCandidatePixels = curPixels;
                }
              }

              prevPng = curPng;
              prevPixels = curPixels;
            });
        });
      },
      [TARGET_W, DIFF_THRESHOLD, MAP_H, BANNER_RATIO] as [
        number,
        number,
        number,
        number,
      ],
    );

    // Save screenshots + run assertions.
    console.log(`\nCaptured ${banners.length} banner transitions:\n`);

    for (const banner of banners) {
      const slug = banner.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+$/, "");
      const dir = `tmp/screenshots/r${banner.round}-${slug}`;
      mkdirSync(dir, { recursive: true });

      const frames = [
        ["1-previous", banner.previous],
        ["2-first", banner.first],
        ["3-mid", banner.mid],
        ["4-last", banner.last],
        ["5-next", banner.next],
      ] as const;

      for (const [name, dataUrl] of frames) {
        if (!dataUrl || !dataUrl.startsWith("data:")) continue;
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        Deno.writeFileSync(`${dir}/${name}.png`, bytes);
      }

      const chainTag = (start: boolean, end: boolean) => {
        const parts: string[] = [];
        if (start) parts.push("chained-start");
        if (end) parts.push("chained-end");
        return parts.length ? ` [${parts.join(", ")}]` : "";
      };
      const tag = chainTag(banner.chainedStart, banner.chainedEnd);
      const startStr =
        banner.startDiffPct >= 0
          ? `${banner.startDiffPct.toFixed(3)}%`
          : "n/a";
      const endStr =
        banner.endDiffPct >= 0 ? `${banner.endDiffPct.toFixed(3)}%` : "n/a";

      console.log(
        `  r${banner.round} ${banner.label}${tag}: start=${startStr} end=${endStr}`,
      );

      // Skip assertions on chained boundaries — "previous" of a chained
      // successor is the prior banner's last frame, and "next" of a
      // chained predecessor is the successor's first frame. These differ
      // by design. Screenshots still saved for visual inspection.
      if (!banner.chainedStart) {
        const startOk =
          banner.startDiffPct >= 0 &&
          banner.startDiffPct < MAX_DIFF_PERCENT;
        test.check(
          `r${banner.round} ${banner.label}: previous ≈ first`,
          startOk,
          `${startStr} (threshold ${MAX_DIFF_PERCENT}%)`,
        );
      }
      if (!banner.chainedEnd && banner.endDiffPct >= 0) {
        const endOk = banner.endDiffPct < MAX_DIFF_PERCENT;
        test.check(
          `r${banner.round} ${banner.label}: last ≈ next`,
          endOk,
          `${endStr} (threshold ${MAX_DIFF_PERCENT}%)`,
        );
      }
    }
  } finally {
    await game.close();
  }

  test.done();
}
