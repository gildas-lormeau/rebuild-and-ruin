/**
 * Focused E2E test: Build & Repair banner prev-scene bug.
 *
 * Runs a single short modern game (3 rounds), captures only the first
 * Build & Repair banner after an upgrade pick, saves screenshots + diff.
 * Exits immediately after capturing — no need to play the full game.
 *
 * Run: deno run -A test/e2e-build-banner-bug.ts [--visible]
 * Requires: npm run dev
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { E2EGame } from "./e2e-helpers.ts";

const DIR = "tmp/screenshots/build-banner-bug";
const TARGET_W = 400;

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function run(): Promise<void> {
  const headless = !Deno.args.includes("--visible");

  const game = await E2EGame.create({
    seed: 1,
    humans: 0,
    headless,
    rounds: 10,
    mode: "modern",
  });

  try {
    const result = await game.page.evaluate((targetW: number) => {
      const win = globalThis as unknown as Record<string, unknown>;
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;

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

      type BannerEvent = {
        type: "start" | "end";
        text: string;
        modifierId?: string;
        round: number;
      };

      /** Sample a pixel from the full-res canvas. Returns [r,g,b]. */
      function samplePixel(
        px: number,
        py: number,
      ): [number, number, number] {
        const data = canvas
          .getContext("2d")!
          .getImageData(px, py, 1, 1).data;
        return [data[0]!, data[1]!, data[2]!];
      }

      /** ASCII map: sample the canvas on a tile grid and classify each.
       *  G=grass, W=water, #=wall, I=interior(checkerboard), .=dark/other */
      function asciiMap(): string {
        const cols = 40;
        const rows = 28;
        const stepX = canvas.width / cols;
        const stepY = (canvas.height - 40) / rows; // skip status bar
        const lines: string[] = [];
        for (let row = 0; row < rows; row++) {
          let line = "";
          for (let col = 0; col < cols; col++) {
            const px = Math.round(col * stepX + stepX / 2);
            const py = Math.round(row * stepY + stepY / 2);
            const [cr, cg, cb] = samplePixel(px, py);
            // Water: high blue
            if (cb > 100 && cb > cr * 2 && cb > cg * 1.5) { line += "W"; continue; }
            // Grass: high green, low red
            if (cg > 30 && cg > cr * 1.3 && cg > cb) { line += "G"; continue; }
            // Wall: gray (r≈g≈b, medium brightness)
            if (Math.abs(cr - cg) < 15 && Math.abs(cg - cb) < 15 && cr > 60 && cr < 180) { line += "#"; continue; }
            // Interior/checkerboard: dark reddish or brownish
            if (cr > 20 && cr < 80 && cg < 50 && cb < 50) { line += "I"; continue; }
            // Dark (banner text, UI)
            if (cr < 20 && cg < 20 && cb < 20) { line += " "; continue; }
            line += ".";
          }
          lines.push(line);
        }
        return lines.join("\n");
      }

      const probeX = Math.round(canvas.width * 0.15);
      const probeY = Math.round(canvas.height * 0.63);

      return new Promise<{
        previous: string | null;
        first: string | null;
        mid: string | null;
        last: string | null;
        next: string | null;
        round: number;
        prevProbe: [number, number, number];
        firstProbe: [number, number, number];
        prevAscii: string;
        firstAscii: string;
        midAscii: string;
        lastAscii: string;
      }>((resolve) => {
        let prevPng: string | null = null;
        let prevProbeColor: [number, number, number] = [0, 0, 0];
        let prevAsciiMap = "";
        let prevEventCount = 0;
        let upgradeEnded = false;
        let capturing = false;
        let midPng: string | null = null;
        let lastPng: string | null = null;
        let buildStarted = false;
        const mapH = 448;
        let buildResult: {
          previous: string | null;
          first: string | null;
          mid: string | null;
          last: string | null;
          next: string | null;
          round: number;
          prevProbe: [number, number, number];
          firstProbe: [number, number, number];
          prevAscii: string;
          firstAscii: string;
          midAscii: string;
          lastAscii: string;
        } | null = null;

        const prevRAF = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
          prevRAF((time: number) => {
            cb(time);

            const e2e = win.__e2e as Record<string, unknown> | undefined;
            if (!e2e) return;

            if (buildResult && !capturing) {
              // One frame after build banner ended — capture "next".
              buildResult.next = smallPng();
              resolve(buildResult);
              return;
            }

            const events = (e2e.bannerEvents ?? []) as BannerEvent[];
            const overlay = e2e.overlay as Record<string, unknown> | undefined;
            const banner = overlay?.banner as { y: number } | null | undefined;
            const newEvents = events.slice(prevEventCount);
            prevEventCount = events.length;

            const curPng = smallPng();

            for (const ev of newEvents) {
              if (ev.type === "end" && ev.text === "Choose Upgrade") {
                upgradeEnded = true;
              }

              if (
                ev.type === "start" &&
                upgradeEnded &&
                !buildStarted &&
                ev.text.includes("Build") &&
                ev.round >= 5
              ) {
                buildStarted = true;
                capturing = true;
                buildResult = {
                  previous: prevPng,
                  first: curPng,
                  mid: null,
                  last: null,
                  next: null,
                  round: ev.round,
                  prevProbe: prevProbeColor,
                  firstProbe: samplePixel(probeX, probeY),
                  prevAscii: prevAsciiMap,
                  firstAscii: asciiMap(),
                  midAscii: "",
                  lastAscii: "",
                };
              }

              if (ev.type === "end" && buildStarted && capturing) {
                buildResult!.mid = midPng;
                buildResult!.last = lastPng ?? curPng;
                buildResult!.lastAscii = asciiMap();
                capturing = false;
                // Next frame will capture "next" and resolve.
              }
            }

            if (capturing && banner) {
              if (
                !midPng &&
                banner.y >= mapH * 0.4 &&
                banner.y <= mapH * 0.6
              ) {
                midPng = curPng;
                if (buildResult) buildResult.midAscii = asciiMap();
              }
              lastPng = curPng;
            }

            prevPng = curPng;
            prevProbeColor = samplePixel(probeX, probeY);
            prevAsciiMap = asciiMap();
          });
      });
    }, TARGET_W);

    // Save screenshots.
    mkdirSync(DIR, { recursive: true });

    const frames = [
      ["1-previous", result.previous],
      ["2-first", result.first],
      ["3-mid", result.mid],
      ["4-last", result.last],
      ["5-next", result.next],
    ] as const;

    for (const [name, dataUrl] of frames) {
      if (!dataUrl || !dataUrl.startsWith("data:")) continue;
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      Deno.writeFileSync(`${DIR}/${name}.png`, bytes);
    }

    writeFileSync(
      `${DIR}/events.json`,
      JSON.stringify({ round: result.round }, null, 2),
    );

    // Save ASCII maps.
    writeFileSync(`${DIR}/ascii-previous.txt`, result.prevAscii);
    writeFileSync(`${DIR}/ascii-first.txt`, result.firstAscii);
    writeFileSync(`${DIR}/ascii-mid.txt`, result.midAscii);
    writeFileSync(`${DIR}/ascii-last.txt`, result.lastAscii);

    // Print ASCII diff: show tiles that changed between previous and first.
    const prevLines = result.prevAscii.split("\n");
    const firstLines = result.firstAscii.split("\n");
    console.log("\nASCII diff (previous → first, * = changed):");
    for (let row = 0; row < prevLines.length; row++) {
      let diffLine = "";
      for (let col = 0; col < (prevLines[row]?.length ?? 0); col++) {
        const pc = prevLines[row]![col]!;
        const fc = firstLines[row]?.[col] ?? "?";
        diffLine += pc === fc ? pc : "*";
      }
      if (diffLine.includes("*")) console.log(`  ${String(row).padStart(2)}| ${diffLine}`);
    }

    // Collect and save browser console logs.
    const allLogs = game.getLogs();
    const debugLogs = allLogs.filter((log) => log.includes("banner-debug"));
    writeFileSync(`${DIR}/console.log`, allLogs.join("\n"));
    writeFileSync(`${DIR}/debug.log`, debugLogs.join("\n"));
    console.log(`\nBuild banner at round ${result.round}`);
    console.log(`Screenshots + logs saved to ${DIR}/`);
    console.log(`\nDebug logs (${debugLogs.length}):`);
    for (const log of debugLogs) console.log(`  ${log}`);

    // Generate diffs.
    const { execSync } = await import("node:child_process");
    const diffs: Record<string, string> = {
      "diff-start.png": `"${DIR}/1-previous.png" "${DIR}/2-first.png"`,
      "diff-end.png": `"${DIR}/4-last.png" "${DIR}/5-next.png"`,
    };
    let startDiff = 0;
    for (const [outName, args] of Object.entries(diffs)) {
      try {
        const out = execSync(
          `deno run -A scripts/screenshot-diff.ts ${args} "${DIR}/${outName}"`,
          { encoding: "utf-8" },
        );
        console.log(out.trim());
        if (outName === "diff-start.png") {
          const match = out.match(/([\d.]+)% changed/);
          if (match) startDiff = parseFloat(match[1]!);
        }
      } catch {
        console.log(`(${outName} diff failed)`);
      }
    }

    // Pixel probe: check if the probe point shows grass (green = bug)
    // or interior (dark = ok). Green grass has high G, low R.
    const [prevR, prevG] = result.prevProbe;
    const [firstR, firstG] = result.firstProbe;
    const prevIsGrass = prevG > 30 && prevG > prevR * 1.3;
    const firstIsGrass = firstG > 30 && firstG > firstR * 1.3;
    console.log(
      `\nProbe at (${Math.round(TARGET_W / 6)},${Math.round(TARGET_W * 2 / 3)}):` +
        `  previous=[${result.prevProbe}] ${prevIsGrass ? "GRASS" : "interior"}` +
        `  first=[${result.firstProbe}] ${firstIsGrass ? "GRASS" : "interior"}`,
    );

    // The bug: "previous" shows interior (correct) but "first" shows
    // grass (bug — enclosed territory lost in the banner prev-scene).
    if (!prevIsGrass && firstIsGrass) {
      console.log("FAIL: interior became grass in banner prev-scene — territory lost");
      Deno.exit(1);
    } else if (startDiff > 1) {
      console.log(`FAIL: pixel diff ${startDiff.toFixed(3)}% exceeds 1% threshold`);
      Deno.exit(1);
    } else {
      console.log("PASS");
    }
  } finally {
    await game.close();
  }
}
