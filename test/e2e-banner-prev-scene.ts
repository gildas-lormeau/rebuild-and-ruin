/**
 * E2E test: capture 5 frames per banner transition and verify boundaries.
 *
 * Runs multiple games to guarantee coverage of EVERY distinct banner path:
 *
 *   1. Phase banners: "Place Cannons", "Prepare for Battle", "Build & Repair"
 *   2. Modifier reveal → "Prepare for Battle" chain (all 8 modifiers)
 *   3. "Choose Upgrade" → "Build & Repair" chain (modern mode)
 *   4. Classic-mode phase banners (no modifiers, no upgrades)
 *
 * For EVERY banner that fires:
 *   1-previous: last frame before banner appeared
 *   2-first:    first frame with banner visible
 *   3-mid:      mid-sweep frame
 *   4-last:     last frame with banner strip on screen
 *   5-next:     first frame after banner disappeared
 *
 * Assertions: previous ≈ first, last ≈ next (masking banner strip + status bar).
 * All frames saved to tmp/screenshots/<game>/<banner-label>/ for visual inspection.
 *
 * Uses the E2E bridge busLog: banner events carry canvas snapshots, tick events
 * during banners carry snapshots + banner Y position. No RAF wrapping needed.
 *
 * Run: deno run -A test/e2e-banner-prev-scene.ts
 * Requires: npm run dev
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { E2EBusEntry } from "../src/runtime/runtime-e2e-bridge.ts";
import { createE2EScenario, E2ETest } from "./e2e-scenario.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };

interface GameConfig {
  label: string;
  seed: number;
  mode: "modern" | "classic";
  rounds: number;
}

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
  midTopDiffPct: number;
  midBottomDiffPct: number;
  continuityDiffPct: number;
  chainedStart: boolean;
  chainedEnd: boolean;
}

const DIFF_THRESHOLD = 30;
const DEFAULT_MAX_DIFF = 1.0;
const MAP_H = 448;
const ALL_MODIFIERS = [
  "wildfire",
  "crumbling_walls",
  "grunt_surge",
  "frozen_river",
  "sinkhole",
  "high_tide",
  "dust_storm",
  "rubble_clearing",
] as const;
const PHASE_BANNERS = [
  "Place Cannons",
  "Prepare for Battle",
  "Build & Repair",
] as const;

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function run(): Promise<void> {
  const test = new E2ETest("all banner transitions — full coverage");
  const configs = buildGameConfigs();

  console.log(`\nPlanned games: ${configs.map((gc) => gc.label).join(", ")}\n`);

  const seenModifiers = new Set<string>();
  const seenPhaseBanners = new Set<string>();
  let seenUpgradeChain = false;
  let seenClassicPhase = false;

  for (const config of configs) {
    console.log(`\n═══ Game: ${config.label} (seed=${config.seed}, mode=${config.mode}, rounds=${config.rounds}) ═══\n`);

    const banners = await runOneGame(config);

    console.log(`  Captured ${banners.length} banner transitions:\n`);

    for (let bi = 0; bi < banners.length; bi++) {
      const banner = banners[bi]!;
      if (banner.modifierId) seenModifiers.add(banner.modifierId);
      if (PHASE_BANNERS.some((pb) => banner.label.startsWith(pb))) {
        seenPhaseBanners.add(
          banner.label.startsWith("Place Cannons")
            ? "Place Cannons"
            : banner.label.startsWith("Prepare for Battle")
              ? "Prepare for Battle"
              : "Build & Repair",
        );
      }
      if (banner.label === "Choose Upgrade") seenUpgradeChain = true;
      if (config.mode === "classic") seenClassicPhase = true;

      // Save screenshots.
      const slug = banner.modifierId
        ? `modifier-${banner.modifierId}`
        : banner.label === "Choose Upgrade"
          ? "upgrade"
          : banner.label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/-+$/, "");
      const seq = String(bi + 1).padStart(2, "0");
      const dir = `tmp/screenshots/${config.label}/${seq}-r${banner.round}-${slug}`;
      mkdirSync(dir, { recursive: true });

      for (const [name, dataUrl] of [
        ["1-previous", banner.previous],
        ["2-first", banner.first],
        ["3-mid", banner.mid],
        ["4-last", banner.last],
        ["5-next", banner.next],
      ] as const) {
        if (!dataUrl || !dataUrl.startsWith("data:")) continue;
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        Deno.writeFileSync(`${dir}/${name}.png`, bytes);
      }

      writeFileSync(
        `${dir}/events.json`,
        JSON.stringify(
          {
            label: banner.label,
            round: banner.round,
            modifierId: banner.modifierId,
            chainedStart: banner.chainedStart,
            chainedEnd: banner.chainedEnd,
            startDiffPct: banner.startDiffPct,
            endDiffPct: banner.endDiffPct,
          },
          null,
          2,
        ),
      );

      const chainTag = (start: boolean, end: boolean) => {
        const parts: string[] = [];
        if (start) parts.push("chained-start");
        if (end) parts.push("chained-end");
        return parts.length ? ` [${parts.join(", ")}]` : "";
      };
      const tag = chainTag(banner.chainedStart, banner.chainedEnd);
      const fmt = (val: number) => (val >= 0 ? `${val.toFixed(3)}%` : "n/a");

      console.log(
        `  r${banner.round} ${banner.label}${tag}: start=${fmt(banner.startDiffPct)} end=${fmt(banner.endDiffPct)} midTop=${fmt(banner.midTopDiffPct)} midBot=${fmt(banner.midBottomDiffPct)} cont=${fmt(banner.continuityDiffPct)}  → ${dir}/`,
      );

      // Pixel-boundary assertions (skip chained boundaries).
      if (!banner.chainedStart) {
        const startMax = getThreshold(banner.label, "start", banner.modifierId);
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: previous ≈ first  → ${dir}/`,
          banner.startDiffPct >= 0 && banner.startDiffPct < startMax,
          `${fmt(banner.startDiffPct)} (threshold ${startMax}%)`,
        );
      }
      if (!banner.chainedEnd && banner.endDiffPct >= 0) {
        const endMax = getThreshold(banner.label, "end", banner.modifierId);
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: last ≈ next  → ${dir}/`,
          banner.endDiffPct < endMax,
          `${fmt(banner.endDiffPct)} (threshold ${endMax}%)`,
        );
      }
      if (banner.midTopDiffPct >= 0 && !banner.chainedEnd) {
        const midTopMax = banner.label.startsWith("Prepare for Battle") ? 12 : 5;
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: mid-top ≈ next  → ${dir}/`,
          banner.midTopDiffPct < midTopMax,
          `${fmt(banner.midTopDiffPct)} (threshold ${midTopMax}%)`,
        );
      }
      if (banner.midBottomDiffPct >= 0) {
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: mid-bottom ≈ first  → ${dir}/`,
          banner.midBottomDiffPct < 5,
          `${fmt(banner.midBottomDiffPct)} (threshold 5%)`,
        );
      }
      if (banner.continuityDiffPct >= 0) {
        const contMax = getThreshold(banner.label, "start", banner.modifierId);
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: continuity next[n-1] ≈ previous[n]  → ${dir}/`,
          banner.continuityDiffPct < contMax,
          `${fmt(banner.continuityDiffPct)} (threshold ${contMax}%)`,
        );
      }
    }
  }

  console.log("\n═══ Coverage ═══\n");
  for (const mod of ALL_MODIFIERS) {
    test.check(`modifier coverage: ${mod}`, seenModifiers.has(mod));
  }
  for (const phase of PHASE_BANNERS) {
    test.check(`phase banner coverage: ${phase}`, seenPhaseBanners.has(phase));
  }
  test.check("upgrade chain coverage: Choose Upgrade → Build & Repair", seenUpgradeChain);
  test.check("classic mode coverage", seenClassicPhase);
  test.done();
}

function getThreshold(
  label: string,
  side: "start" | "end",
  modifierId: string | null,
): number {
  if (side === "start" && modifierId) return 17;
  if (side === "end" && modifierId) return 15;
  if (label === "Prepare for Battle" && side === "start") return 18;
  if (label === "Prepare for Battle" && side === "end") return 11;
  if (label === "Choose Upgrade" && side === "start") return 20;
  if (label === "Choose Upgrade" && side === "end") return 6;
  if (label.startsWith("Build & Repair")) return 10;
  return DEFAULT_MAX_DIFF;
}

function buildGameConfigs(): GameConfig[] {
  const fixtures = SEED_FIXTURES as Record<string, number>;
  const seedToModifiers = new Map<number, string[]>();
  for (const mod of ALL_MODIFIERS) {
    const seed = fixtures[`modifier:${mod}`];
    if (seed === undefined) {
      console.error(`missing seed for modifier:${mod}`);
      Deno.exit(1);
    }
    const list = seedToModifiers.get(seed) ?? [];
    list.push(mod);
    seedToModifiers.set(seed, list);
  }

  const configs: GameConfig[] = [];
  for (const [seed] of seedToModifiers) {
    configs.push({ label: `modern-s${seed}`, seed, mode: "modern", rounds: 20 });
  }
  configs.push({ label: "classic-s0", seed: 0, mode: "classic", rounds: 3 });
  return configs;
}

async function runOneGame(config: GameConfig): Promise<BannerCapture[]> {
  const sc = await createE2EScenario({
    seed: config.seed,
    humans: 0,
    headless: !Deno.args.includes("--visible"),
    rounds: config.rounds,
    mode: config.mode,
  });

  try {
    // Enable per-frame canvas capture so _prevSnapshot is populated.
    await sc.enableCanvasSnapshots();

    // Run the game to completion.
    await sc.runGame({ timeoutMs: 300_000 });

    // Read all bus events from the bridge.
    const events = await sc.bus.events();

    // Extract banner captures from the event log (Deno-side).
    const captures = extractBannerCaptures(events);

    // Pixel diffing must happen in-browser (needs canvas context to decode PNGs).
    // Collect the PNG pairs to diff and send them in a single page.evaluate.
    interface DiffPair {
      captureIdx: number;
      field: string;
      pngA: string;
      pngB: string;
      cropTop: number;
      cropBottom: number;
    }

    const pairs: DiffPair[] = [];
    for (let ci = 0; ci < captures.length; ci++) {
      const cap = captures[ci]!;

      // start: previous ≈ first
      if (!cap.chainedStart && cap.previous && cap.first) {
        pairs.push({
          captureIdx: ci,
          field: "startDiffPct",
          pngA: cap.previous,
          pngB: cap.first,
          cropTop: 1 / 6,
          cropBottom: 0,
        });
      }
      // end: last ≈ next
      if (cap.last && cap.next) {
        pairs.push({
          captureIdx: ci,
          field: "endDiffPct",
          pngA: cap.last,
          pngB: cap.next,
          cropTop: 0,
          cropBottom: 1 / 6,
        });
      }
      // mid-top: mid ≈ next
      if (cap.mid && cap.next && !cap.chainedEnd) {
        pairs.push({
          captureIdx: ci,
          field: "midTopDiffPct",
          pngA: cap.mid,
          pngB: cap.next,
          cropTop: 0,
          cropBottom: 0.7,
        });
      }
      // mid-bottom: mid ≈ first
      if (cap.mid && cap.first) {
        pairs.push({
          captureIdx: ci,
          field: "midBottomDiffPct",
          pngA: cap.mid,
          pngB: cap.first,
          cropTop: 0.7,
          cropBottom: 0,
        });
      }
      // continuity: previous[n] ≈ next[n-1]
      if (ci >= 1 && cap.previous && captures[ci - 1]!.next) {
        pairs.push({
          captureIdx: ci,
          field: "continuityDiffPct",
          pngA: captures[ci - 1]!.next!,
          pngB: cap.previous,
          cropTop: 1 / 6,
          cropBottom: 0,
        });
      }
    }

    // Decode PNGs and compute diffs in-browser.
    if (pairs.length > 0) {
      const results = await sc.page.evaluate(
        (args: { pairs: DiffPair[]; diffThreshold: number }) => {
          function decodePng(
            dataUrl: string,
          ): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => {
                const cv = document.createElement("canvas");
                cv.width = img.width;
                cv.height = img.height;
                const cvCtx = cv.getContext("2d")!;
                cvCtx.drawImage(img, 0, 0);
                const imageData = cvCtx.getImageData(0, 0, cv.width, cv.height);
                resolve({
                  data: imageData.data,
                  width: cv.width,
                  height: cv.height,
                });
              };
              img.onerror = reject;
              img.src = dataUrl;
            });
          }

          function diffPct(
            bufA: Uint8ClampedArray,
            bufB: Uint8ClampedArray,
            width: number,
            height: number,
            cropTop: number,
            cropBottom: number,
            threshold: number,
          ): number {
            const yStart = Math.round(height * cropTop);
            const yEnd = Math.round(height * (1 - cropBottom));
            let diff = 0;
            let total = 0;
            for (let y = yStart; y < yEnd; y++) {
              for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const dr = Math.abs(bufA[idx]! - bufB[idx]!);
                const dg = Math.abs(bufA[idx + 1]! - bufB[idx + 1]!);
                const db = Math.abs(bufA[idx + 2]! - bufB[idx + 2]!);
                if (dr + dg + db > threshold) diff++;
                total++;
              }
            }
            return total > 0 ? (diff / total) * 100 : 0;
          }

          return Promise.all(
            args.pairs.map(async (pair) => {
              const [imgA, imgB] = await Promise.all([
                decodePng(pair.pngA),
                decodePng(pair.pngB),
              ]);
              const pct = diffPct(
                imgA.data,
                imgB.data,
                imgA.width,
                imgA.height,
                pair.cropTop,
                pair.cropBottom,
                args.diffThreshold,
              );
              return { captureIdx: pair.captureIdx, field: pair.field, pct };
            }),
          );
        },
        { pairs, diffThreshold: DIFF_THRESHOLD },
      );

      // Apply diff results back to captures.
      for (const result of results) {
        const cap = captures[result.captureIdx]!;
        (cap as unknown as Record<string, unknown>)[result.field] = result.pct;
      }
    }

    return captures;
  } finally {
    await sc.close();
  }
}

/** Extract banner captures from busLog events. Each banner gets its 5 frames
 *  identified from the bridge data: previous (from bannerStart._prevSnapshot),
 *  first (bannerStart._canvasSnapshot), mid (tick with banner.y ~50%),
 *  last (last tick before bannerEnd), next (tick after bannerEnd). */
function extractBannerCaptures(events: E2EBusEntry[]): BannerCapture[] {
  const captures: BannerCapture[] = [];

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx]!;
    if (ev.type !== "bannerStart") continue;

    // Find the matching bannerEnd.
    let endIdx = -1;
    for (let jdx = idx + 1; jdx < events.length; jdx++) {
      if (events[jdx]!.type === "bannerEnd") {
        endIdx = jdx;
        break;
      }
    }
    if (endIdx < 0) continue;

    const endEv = events[endIdx]!;

    // Previous frame: stored on bannerStart._prevSnapshot by the bridge.
    const previous = (ev._prevSnapshot as string) ?? null;

    // First frame: bannerStart._canvasSnapshot.
    const first = (ev._canvasSnapshot as string) ?? null;

    // Mid frame: find tick with banner.y closest to 50% of MAP_H.
    let midSnapshot: string | null = null;
    let bestMidDist = Infinity;
    for (let jdx = idx + 1; jdx < endIdx; jdx++) {
      const tick = events[jdx]!;
      if (tick.type !== "tick" || !tick._canvasSnapshot) continue;
      const bannerY = tick._bannerY as number | null;
      if (bannerY === null) continue;
      const dist = Math.abs(bannerY - MAP_H * 0.5);
      if (dist < bestMidDist) {
        bestMidDist = dist;
        midSnapshot = (tick._canvasSnapshot as string) ?? null;
      }
    }

    // Last frame: last tick before bannerEnd that has a snapshot.
    let lastSnapshot: string | null = null;
    for (let jdx = endIdx - 1; jdx > idx; jdx--) {
      const tick = events[jdx]!;
      if (tick.type === "tick" && tick._canvasSnapshot) {
        lastSnapshot = (tick._canvasSnapshot as string) ?? null;
        break;
      }
    }

    // Next frame: first tick after bannerEnd with a snapshot.
    let nextSnapshot: string | null = null;
    for (let jdx = endIdx + 1; jdx < events.length; jdx++) {
      const tick = events[jdx]!;
      if (tick.type === "tick" && tick._canvasSnapshot) {
        nextSnapshot = (tick._canvasSnapshot as string) ?? null;
        break;
      }
      // Stop searching at the next banner start.
      if (tick.type === "bannerStart") break;
    }

    // Detect chaining: bannerStart immediately follows a bannerEnd.
    const chainedStart =
      captures.length > 0 && idx > 0 && events[idx - 1]?.type === "bannerEnd";
    if (chainedStart && captures.length > 0) {
      captures[captures.length - 1]!.chainedEnd = true;
    }

    captures.push({
      label: ev.modifierId
        ? `${ev.text} [${ev.modifierId}]`
        : (ev.text as string) ?? "",
      round: (ev.round as number) ?? 0,
      modifierId: (ev.modifierId as string) ?? null,
      previous,
      first,
      mid: midSnapshot,
      last: lastSnapshot ?? (endEv._canvasSnapshot as string) ?? null,
      next: nextSnapshot,
      startDiffPct: -1,
      endDiffPct: -1,
      midTopDiffPct: -1,
      midBottomDiffPct: -1,
      continuityDiffPct: -1,
      chainedStart,
      chainedEnd: false,
    });
  }

  return captures;
}
