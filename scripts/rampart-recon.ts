/**
 * Rampart board reconstructor (Deno) — integrates with the classifier.
 *
 * Turns a BUILD2D framebuffer frame (640x400) into structured board data:
 * grunts (with N/S/E/W orientation), secondary towers (alive/dead), walls,
 * houses, water, and deduced home-castle centers.
 *
 * Core technique (per the game's fixed VGA palette): remove the flat background
 * (grass greens + red/orange/blue territory fills + black), then bitmap-match
 * each tile's leftover foreground against the sprite templates. Towers are found
 * by their brownish-grey body color (tolerant) and split alive/dead by pure black.
 *
 * Templates live in tmp/rampart-templates/ (recovered from the saved sprites,
 * outside the volatile captures dir). Decoding uses ffmpeg — never the screen.
 *
 * Usage:
 *   deno run -A scripts/rampart-recon.ts <frame.png>          # ASCII board
 *   deno run -A scripts/rampart-recon.ts <frame.png> --json   # structured data
 */

import { decodeRGB } from "./rampart-phase.ts";

export interface Grunt {
  r: number;
  c: number;
  dir: "N" | "S" | "E" | "W";
}

export interface Tower {
  r: number;
  c: number;
  state: "alive" | "dead";
}

export interface Board {
  grunts: Grunt[];
  towers: Tower[];
  walls: Record<string, [number, number][]>;
  houses: [number, number][];
  water: [number, number][];
  homes: Record<string, [number, number]>;
  grid: string[][];
}

interface Template {
  label: string;
  w: number;
  h: number;
  px: Uint8Array; // RGB
  fg: Uint8Array; // 1 where foreground (not background palette)
  fgCount: number;
}

const TEMPLATE_DIR = "tmp/rampart-templates";
// Flat background palette (enc = (B<<16)|(G<<8)|R), same set the classifier uses.
const BG = new Set([
  0x000000, 0x008600, 0x007100, 0x006900, 0x6d0000, 0x0045be, 0x00009a,
]);
const enc = (r: number, g: number, b: number) => (b << 16) | (g << 8) | r;
// Water is one flat blue RGB(28,105,158). The sprite templates only matched the
// bank/orientation patterns, so horizontal river stretches, solid-interior tiles,
// and tiles with the build-timer text painted over them were missed. Detect water
// by colour instead (orientation-independent): a tile that is majority water-blue.
// Grass/border tiles carry <=40 such pixels, real water 130-256, so 96 is clean.
const isWaterBlue = (r: number, g: number, b: number) =>
  r === 28 && g === 105 && b === 158;
// The river is ~3 tiles wide; its two bank tiles are mostly bank-brown #6d3c04
// (109,60,4) with only ~40 water-blue px, so blue alone under-counts the river by
// a tile each side. Count bank-brown toward the water area (per the game: the bank
// is part of the river barrier): a tile is water if blue+bank covers >=~38% of it
// AND it has some real blue (so a dry brown road/border never qualifies). Measured:
// river tiles blue+bank >=136, every non-river tile <60.
const isBankBrown = (r: number, g: number, b: number) =>
  r === 109 && g === 60 && b === 4;
// the build-timer digits (white #e3e3e3) are painted over water tiles
const isTimerWhite = (r: number, g: number, b: number) =>
  r === 227 && g === 227 && b === 227;
const WATER_AREA = 96;
const WATER_BLUE_MIN = 16;
// Tower body = the exact reddish-grey RGB(117,85,85). (The blue player's wall
// uses a *different* near color RGB(125,85,85); a tolerant range swallows it and
// eats the blue wall ring as a tower, so this must be exact.)
const isTowerBody = (r: number, g: number, b: number) =>
  r === 117 && g === 85 && b === 85;
const isBlack = (r: number, g: number, b: number) =>
  r === 0 && g === 0 && b === 0;
const dirOf = (label: string): Grunt["dir"] =>
  label[label.length - 1] === "1" || label[label.length - 1] === "2"
    ? "W" // grunt_W1 / grunt_W2
    : (label.slice(-1) as Grunt["dir"]);
const DIR_CH: Record<Grunt["dir"], string> = { N: "^", S: "v", E: ">", W: "<" };
export const TILE = 16;
export const COLS = 40;
export const ROWS = 25;

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error(
      "usage: deno run -A scripts/rampart-recon.ts <frame.png> [--json]",
    );
    Deno.exit(2);
  }
  const templates = await loadTemplates();
  const { px } = await decodeRGB(path);
  const board = reconstruct(px, templates);
  if (Deno.args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          grunts: board.grunts,
          towers: board.towers,
          homes: board.homes,
          houses: board.houses.length,
          water: board.water.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderAscii(board));
    console.log(
      `\ngrunts=${board.grunts.length} towers=${board.towers.length} ` +
        `walls={red:${board.walls.red.length},or:${board.walls.or.length},b:${board.walls.b.length}} ` +
        `houses=${board.houses.length} water=${board.water.length} homes=${Object.keys(board.homes).join(",")}`,
    );
  }
}

export async function loadTemplates(dir = TEMPLATE_DIR): Promise<Template[]> {
  const out: Template[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".png")) continue;
    const { px, w, h } = await decodeAny(`${dir}/${entry.name}`);
    const fg = new Uint8Array(w * h);
    let fgCount = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 3;
      if (!BG.has(enc(px[o], px[o + 1], px[o + 2]))) {
        fg[i] = 1;
        fgCount++;
      }
    }
    out.push({ label: entry.name.slice(0, -4), w, h, px, fg, fgCount });
  }
  return out;
}

export function reconstruct(
  px: Uint8Array,
  templates: Template[],
  width = 640,
): Board {
  const grid: string[][] = Array.from({ length: ROWS }, () =>
    Array<string>(COLS).fill("."),
  );
  const used: boolean[][] = Array.from({ length: ROWS }, () =>
    Array<boolean>(COLS).fill(false),
  );
  const pixel = (x: number, y: number) => {
    const o = (y * width + x) * 3;
    return [px[o], px[o + 1], px[o + 2]] as const;
  };

  // 1) towers: per-tile count of brownish-grey body pixels; >=4 => tower tile.
  const towerTile: boolean[][] = Array.from({ length: ROWS }, () =>
    Array<boolean>(COLS).fill(false),
  );
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let body = 0;
      for (let y = r * TILE; y < (r + 1) * TILE; y++) {
        for (let x = c * TILE; x < (c + 1) * TILE; x++) {
          const [pr, pg, pb] = pixel(x, y);
          if (isTowerBody(pr, pg, pb)) body++;
        }
      }
      towerTile[r][c] = body >= 4;
    }
  }
  const towers: Tower[] = [];
  for (const cells of components(towerTile)) {
    let r0 = ROWS,
      r1 = 0,
      c0 = COLS,
      c1 = 0;
    for (const [y, x] of cells) {
      r0 = Math.min(r0, y);
      r1 = Math.max(r1, y);
      c0 = Math.min(c0, x);
      c1 = Math.max(c1, x);
    }
    let black = 0;
    for (let y = r0 * TILE; y < (r1 + 1) * TILE; y++) {
      for (let x = c0 * TILE; x < (c1 + 1) * TILE; x++) {
        const [pr, pg, pb] = pixel(x, y);
        if (isBlack(pr, pg, pb)) black++;
      }
    }
    towers.push({ r: r0, c: c0, state: black >= 4 ? "dead" : "alive" });
    for (let y = r0; y <= r1; y++) {
      for (let x = c0; x <= c1; x++) {
        used[y][x] = true;
        grid[y][x] = "TWR";
      }
    }
  }

  // 2) 1x1 tiles: background-removed bitmap match against the 16x16 templates.
  const t16 = templates.filter((t) => t.w === TILE && t.h === TILE);
  const walls: Record<string, [number, number][]> = { red: [], or: [], b: [] };
  const houses: [number, number][] = [];
  const water: [number, number][] = [];
  const grunts: Grunt[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (used[r][c]) continue;
      // tile foreground mask (+ count water-blue / bank-brown / timer-white px)
      const tfg = new Uint8Array(TILE * TILE);
      let bluePx = 0;
      let waterArea = 0;
      for (let i = 0; i < TILE * TILE; i++) {
        const [pr, pg, pb] = pixel(
          c * TILE + (i % TILE),
          r * TILE + Math.floor(i / TILE),
        );
        if (!BG.has(enc(pr, pg, pb))) tfg[i] = 1;
        if (isWaterBlue(pr, pg, pb)) {
          bluePx++;
          waterArea++;
        } else if (isBankBrown(pr, pg, pb) || isTimerWhite(pr, pg, pb)) {
          // bank is part of the river; the build-timer text is painted over water
          waterArea++;
        }
      }
      // color-based water short-circuit (templates miss horizontal/solid/text/bank
      // tiles). Needs some real blue so a dry brown road/border never qualifies.
      if (bluePx >= WATER_BLUE_MIN && waterArea >= WATER_AREA) {
        grid[r][c] = "water";
        water.push([r, c]);
        continue;
      }
      let best: string | null = null;
      let bestScore = 0;
      for (const t of t16) {
        if (t.fgCount < 3) continue;
        let matchFg = 0;
        let tileFgExtra = 0;
        for (let i = 0; i < TILE * TILE; i++) {
          const x = c * TILE + (i % TILE),
            y = r * TILE + Math.floor(i / TILE);
          const o = (y * width + x) * 3;
          const to = i * 3;
          if (t.fg[i]) {
            if (
              px[o] === t.px[to] &&
              px[o + 1] === t.px[to + 1] &&
              px[o + 2] === t.px[to + 2]
            )
              matchFg++;
          } else if (tfg[i]) {
            tileFgExtra++;
          }
        }
        const score = matchFg / t.fgCount - 0.5 * (tileFgExtra / t.fgCount);
        if (score > bestScore) {
          bestScore = score;
          best = t.label;
        }
      }
      if (bestScore <= 0.75 || !best) continue;
      grid[r][c] = best;
      if (best === "house") houses.push([r, c]);
      else if (best.startsWith("water")) water.push([r, c]);
      else if (best.startsWith("grunt"))
        grunts.push({ r, c, dir: dirOf(best) });
      else if (best.startsWith("wall")) {
        const color = best.endsWith("_red")
          ? "red"
          : best.endsWith("_or")
            ? "or"
            : "b";
        walls[color].push([r, c]);
      }
    }
  }

  // 3) home castles: a wall ring of >=8 same-color walls -> its bbox center.
  const homes: Record<string, [number, number]> = {};
  for (const [color, ws] of Object.entries(walls)) {
    if (ws.length < 8) continue;
    const rs = ws.map((w) => w[0]),
      cs = ws.map((w) => w[1]);
    homes[color] = [
      Math.floor((Math.min(...rs) + Math.max(...rs)) / 2),
      Math.floor((Math.min(...cs) + Math.max(...cs)) / 2),
    ];
  }

  return { grunts, towers, walls, houses, water, homes, grid };
}

export function renderAscii(board: Board): string {
  const g = Array.from({ length: ROWS }, () => Array<string>(COLS).fill("."));
  for (const [r, c] of board.water) g[r][c] = "~";
  for (const ws of Object.values(board.walls))
    for (const [r, c] of ws) g[r][c] = "#";
  for (const [r, c] of board.houses) g[r][c] = "H";
  for (const t of board.towers) {
    const ch = t.state === "alive" ? "A" : "x";
    for (const [dy, dx] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      if (t.r + dy < ROWS && t.c + dx < COLS) g[t.r + dy][t.c + dx] = ch;
    }
  }
  for (const [color, [r, c]] of Object.entries(board.homes))
    g[r][c] = color[0].toUpperCase();
  for (const gr of board.grunts) g[gr.r][gr.c] = DIR_CH[gr.dir];
  const head = "    " + Array.from({ length: COLS }, (_, c) => c % 10).join("");
  return (
    head +
    "\n" +
    g.map((row, r) => `${String(r).padStart(2)}  ${row.join("")}`).join("\n")
  );
}

async function decodeAny(
  path: string,
): Promise<{ px: Uint8Array; w: number; h: number }> {
  const probe = await new Deno.Command("ffprobe", {
    args: [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      path,
    ],
    stdout: "piped",
  }).output();
  const [w, h] = new TextDecoder()
    .decode(probe.stdout)
    .trim()
    .split(",")
    .map(Number);
  const out = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-i",
      path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    stdout: "piped",
  }).output();
  return { px: out.stdout, w, h };
}

function components(mask: boolean[][]): [number, number][][] {
  const seen = mask.map((row) => row.map(() => false));
  const comps: [number, number][][] = [];
  const nbrs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!mask[r][c] || seen[r][c]) continue;
      const cells: [number, number][] = [];
      const stack: [number, number][] = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop()!;
        cells.push([y, x]);
        for (const [dy, dx] of nbrs) {
          const ny = y + dy,
            nx = x + dx;
          if (
            ny >= 0 &&
            ny < ROWS &&
            nx >= 0 &&
            nx < COLS &&
            mask[ny][nx] &&
            !seen[ny][nx]
          ) {
            seen[ny][nx] = true;
            stack.push([ny, nx]);
          }
        }
      }
      comps.push(cells);
    }
  }
  return comps;
}
