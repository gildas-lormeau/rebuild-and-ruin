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
 * Run: deno run -A test/e2e-banner-prev-scene.ts
 * Requires: npm run dev
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { E2EGame, E2ETest } from "./e2e-helpers.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };

/** Game configurations. Each uses a seed chosen to cover specific modifiers.
 *  seed 0 → wildfire, crumbling_walls, grunt_surge, frozen_river
 *  seed 1 → dust_storm, high_tide, rubble_clearing, sinkhole
 *  Classic mode covers the no-modifier, no-upgrade phase banner path. */
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
  /** Mid-sweep top region vs "next" top region — verifies new scene above banner. */
  midTopDiffPct: number;
  /** Mid-sweep bottom region vs "first" bottom region — verifies old scene below banner. */
  midBottomDiffPct: number;
  /** next[n-1] vs previous[n] — continuity between consecutive banners. */
  continuityDiffPct: number;
  done: boolean;
  chainedStart: boolean;
  chainedEnd: boolean;
}

const TARGET_W = 400;
const DIFF_THRESHOLD = 30;
const DEFAULT_MAX_DIFF = 1.0;
const MAP_H = 448;
const BANNER_RATIO = 0.15;
/** All 8 modifier IDs. The test asserts every one was seen at least once. */
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
/** All non-modifier banner texts the game produces. */
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

  // Track which banner types we've seen across all games.
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
      // Track coverage.
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

      // Save event metadata.
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
      const startStr =
        banner.startDiffPct >= 0
          ? `${banner.startDiffPct.toFixed(3)}%`
          : "n/a";
      const endStr =
        banner.endDiffPct >= 0 ? `${banner.endDiffPct.toFixed(3)}%` : "n/a";

      const midTopStr =
        banner.midTopDiffPct >= 0
          ? `${banner.midTopDiffPct.toFixed(3)}%`
          : "n/a";
      const midBotStr =
        banner.midBottomDiffPct >= 0
          ? `${banner.midBottomDiffPct.toFixed(3)}%`
          : "n/a";
      const contStr =
        banner.continuityDiffPct >= 0
          ? `${banner.continuityDiffPct.toFixed(3)}%`
          : "n/a";

      console.log(
        `  r${banner.round} ${banner.label}${tag}: start=${startStr} end=${endStr} midTop=${midTopStr} midBot=${midBotStr} cont=${contStr}  → ${dir}/`,
      );

      // Pixel-boundary assertions (skip chained boundaries).
      if (!banner.chainedStart) {
        const startMax = getThreshold(banner.label, "start", banner.modifierId);
        const startOk =
          banner.startDiffPct >= 0 &&
          banner.startDiffPct < startMax;
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: previous ≈ first  → ${dir}/`,
          startOk,
          `${startStr} (threshold ${startMax}%)`,
        );
      }
      if (!banner.chainedEnd && banner.endDiffPct >= 0) {
        const endMax = getThreshold(banner.label, "end", banner.modifierId);
        const endOk = banner.endDiffPct < endMax;
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: last ≈ next  → ${dir}/`,
          endOk,
          `${endStr} (threshold ${endMax}%)`,
        );
      }
      // Mid-sweep compositing: top portion of mid matches new scene,
      // bottom portion of mid matches old scene (captured ImageData).
      // Skip mid-top for chained-end banners — their "next" is the
      // successor banner's first frame (completely different scene).
      // Mid-sweep compositing: top of mid ≈ new scene, bottom of mid ≈ old scene.
      // Battle banners get a higher top threshold — "next" includes the "Ready"
      // countdown overlay and cannon rotation that aren't present mid-sweep.
      if (banner.midTopDiffPct >= 0 && !banner.chainedEnd) {
        const midTopMax = banner.label.startsWith("Prepare for Battle") ? 12 : 5;
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: mid-top ≈ next  → ${dir}/`,
          banner.midTopDiffPct < midTopMax,
          `${midTopStr} (threshold ${midTopMax}%)`,
        );
      }
      if (banner.midBottomDiffPct >= 0) {
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: mid-bottom ≈ first  → ${dir}/`,
          banner.midBottomDiffPct < 5,
          `${midBotStr} (threshold 5%)`,
        );
      }
      // Cross-banner continuity: next[n-1] ≈ previous[n].
      // Uses the same threshold as "previous ≈ first" for that banner type.
      if (banner.continuityDiffPct >= 0) {
        const contMax = getThreshold(banner.label, "start", banner.modifierId);
        test.check(
          `[${config.label}] r${banner.round} ${banner.label}: continuity next[n-1] ≈ previous[n]  → ${dir}/`,
          banner.continuityDiffPct < contMax,
          `${contStr} (threshold ${contMax}%)`,
        );
      }
    }
  }

  // ── Coverage assertions ──────────────────────────────────────────────
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

/** Per-banner-type diff thresholds (%).
 *  Each threshold sits above the observed max for that class so regressions
 *  are caught without flaky false positives.
 *
 *  Observed maxima (ImageData-based banners):
 *    Build & Repair     START  8.7%   END  1.4%   (battle→build terrain diff behind upgrade dialog)
 *    Choose Upgrade     START 16.2%   END  5.0%
 *    Place Cannons      START  0.9%   END  0.1%
 *    Prepare for Battle START 14.1%   END  8.8%
 *    Modifier banners   START 13.2%   END 11.3%
 */
function getThreshold(
  label: string,
  side: "start" | "end",
  modifierId: string | null,
): number {
  // Modifier start: preceding tile-mutation effects (high-tide recede,
  // sinkhole, wildfire). Max observed: 13.2%.
  if (side === "start" && modifierId) return 17;
  // Modifier end: chained into battle banner, large scene change.
  // Max observed: 11.3%.
  if (side === "end" && modifierId) return 15;
  // Prepare for Battle start: follows modifier or cannon phase.
  // Max observed: 14.1%.
  if (label === "Prepare for Battle" && side === "start") return 18;
  // Prepare for Battle end: grunts spawn, territory highlights.
  // Max observed: 8.8%.
  if (label === "Prepare for Battle" && side === "end") return 11;
  // Choose Upgrade start: follows battle, large scene change at
  // high rounds. Max observed: 16.2%.
  if (label === "Choose Upgrade" && side === "start") return 20;
  // Choose Upgrade end: AI picks change dialog overlay.
  // Max observed: 5.0%.
  if (label === "Choose Upgrade" && side === "end") return 6;
  // Build & Repair: ImageData is captured at end of battle (before upgrade
  // dialog). "previous" shows the upgrade dialog with build-phase terrain
  // behind it — the battle→build terrain change + cannon rotation visible
  // through the dialog causes ~2-9% diffs. Max observed: 8.7%.
  if (label.startsWith("Build & Repair")) return 10;
  return DEFAULT_MAX_DIFF;
}

function buildGameConfigs(): GameConfig[] {
  const fixtures = SEED_FIXTURES as Record<string, number>;
  // Group modifier seeds by seed value to minimize game count.
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
    configs.push({
      label: `modern-s${seed}`,
      seed,
      mode: "modern",
      rounds: 20,
    });
  }
  // Classic mode — any seed, short game, covers pure phase banners.
  configs.push({ label: "classic-s0", seed: 0, mode: "classic", rounds: 3 });
  return configs;
}

async function runOneGame(config: GameConfig): Promise<BannerCapture[]> {
  const game = await E2EGame.create({
    seed: config.seed,
    humans: 0,
    headless: !Deno.args.includes("--visible"),
    rounds: config.rounds,
    mode: config.mode,
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

        /** Compare pixels in a vertical band of the canvas.
         *  @param cropTop — fraction of height to skip at the top (0–1)
         *  @param cropBottom — fraction of height to skip at the bottom (0–1)
         *  The middle region (1 - cropTop - cropBottom) is compared. */
        function diffPct(
          bufA: Uint8ClampedArray,
          bufB: Uint8ClampedArray,
          cropTop: number,
          cropBottom: number,
        ): number {
          const cw = canvas.width;
          const ch = canvas.height;
          const yStart = Math.round(ch * cropTop);
          const yEnd = Math.round(ch * (1 - cropBottom));
          let diff = 0;
          let total = 0;
          for (let y = yStart; y < yEnd; y++) {
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
        /** Pixels captured at banner start (for mid-bottom comparison). */
        let firstPixelsForMid: Uint8ClampedArray | null = null;
        /** Pixels captured at mid-sweep (for mid-top/bottom comparison). */
        let midPixelsForMid: Uint8ClampedArray | null = null;
        let prevEventCount = 0;
        let pendingNextTracker: BannerCapture | null = null;
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
                  // last ≈ next: banner strip is near the bottom → crop bottom 1/6
                  pendingNextTracker.endDiffPct = diffPct(
                    lastCandidatePixels,
                    curPixels,
                    0,
                    1 / 6,
                  );
                }
                // Mid-sweep compositing check: top of mid ≈ top of next (new
                // scene), bottom of mid ≈ bottom of first (old scene).
                if (midPixelsForMid) {
                  // Top 30%: new scene above the banner sweep line.
                  pendingNextTracker.midTopDiffPct = diffPct(
                    midPixelsForMid,
                    curPixels,
                    0,
                    0.7,
                  );
                  // Bottom 30%: old scene below the banner sweep line.
                  if (firstPixelsForMid) {
                    pendingNextTracker.midBottomDiffPct = diffPct(
                      midPixelsForMid,
                      firstPixelsForMid,
                      0.7,
                      0,
                    );
                  }
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
                    midTopDiffPct: -1,
                    midBottomDiffPct: -1,
                    continuityDiffPct: -1,
                    done: false,
                    chainedStart,
                    chainedEnd: false,
                  };
                  // Continuity: compare previous banner's "next" pixels
                  // with this banner's "first" pixels.
                  if (captures.length >= 2) {
                    const prev = captures[captures.length - 2]!;
                    if (prev.done && prevPixels) {
                      // prevPixels here is the frame before this banner
                      // started = the "next" frame of the previous banner.
                      // curPixels is the "first" frame of this banner.
                      tracker.continuityDiffPct = diffPct(
                        prevPixels,
                        curPixels,
                        1 / 6,
                        0,
                      );
                    }
                  }
                  firstPixelsForMid = curPixels;
                  midPixelsForMid = null;
                  if (!chainedStart && prevPixels) {
                    // previous ≈ first: banner strip is near the top → crop top 1/6
                    tracker.startDiffPct = diffPct(
                      prevPixels,
                      curPixels,
                      1 / 6,
                      0,
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
                  midPixelsForMid = curPixels;
                }
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

    return banners;
  } finally {
    await game.close();
  }
}
