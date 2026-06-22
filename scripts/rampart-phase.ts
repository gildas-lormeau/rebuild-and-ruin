/**
 * Rampart frame phase classifier (Deno port of the reference classifier).
 *
 * Classifies a single emulated-framebuffer frame (640x400, as written by
 * DOSBox-X's own raw screenshot / AVI recording — the game framebuffer only,
 * never the host screen) into one of:
 *   BUILD2D    - top-down build/cannon phase (the only analyzable phase)
 *   BATTLE_3D  - 3D isometric battle render (ignore)
 *   TRANSITION - generic banner overlay between phases (ignore)
 *   SCORE      - any between-round UI panel over the still-visible board: the
 *                red/blue/orange "TERRITORY PTS" score tally OR an "X ARMY
 *                DEFEATED" panel (ignore). Detected by any one pure UI fill in
 *                panel quantity (so 1- or 2-player screens still count).
 *   BANNER     - an announcement banner (e.g. "PLACE CANNONS", "RED ARMY
 *                DEFEATED") whose brick texture forms a full-width grey row. The
 *                banner slides vertically, so the bar can sit anywhere on screen.
 *   GAME_OVER  - "executioner" end illustration
 *   MENU       - title / "choose an action" screen
 *   HISCORE    - high-score entry screen (idle park state)
 *
 * SCORE and BANNER both keep the board partly visible, so they have a high
 * flat-palette fraction and were previously mislabeled BUILD2D — which polluted
 * the recon datasets (score frames sit at the tail of each build episode). They
 * are detected positively, before the flat/checker fallback.
 *
 * Thresholds are the calibrated constants from the reference classifier. Pixel
 * input is RGB (3 bytes/pixel, row-major). The CLI decodes an image file to raw
 * RGB via ffmpeg (a standard tool), so there is no image-decode dependency and
 * nothing ever reads the host screen.
 *
 * Usage:
 *   deno run -A scripts/rampart-phase.ts <frame.png>   # prints the phase name
 */

export type Phase =
  | "BUILD2D"
  | "BATTLE_3D"
  | "TRANSITION"
  | "SCORE"
  | "BANNER"
  | "GAME_OVER"
  | "MENU"
  | "HISCORE";

type Pred = (r: number, g: number, b: number) => boolean;

// Grass + player-territory palette, encoded (B<<16)|(G<<8)|R to match the
// reference constants (which were sampled from BGR frames). FLAT = black + grass
// greens + the three territory fills; CHECKER = the battle-checkerboard subset.
const FLAT = new Set([
  0x000000, 0x008600, 0x007100, 0x006900, 0x6d0000, 0x0045be, 0x00009a,
]);
const CHECKER = new Set([0x000000, 0x6d0000, 0x0045be, 0x00009a]);
// Between-round UI panels (score tallies AND "X ARMY DEFEATED" panels) use these
// pure fills: red #eb0000, blue #2c2cff, orange #ff8200, matched with a tolerance
// band so dim fade frames aren't missed. They are well clear of the darker board
// territory fills (red 154,0,0 / orange 190,69,0 / blue 0,0,109). Only ONE fill
// needs to be present in panel quantity — a score screen with 1 or 2 surviving
// players, or a single-colour defeat panel, still counts. A genuine build frame
// peaks at ~2548 of any one fill; a panel is >=7000, so >5000 is a clean cutoff.
const isScoreRed = (r: number, g: number, b: number) =>
  r > 200 && g < 45 && b < 45;
const isScoreBlue = (r: number, g: number, b: number) =>
  b > 210 && r < 90 && g < 90;
const isScoreOrange = (r: number, g: number, b: number) =>
  r > 210 && g > 95 && g < 170 && b < 45;
const SCORE_MIN = 5000;
// A banner panel is a brick texture of mixed NEUTRAL greys (#282828 mortar,
// #6d6d6d, #828282) that spans the full width. The banner animates vertically, so
// its brick bar can sit anywhere (top, middle, bottom) — we look for the widest
// brick row. A banner row is 0.83-0.91 brick; a real build/score frame peaks at
// ~0.06 (grass, scattered houses, and blue-grey castle walls which are NOT
// neutral). Pure black (dead towers) is excluded by the lower band floor.
const isBrick = (r: number, g: number, b: number) =>
  Math.abs(r - g) <= 14 &&
  Math.abs(g - b) <= 14 &&
  Math.abs(r - b) <= 14 &&
  ((r >= 28 && r <= 52) || (r >= 97 && r <= 142));
const BANNER_ROW_FRAC = 0.5;
export const FRAME_W = 640;
export const FRAME_H = 400;

export function analyzable(
  px: Uint8Array,
  width?: number,
  height?: number,
  ch?: number,
): boolean {
  return classify(px, width, height, ch) === "BUILD2D";
}

export function ended(
  px: Uint8Array,
  width?: number,
  height?: number,
  ch?: number,
): boolean {
  const phase = classify(px, width, height, ch);
  return phase === "GAME_OVER" || phase === "MENU" || phase === "HISCORE";
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error("usage: deno run -A scripts/rampart-phase.ts <frame.png>");
    Deno.exit(2);
  }
  const { px, width, height } = await decodeRGB(path);
  console.log(classify(px, width, height));
}

export function classify(
  px: Uint8Array,
  width = FRAME_W,
  height = FRAME_H,
  ch = 3,
): Phase {
  // End / not-in-match screens first: they have a low flat-palette fraction and
  // would otherwise be mislabeled BATTLE_3D.
  // GAME_OVER: top-right block (rows 80..96, cols 550..566) is light sky-blue.
  if (
    fracInRegion(
      px,
      ch,
      width,
      550,
      80,
      16,
      16,
      (r, g, b) => b > 150 && g > 150 && b >= g - 10 && r < g - 20,
    ) >= 0.5
  )
    return "GAME_OVER";
  // MENU: blue-brick top-right corner AND a mostly-blue frame.
  if (
    topRightBlue(px, ch, width) > 5 &&
    fracWhole(px, ch, (r, g, b) => b > g + 15 && b > r + 25) > 0.3
  )
    return "MENU";
  // HISCORE: predominantly stone-gray.
  if (
    fracWhole(
      px,
      ch,
      (r, g, b) =>
        Math.abs(r - g) < 14 &&
        Math.abs(g - b) < 14 &&
        Math.abs(r - b) < 14 &&
        g > 50 &&
        g < 180,
    ) >= 0.6
  )
    return "HISCORE";

  // SCORE: the three score-panel fills present together over the still-visible
  // board (would otherwise pass as BUILD2D). Checked before the flat/checker
  // fallback because the board keeps the flat fraction high.
  const [sr, sb, so] = scoreCounts(px, ch);
  if (sr > SCORE_MIN || sb > SCORE_MIN || so > SCORE_MIN) return "SCORE";
  // BANNER: an announcement panel whose brick texture forms a full-width grey row
  // (anywhere vertically, since the banner slides in/out).
  if (maxBrickRow(px, ch, width, height) > BANNER_ROW_FRAC) return "BANNER";

  // In-match: flat-palette fraction (a 3D battle render has few flat pixels),
  // then checker count (transitions don't show the full checkerboard).
  let flat = 0;
  let chk = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const enc = (px[o + 2] << 16) | (px[o + 1] << 8) | px[o]; // (B<<16)|(G<<8)|R
    if (FLAT.has(enc)) flat++;
    if (CHECKER.has(enc)) chk++;
  }
  if (flat / n < 0.45) return "BATTLE_3D";
  if (chk < 14000) return "TRANSITION";
  return "BUILD2D";
}

/** Decode an image file to raw RGB24 bytes via ffmpeg (a standard tool). */
export async function decodeRGB(
  path: string,
): Promise<{ px: Uint8Array; width: number; height: number }> {
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
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `ffmpeg decode failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const expected = FRAME_W * FRAME_H * 3;
  if (out.stdout.length !== expected) {
    throw new Error(
      `unexpected frame size ${out.stdout.length} bytes (expected ${expected} for ${FRAME_W}x${FRAME_H})`,
    );
  }
  return { px: out.stdout, width: FRAME_W, height: FRAME_H };
}

// Count the three score-panel fills over the whole frame.
function scoreCounts(px: Uint8Array, ch: number): [number, number, number] {
  let red = 0;
  let blue = 0;
  let orange = 0;
  const n = Math.floor(px.length / ch);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const r = px[o];
    const g = px[o + 1];
    const b = px[o + 2];
    if (isScoreRed(r, g, b)) red++;
    else if (isScoreBlue(r, g, b)) blue++;
    else if (isScoreOrange(r, g, b)) orange++;
  }
  return [red, blue, orange];
}

// Widest brick row as a fraction of the frame width: a banner forms a full-width
// brick bar (the bar can sit anywhere vertically while the banner slides).
function maxBrickRow(
  px: Uint8Array,
  ch: number,
  width: number,
  height: number,
): number {
  let best = 0;
  for (let y = 0; y < height; y++) {
    let count = 0;
    const base = y * width * ch;
    for (let x = 0; x < width; x++) {
      const o = base + x * ch;
      if (isBrick(px[o], px[o + 1], px[o + 2])) count++;
    }
    if (count > best) best = count;
  }
  return best / width;
}

function fracInRegion(
  px: Uint8Array,
  ch: number,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  pred: Pred,
): number {
  let hit = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * width + x) * ch;
      if (pred(px[o], px[o + 1], px[o + 2])) hit++;
    }
  }
  return hit / (w * h);
}

function fracWhole(px: Uint8Array, ch: number, pred: Pred): number {
  const n = Math.floor(px.length / ch);
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (pred(px[o], px[o + 1], px[o + 2])) hit++;
  }
  return hit / n;
}

// Blue-dominance of the top-right corner (the menu is blue brick):
// mean(B) - max(mean(G), mean(R)) over rows 8..48, cols 552..632.
function topRightBlue(px: Uint8Array, ch: number, width: number): number {
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (let y = 8; y < 48; y++) {
    for (let x = 552; x < 632; x++) {
      const o = (y * width + x) * ch;
      sr += px[o];
      sg += px[o + 1];
      sb += px[o + 2];
      n++;
    }
  }
  return sb / n - Math.max(sg / n, sr / n);
}
