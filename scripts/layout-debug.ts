/**
 * Dump bounding boxes and take a screenshot of new_index.html.
 *
 * Usage:
 *   npx tsx test/layout-debug.ts                # desktop 1024x600
 *   npx tsx test/layout-debug.ts --mobile       # Pixel 7 landscape (839x412)
 *   npx tsx test/layout-debug.ts --portrait     # Pixel 7 portrait (412x839)
 *   npx tsx test/layout-debug.ts --left-handed  # toggle left-handed layout
 *   npx tsx test/layout-debug.ts --size 1200x450
 *   npx tsx test/layout-debug.ts --all          # run all standard viewports
 */

import { chromium, type Browser, type Page } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const ALL = process.argv.includes("--all");

interface ViewportConfig {
  name: string;
  width: number;
  height: number;
  touch: boolean;
  leftHanded: boolean;
}

const PRESETS: ViewportConfig[] = [
  { name: "desktop",          width: 1024, height: 600,  touch: false, leftHanded: false },
  { name: "desktop-lh",       width: 1024, height: 600,  touch: false, leftHanded: true },
  { name: "desktop-small",    width: 800,  height: 600,  touch: false, leftHanded: false },
  { name: "desktop-tall",     width: 1024, height: 900,  touch: false, leftHanded: false },
  { name: "wide-short",       width: 1200, height: 450,  touch: false, leftHanded: false },
  { name: "ultrawide",        width: 2560, height: 1080, touch: false, leftHanded: false },
  { name: "mobile-landscape", width: 839,  height: 412,  touch: true,  leftHanded: false },
  { name: "mobile-portrait",  width: 412,  height: 839,  touch: true,  leftHanded: false },
  { name: "ipad-landscape",   width: 1024, height: 768,  touch: true,  leftHanded: false },
  { name: "ipad-portrait",    width: 768,  height: 1024, touch: true,  leftHanded: false },
];

function parseArgs(): ViewportConfig[] {
  if (ALL) return PRESETS;

  const MOBILE = process.argv.includes("--mobile") || process.argv.includes("--portrait");
  const PORTRAIT = process.argv.includes("--portrait");
  const LEFT_HANDED = process.argv.includes("--left-handed");
  const sizeIdx = process.argv.indexOf("--size");
  const sizeArg = sizeIdx >= 0 ? process.argv[sizeIdx + 1] : null;

  let w = 1024, h = 600, touch = false;
  let name = "desktop";

  if (sizeArg) {
    const [sw, sh] = sizeArg.split("x").map(Number);
    if (sw && sh) { w = sw; h = sh; name = `${w}x${h}`; }
  } else if (PORTRAIT) {
    w = 412; h = 839; touch = true; name = "mobile-portrait";
  } else if (MOBILE) {
    w = 839; h = 412; touch = true; name = "mobile-landscape";
  }

  if (LEFT_HANDED) name += "-lh";
  return [{ name, width: w, height: h, touch, leftHanded: LEFT_HANDED }];
}

async function runViewport(browser: Browser, config: ViewportConfig): Promise<string[]> {
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    hasTouch: config.touch,
    isMobile: config.touch,
  });
  const page = await context.newPage();

  await page.goto("http://localhost:5173/new_index.html", { waitUntil: "load" });
  await page.waitForTimeout(300);

  if (config.leftHanded) {
    await page.keyboard.press("l");
    await page.waitForTimeout(200);
  }

  const boxes = await dumpBoxes(page);
  const lines = formatReport(config, boxes);

  mkdirSync("logs", { recursive: true });
  const txtPath = `logs/layout-${config.name}.txt`;
  const pngPath = `logs/layout-${config.name}.png`;
  writeFileSync(txtPath, lines.join("\n"));
  await page.screenshot({ path: pngPath, fullPage: false });
  lines.push(`Files: ${txtPath}  ${pngPath}`);

  await context.close();
  return lines;
}

interface BoxInfo {
  sel: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
  css: Record<string, string>;
}

interface DumpResult {
  viewport: { w: number; h: number };
  boxes: BoxInfo[];
}

const CSS_PROPS = [
  "display", "width", "height", "aspect-ratio",
  "align-self", "justify-self", "align-items", "justify-items",
  "grid-template-columns", "grid-template-rows",
  "container-type", "overflow", "order",
];

async function dumpBoxes(page: Page): Promise<DumpResult> {
  return page.evaluate((props: string[]) => {
    const selectors = [
      "#game-container",
      "aside.panel-left",
      "aside.panel-right",
      "canvas:not(.loupe)",
      ".panel-top",
      ".panel-bottom",
      ".loupe",
      "nav",
      ".zoom-group",
      ".btn-round",
      "nav button",
    ];
    const results: { sel: string; tag: string; rect: { x: number; y: number; w: number; h: number }; css: Record<string, string> }[] = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const css: Record<string, string> = {};
        for (const p of props) {
          const v = cs.getPropertyValue(p);
          if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "visible" && v !== "0") {
            css[p] = v;
          }
        }
        results.push({
          sel,
          tag: el.tagName.toLowerCase() + (el.className ? `.${el.className}` : "") + (el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          css,
        });
      }
    }
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, boxes: results };
  }, CSS_PROPS);
}

function formatReport(config: ViewportConfig, dump: DumpResult): string[] {
  const orient = dump.viewport.w >= dump.viewport.h ? "landscape" : "portrait";
  const header = `${config.name} — ${dump.viewport.w}x${dump.viewport.h} (${orient}${config.touch ? ", touch" : ""}${config.leftHanded ? ", left-handed" : ""})`;
  const lines: string[] = [header, ""];

  const maxTag = Math.max(...dump.boxes.map(b => b.tag.length));
  for (const b of dump.boxes) {
    const { x, y, w, h } = b.rect;
    const cssStr = Object.entries(b.css).map(([k, v]) => `${k}:${v}`).join("; ");
    lines.push(`  ${b.tag.padEnd(maxTag)}  ${String(x).padStart(5)},${String(y).padStart(5)}  ${String(w).padStart(5)}x${String(h).padStart(4)}  ${cssStr}`);
  }

  const panel = dump.boxes.find(b => b.sel === "aside.panel-left");
  const loupe = dump.boxes.find(b => b.sel === ".loupe" && b.rect.w > 0 && b.rect.h > 0);
  const dpad = dump.boxes.find(b => b.sel === "nav" && b.rect.w > 0 && b.rect.h > 0);
  const canvas = dump.boxes.find(b => b.sel === "canvas:not(.loupe)");
  if (panel && loupe && dpad && canvas) {
    lines.push("");
    lines.push(`  Canvas: ${canvas.rect.w}x${canvas.rect.h} (${((canvas.rect.w / dump.viewport.w) * 100).toFixed(0)}% of viewport)`);
    if (loupe.rect.h > 0) {
      const gap = dpad.rect.y - (loupe.rect.y + loupe.rect.h);
      lines.push(`  Loupe: ${loupe.rect.w}x${loupe.rect.h}  Dpad: ${dpad.rect.w}x${dpad.rect.h}  Gap: ${gap}px`);
      const ratio = (loupe.rect.w / loupe.rect.h).toFixed(2);
      lines.push(`  Loupe ratio: ${ratio} (target: ${(5 / 6).toFixed(2)})`);
    } else {
      lines.push(`  Loupe: hidden`);
    }
  }

  return lines;
}

function validateLayout(reportLines: string[], config: ViewportConfig): string[] {
  // Parse box data from report lines
  const boxes: { tag: string; x: number; y: number; w: number; h: number }[] = [];
  for (const line of reportLines) {
    const m = line.match(/^\s+(\S+)\s+(-?\d+),\s*(-?\d+)\s+(-?\d+)x\s*(-?\d+)/);
    if (m) {
      boxes.push({ tag: m[1]!, x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! });
    }
  }

  const vw = config.width;
  const vh = config.height;
  const issues: string[] = [];

  for (const b of boxes) {
    // Skip collapsed elements (display:contents makes asides 0x0)
    if (b.w === 0 && b.h === 0) continue;

    const right = b.x + b.w;
    const bottom = b.y + b.h;

    // Off-screen: entirely outside viewport
    if (right <= 0 || b.x >= vw || bottom <= 0 || b.y >= vh) {
      issues.push(`OFF-SCREEN: ${b.tag} at (${b.x},${b.y}) ${b.w}x${b.h}`);
      continue;
    }

    // Overflow right
    if (right > vw + 1) {
      issues.push(`OVERFLOW-RIGHT: ${b.tag} ends at x=${right} (viewport=${vw}, excess=${right - vw}px)`);
    }

    // Overflow bottom
    if (bottom > vh + 1) {
      issues.push(`OVERFLOW-BOTTOM: ${b.tag} ends at y=${bottom} (viewport=${vh}, excess=${bottom - vh}px)`);
    }

    // Clipped left
    if (b.x < -1) {
      issues.push(`CLIPPED-LEFT: ${b.tag} starts at x=${b.x}`);
    }

    // Clipped top
    if (b.y < -1) {
      issues.push(`CLIPPED-TOP: ${b.tag} starts at y=${b.y}`);
    }
  }

  // Check loupe aspect ratio
  const loupe = boxes.find(b => b.tag.includes("loupe") && b.w > 0 && b.h > 0);
  if (loupe && loupe.w > 0 && loupe.h > 0) {
    const ratio = loupe.w / loupe.h;
    const target = 5 / 6;
    if (Math.abs(ratio - target) > 0.02) {
      issues.push(`RATIO: loupe ${loupe.w}x${loupe.h} ratio=${ratio.toFixed(2)} (target=${target.toFixed(2)})`);
    }
  }

  // Canvas uses object-fit:contain — the CSS box fills flex space,
  // the bitmap renders at correct ratio inside it. No box ratio check needed.

  // Spacing checks: interactive elements need more margin from viewport edges than the loupe.
  // "safe margin" = distance from element edge to nearest viewport edge.
  const interactive = boxes.filter(b =>
    b.w > 0 && b.h > 0 && (
      b.tag.includes("btn-round") ||
      b.tag.includes("D-pad") ||
      b.tag.includes("controls")
    ));
  const loupeBox = boxes.find(b => b.tag.includes("loupe") && b.w > 0 && b.h > 0);

  // Check that interactive elements have more viewport-edge distance than the loupe.
  // Only check edges that are actually near the viewport boundary (within half the viewport).
  for (const b of interactive) {
    const edges: [string, number][] = [];
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // Only check edges on the side of the viewport the element is near
    if (cx < vw / 2) edges.push(["left", b.x]);
    if (cx > vw / 2) edges.push(["right", vw - (b.x + b.w)]);
    if (cy < vh / 2) edges.push(["top", b.y]);
    if (cy > vh / 2) edges.push(["bottom", vh - (b.y + b.h)]);

    if (loupeBox) {
      const loupeMin = Math.min(loupeBox.y, loupeBox.x);
      for (const [side, dist] of edges) {
        if (loupeMin > 0 && dist < loupeMin * 1.5) {
          issues.push(`SPACING: ${b.tag} ${side}=${dist}px too close to edge (loupe=${loupeMin}px, want >=${Math.round(loupeMin * 1.5)}px)`);
        }
      }
    }
  }

  if (issues.length === 0) issues.push("OK");
  return issues.length === 1 && issues[0] === "OK" ? [] : issues;
}

async function main() {
  const configs = parseArgs();
  const browser = await chromium.launch({ headless: true });
  let allPassed = true;

  for (const config of configs) {
    const lines = await runViewport(browser, config);
    for (const l of lines) console.log(l);
    console.log("");

    // Validate layout
    const issues = validateLayout(lines, config);
    if (issues.length > 0) {
      for (const issue of issues) console.log(`  ⚠ ${issue}`);
      allPassed = false;
    }
  }

  await browser.close();
  if (!allPassed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
