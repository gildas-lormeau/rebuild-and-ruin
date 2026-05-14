/**
 * CLI sprite viewer. Spawns a headless Chromium tab against the Vite
 * dev server's `sprite-viewer.html`, screenshots the canvas, and pipes
 * the PNG through `img2sixel` to stdout (renders inline in any
 * sixel-capable terminal — including the VSCode integrated terminal).
 *
 * Usage (dev server must be running: `npm run dev`):
 *
 *   deno run -A scripts/sprite-view.ts --sprite cannon --variant tier_1
 *   deno run -A scripts/sprite-view.ts --sprite grunt --pitch 0   # top-down
 *   deno run -A scripts/sprite-view.ts --sprite tower --scale 12
 *
 * Sprites are rendered at their native canvasPx (32 for 1×1 tiles, 64
 * for 2×2 etc.) multiplied by `--scale`. Default scale is 8.
 *
 * Requires `img2sixel` on PATH (`brew install libsixel`).
 */

import { chromium } from "playwright";
import { waitForPageFn } from "../test/e2e-helpers.ts";
import { SPRITE_SCENES } from "./sprite-debug-registry.ts";

interface Args {
  sprite: string | undefined;
  variant: string | undefined;
  pitch: number;
  scale: number;
  host: string;
  outFile: string | undefined;
  raw: boolean;
  list: boolean;
}

interface VariantEntry {
  name: string;
  canvasPx: number;
  canvasPxH?: number;
}

const args = parseArgs(Deno.args);

if (args.list) {
  printVariants(args.sprite);
  Deno.exit(0);
}

await main({ ...args, sprite: args.sprite ?? "cannon" });

function printVariants(spriteFilter: string | undefined): void {
  const kinds = Object.keys(SPRITE_SCENES) as (keyof typeof SPRITE_SCENES)[];
  const filtered = spriteFilter
    ? kinds.filter((k) => k === toRegistryKey(spriteFilter))
    : kinds;
  if (filtered.length === 0) {
    console.error(`Unknown sprite: ${spriteFilter}`);
    console.error(`Known: ${kinds.join(", ")}`);
    Deno.exit(1);
  }
  for (const kind of filtered) {
    const scene = SPRITE_SCENES[kind];
    console.log(`${kind}:`);
    if (scene.VARIANTS.length === 0) {
      console.log("  (no variants)");
      continue;
    }
    for (const variant of scene.VARIANTS) {
      const v = variant as VariantEntry;
      const sizeLabel =
        v.canvasPxH !== undefined && v.canvasPxH !== v.canvasPx
          ? `${v.canvasPx}×${v.canvasPxH}`
          : `${v.canvasPx}px`;
      console.log(`  ${v.name}  (${sizeLabel})`);
    }
  }
}

async function main(opts: Args): Promise<void> {
  if (opts.sprite === undefined) throw new Error("sprite is required");
  // Throws if variant doesn't exist — fail before launching the browser.
  const size = lookupVariantSize(opts.sprite, opts.variant);
  const canvasW = size.canvasPx * opts.scale;
  // The page auto-frames vertically — actual canvas height depends on
  // the model's projected silhouette at the chosen pitch. Allocate a
  // generous viewport so the canvas isn't clipped; locator.screenshot
  // captures the canvas's actual pixels regardless.
  const viewportH = Math.max(canvasW * 2, canvasW);

  const url = new URL(`${opts.host}/sprite-viewer.html`);
  url.searchParams.set("sprite", opts.sprite);
  if (opts.variant !== undefined) {
    url.searchParams.set("variant", opts.variant);
  }
  url.searchParams.set("pitch", String(opts.pitch));
  url.searchParams.set("scale", String(opts.scale));

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: canvasW, height: viewportH },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on("pageerror", (error) => {
      console.error(`[page error] ${error.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[console] ${msg.text()}`);
    });

    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
    });
    if (!response || !response.ok()) {
      throw new Error(
        `Failed to load ${url.toString()}: ${response?.status() ?? "no response"}`,
      );
    }

    await waitForPageFn(
      page,
      () => {
        const viewer = globalThis as unknown as {
          __SPRITE_VIEWER_READY?: boolean;
          __SPRITE_VIEWER_ERROR?: string;
        };
        if (viewer.__SPRITE_VIEWER_ERROR) {
          throw new Error(viewer.__SPRITE_VIEWER_ERROR);
        }
        return viewer.__SPRITE_VIEWER_READY === true;
      },
      10_000,
    );

    const canvas = page.locator("#sprite-canvas");
    const png = await canvas.screenshot({ type: "png", omitBackground: false });

    if (opts.outFile !== undefined) {
      await Deno.writeFile(opts.outFile, png);
      console.error(`Wrote ${opts.outFile} (${png.byteLength} bytes)`);
    } else if (opts.raw) {
      await writeToStdout(png);
    } else {
      await pipeToImg2Sixel(png);
    }
  } finally {
    await browser.close();
  }
}

function lookupVariantSize(
  kind: string,
  variantName: string | undefined,
): { canvasPx: number; canvasPxH: number } {
  const registryKey = toRegistryKey(kind);
  if (registryKey === undefined) throw new Error(`Unknown sprite: ${kind}`);
  const scene = SPRITE_SCENES[registryKey];
  const variant =
    variantName === undefined
      ? scene.VARIANTS[0]
      : scene.VARIANTS.find((v: { name: string }) => v.name === variantName);
  if (variant === undefined) {
    throw new Error(
      `Unknown ${kind} variant: ${variantName}. ` +
        `Run with --list --sprite ${kind} to see options.`,
    );
  }
  const v = variant as VariantEntry;
  return {
    canvasPx: v.canvasPx,
    canvasPxH: v.canvasPxH ?? v.canvasPx,
  };
}

function toRegistryKey(
  cliKind: string,
): keyof typeof SPRITE_SCENES | undefined {
  const normalized = cliKind === "supply-ship" ? "supply_ship" : cliKind;
  return normalized in SPRITE_SCENES
    ? (normalized as keyof typeof SPRITE_SCENES)
    : undefined;
}

async function pipeToImg2Sixel(png: Uint8Array): Promise<void> {
  const cmd = new Deno.Command("img2sixel", {
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(png);
  await writer.close();
  const status = await child.status;
  if (!status.success) {
    throw new Error(`img2sixel exited with code ${status.code}`);
  }
}

async function writeToStdout(bytes: Uint8Array): Promise<void> {
  const writer = Deno.stdout.writable.getWriter();
  await writer.write(bytes);
  writer.releaseLock();
}

function parseArgs(argv: string[]): Args {
  let sprite: string | undefined;
  let variant: string | undefined;
  let pitch = 30;
  let scale = 12;
  let host = "http://localhost:5173";
  let outFile: string | undefined;
  let raw = false;
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      i++;
      return value;
    };
    switch (flag) {
      case "--sprite":
        sprite = next();
        break;
      case "--variant":
        variant = next();
        break;
      case "--pitch":
        pitch = Number(next());
        break;
      case "--top":
        pitch = 0;
        break;
      case "--scale":
        scale = Math.max(1, Math.floor(Number(next())));
        break;
      case "--host":
        host = next();
        break;
      case "--out":
        outFile = next();
        break;
      case "--raw":
        raw = true;
        break;
      case "--list":
        list = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        Deno.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { sprite, variant, pitch, scale, host, outFile, raw, list };
}

function printHelp(): void {
  console.log(`Usage: deno run -A scripts/sprite-view.ts [options]

Options:
  --sprite <kind>     cannon | grunt | tower | house | wall | pit |
                      balloon | supply-ship | cannonball | debris | rampart
                      (default: cannon)
  --variant <name>    Variant within the sprite (e.g. tier_1, grunt_n).
                      Defaults to the first variant of the kind.
  --pitch <deg>       Camera pitch in degrees. 0 = top-down, 30 = battle.
                      (default: 30)
  --top               Shortcut for --pitch 0.
  --scale <N>         Integer upscale of the variant's native canvasPx.
                      (default: 12, so a 32px grunt renders at 384px and
                      a 64px tower at 768px — sweet spot for AI vision)
  --host <url>        Vite dev server URL. (default: http://localhost:5173)
  --out <file>        Write PNG to file instead of piping to img2sixel.
  --raw               Emit PNG bytes to stdout instead of piping.
  --list              List variants for the given --sprite (or all sprites
                      if --sprite is omitted) and exit. No browser needed.

Requires: npm run dev running, and img2sixel on PATH.`);
}
