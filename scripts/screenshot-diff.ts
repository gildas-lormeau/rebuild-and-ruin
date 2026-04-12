/**
 * Visual diff tool for e2e banner screenshots.
 *
 * Compares two PNG images and outputs a diff image where:
 *   - Unchanged pixels are dimmed (25% opacity grayscale)
 *   - Changed pixels are highlighted in red (intensity = magnitude of change)
 *
 * Usage:
 *   deno run -A scripts/screenshot-diff.ts <imageA.png> <imageB.png> [output.png]
 *
 * If output is omitted, writes to <imageA>-diff.png next to the first image.
 *
 * Options:
 *   --threshold=N   Per-pixel RGB sum threshold (default: 30)
 *   --crop-top=F    Fraction of height to skip at top (default: 0)
 *   --crop-bottom=F Fraction of height to skip at bottom (default: 0)
 *   --dir=PATH      Compare all matching frame pairs in a banner folder:
 *                    1-previous vs 2-first, 4-last vs 5-next
 */

interface PngImage {
  width: number;
  height: number;
  /** RGBA pixel data, row-major, 4 bytes per pixel. */
  pixels: Uint8Array;
}

interface DiffOptions {
  threshold: number;
  cropTop: number;
  cropBottom: number;
}

interface DiffResult {
  diffPct: number;
  totalPixels: number;
  changedPixels: number;
  /** 6x4 grid fingerprint. Each cell is a char: . <1%, o 1-5%, O 5-15%, X >15%.
   *  Same visual pattern = same fingerprint = same root cause. */
  fingerprint: string;
}

const HELP = `
Usage:
  deno run -A scripts/screenshot-diff.ts <a.png> <b.png> [out.png]
  deno run -A scripts/screenshot-diff.ts --dir=tmp/screenshots/classic-s0/r1-prepare-for-battle/

Options:
  --threshold=N     Per-pixel RGB sum threshold (default: 30)
  --crop-top=F      Fraction to crop from top (default: 0)
  --crop-bottom=F   Fraction to crop from bottom (default: 0)
  --dir=PATH        Auto-diff start/end pairs in a banner screenshot folder
`.trim();

main();

async function main(): Promise<void> {
  const args = Deno.args;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    Deno.exit(0);
  }

  let threshold = 30;
  let cropTop = 0.15;
  let cropBottom = 0.15;
  let dirMode: string | null = null;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--threshold=")) {
      threshold = parseInt(arg.split("=")[1]!, 10);
    } else if (arg.startsWith("--crop-top=")) {
      cropTop = parseFloat(arg.split("=")[1]!);
    } else if (arg.startsWith("--crop-bottom=")) {
      cropBottom = parseFloat(arg.split("=")[1]!);
    } else if (arg.startsWith("--dir=")) {
      dirMode = arg.split("=").slice(1).join("=").replace(/\/$/, "");
    } else {
      positional.push(arg);
    }
  }

  const opts: DiffOptions = { threshold, cropTop, cropBottom };

  if (dirMode) {
    console.log(`Diffing banner folder: ${dirMode}/\n`);
    await diffDir(dirMode, opts);
    return;
  }

  if (positional.length < 2) {
    console.error("Need two image paths, or --dir=<folder>");
    Deno.exit(1);
  }

  const [pathA, pathB] = positional;
  const outPath = positional[2] ?? pathA!.replace(/\.png$/, "-diff.png");
  const result = await diffPair(pathA!, pathB!, outPath, opts);
  console.log(
    `${result.diffPct.toFixed(3)}% changed (${result.changedPixels}/${result.totalPixels} px)  [${result.fingerprint}] → ${outPath}`,
  );
}

async function diffDir(dir: string, opts: DiffOptions): Promise<void> {
  const pairs: [string, string, string, string][] = [
    [
      "1-previous.png",
      "2-first.png",
      "diff-start.png",
      "previous vs first (START)",
    ],
    ["4-last.png", "5-next.png", "diff-end.png", "last vs next (END)"],
  ];

  for (const [fileA, fileB, outFile, label] of pairs) {
    const pathA = `${dir}/${fileA}`;
    const pathB = `${dir}/${fileB}`;
    try {
      Deno.statSync(pathA);
      Deno.statSync(pathB);
    } catch {
      console.log(`  skip ${label}: missing ${fileA} or ${fileB}`);
      continue;
    }
    const outPath = `${dir}/${outFile}`;
    const result = await diffPair(pathA, pathB, outPath, opts);
    console.log(
      `  ${label}: ${result.diffPct.toFixed(3)}%  [${result.fingerprint}] → ${outPath}`,
    );
  }
}

async function diffPair(
  pathA: string,
  pathB: string,
  outPath: string,
  opts: DiffOptions,
): Promise<DiffResult> {
  const imgA = await decodePng(pathA);
  const imgB = await decodePng(pathB);
  const { result, diffImage } = computeDiff(imgA, imgB, opts);
  const encoded = await encodePng(diffImage);
  Deno.writeFileSync(outPath, encoded);
  return result;
}

async function decodePng(path: string): Promise<PngImage> {
  const fileData = Deno.readFileSync(path);
  // Verify PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let idx = 0; idx < 8; idx++) {
    if (fileData[idx] !== sig[idx]) throw new Error(`Not a PNG: ${path}`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];
  let offset = 8;

  while (offset < fileData.length) {
    const chunkLen = readU32(fileData, offset);
    const chunkType = new TextDecoder().decode(
      fileData.slice(offset + 4, offset + 8),
    );
    const chunkData = fileData.slice(offset + 8, offset + 8 + chunkLen);
    offset += 12 + chunkLen;

    if (chunkType === "IHDR") {
      width = readU32(chunkData, 0);
      height = readU32(chunkData, 4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(
      `Unsupported color type: ${colorType} (need RGB=2 or RGBA=6)`,
    );
  }

  const bpp = colorType === 6 ? 4 : 3;
  const totalIdat = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalIdat);
  let pos = 0;
  for (const chunk of idatChunks) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }

  // Decompress
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(merged);
  writer.close();
  const decompressed = await new Response(ds.readable).arrayBuffer();
  const raw = new Uint8Array(decompressed);

  // Unfilter
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * 4);

  function paethPredictor(
    left: number,
    above: number,
    upperLeft: number,
  ): number {
    const est = left + above - upperLeft;
    const distLeft = Math.abs(est - left);
    const distAbove = Math.abs(est - above);
    const distUpperLeft = Math.abs(est - upperLeft);
    if (distLeft <= distAbove && distLeft <= distUpperLeft) return left;
    if (distAbove <= distUpperLeft) return above;
    return upperLeft;
  }

  const prevRow = new Uint8Array(stride);
  const curRow = new Uint8Array(stride);
  let rawOff = 0;

  for (let row = 0; row < height; row++) {
    const filterType = raw[rawOff++]!;
    for (let col = 0; col < stride; col++) {
      const rawByte = raw[rawOff++]!;
      const left = col >= bpp ? curRow[col - bpp]! : 0;
      const above = prevRow[col]!;
      const upperLeft = col >= bpp ? prevRow[col - bpp]! : 0;
      let val: number;
      switch (filterType) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = (rawByte + left) & 0xff;
          break;
        case 2:
          val = (rawByte + above) & 0xff;
          break;
        case 3:
          val = (rawByte + ((left + above) >> 1)) & 0xff;
          break;
        case 4:
          val = (rawByte + paethPredictor(left, above, upperLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG filter: ${filterType}`);
      }
      curRow[col] = val;
    }

    const pixRow = row * width * 4;
    for (let col = 0; col < width; col++) {
      const srcOff = col * bpp;
      const dstOff = pixRow + col * 4;
      pixels[dstOff] = curRow[srcOff]!;
      pixels[dstOff + 1] = curRow[srcOff + 1]!;
      pixels[dstOff + 2] = curRow[srcOff + 2]!;
      pixels[dstOff + 3] = bpp === 4 ? curRow[srcOff + 3]! : 255;
    }
    prevRow.set(curRow);
  }

  return { width, height, pixels };
}

function readU32(data: Uint8Array, off: number): number {
  return (
    ((data[off]! << 24) |
      (data[off + 1]! << 16) |
      (data[off + 2]! << 8) |
      data[off + 3]!) >>>
    0
  );
}

async function encodePng(img: PngImage): Promise<Uint8Array> {
  const { width, height, pixels } = img;

  // Build raw scanlines with filter type 0 (none)
  const rawLen = height * (1 + width * 4);
  const raw = new Uint8Array(rawLen);
  let off = 0;
  for (let row = 0; row < height; row++) {
    raw[off++] = 0; // filter: none
    const rowOff = row * width * 4;
    for (let col = 0; col < width * 4; col++) {
      raw[off++] = pixels[rowOff + col]!;
    }
  }

  // Compress
  const cs = new CompressionStream("deflate");
  const csWriter = cs.writable.getWriter();
  csWriter.write(raw);
  csWriter.close();
  const compressed = new Uint8Array(
    await new Response(cs.readable).arrayBuffer(),
  );

  // Build PNG
  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(12 + data.length);
    writeU32(chunk, 0, data.length);
    const typeBytes = new TextEncoder().encode(type);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcBuf = new Uint8Array(4 + data.length);
    crcBuf.set(typeBytes, 0);
    crcBuf.set(data, 4);
    writeU32(chunk, 8 + data.length, crc32(crcBuf));
    return chunk;
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let pos = 0;
  result.set(signature, pos);
  pos += signature.length;
  result.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  result.set(idatChunk, pos);
  pos += idatChunk.length;
  result.set(iendChunk, pos);
  return result;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let idx = 0; idx < buf.length; idx++) {
    crc ^= buf[idx]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32(data: Uint8Array, off: number, val: number): void {
  data[off] = (val >>> 24) & 0xff;
  data[off + 1] = (val >>> 16) & 0xff;
  data[off + 2] = (val >>> 8) & 0xff;
  data[off + 3] = val & 0xff;
}

function computeDiff(
  imgA: PngImage,
  imgB: PngImage,
  opts: DiffOptions,
): { result: DiffResult; diffImage: PngImage } {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error(
      `Size mismatch: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
    );
  }

  const { width, height } = imgA;
  const yStart = Math.round(height * opts.cropTop);
  const yEnd = Math.round(height * (1 - opts.cropBottom));
  const out = new Uint8Array(width * height * 4);
  let changed = 0;
  let total = 0;

  // Grid fingerprint: 6 cols x 4 rows over the comparison region.
  const GRID_COLS = 6;
  const GRID_ROWS = 4;
  const gridChanged = new Uint32Array(GRID_COLS * GRID_ROWS);
  const gridTotal = new Uint32Array(GRID_COLS * GRID_ROWS);
  const regionH = yEnd - yStart;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = (row * width + col) * 4;
      const rA = imgA.pixels[idx]!;
      const gA = imgA.pixels[idx + 1]!;
      const bA = imgA.pixels[idx + 2]!;
      const rB = imgB.pixels[idx]!;
      const gB = imgB.pixels[idx + 1]!;
      const bB = imgB.pixels[idx + 2]!;

      const inRegion = row >= yStart && row < yEnd;
      const dr = Math.abs(rA - rB);
      const dg = Math.abs(gA - gB);
      const db = Math.abs(bA - bB);
      const delta = dr + dg + db;
      const isChanged = delta > opts.threshold;

      if (inRegion) {
        total++;
        if (isChanged) changed++;
        // Accumulate into grid cell.
        const gr = Math.min(
          GRID_ROWS - 1,
          Math.floor(((row - yStart) / regionH) * GRID_ROWS),
        );
        const gc = Math.min(
          GRID_COLS - 1,
          Math.floor((col / width) * GRID_COLS),
        );
        const gi = gr * GRID_COLS + gc;
        gridTotal[gi]++;
        if (isChanged) gridChanged[gi]++;
      }

      if (!inRegion) {
        // Cropped region: dark blue tint
        out[idx] = Math.round(rA * 0.15);
        out[idx + 1] = Math.round(gA * 0.15);
        out[idx + 2] = Math.round(Math.min(255, bA * 0.3 + 40));
        out[idx + 3] = 255;
      } else if (isChanged) {
        // Changed pixel: red, intensity proportional to delta
        const intensity = Math.min(255, Math.round((delta / 765) * 255 * 3));
        out[idx] = Math.max(intensity, 80);
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 255;
      } else {
        // Unchanged: dimmed grayscale of image A
        const gray = Math.round((rA * 0.299 + gA * 0.587 + bA * 0.114) * 0.3);
        out[idx] = gray;
        out[idx + 1] = gray;
        out[idx + 2] = gray;
        out[idx + 3] = 255;
      }
    }
  }

  // Build fingerprint: . <1%, o 1-5%, O 5-15%, X >15%
  let fingerprint = "";
  for (let gr = 0; gr < GRID_ROWS; gr++) {
    for (let gc = 0; gc < GRID_COLS; gc++) {
      const gi = gr * GRID_COLS + gc;
      const cellPct =
        gridTotal[gi]! > 0 ? (gridChanged[gi]! / gridTotal[gi]!) * 100 : 0;
      if (cellPct < 1) fingerprint += ".";
      else if (cellPct < 5) fingerprint += "o";
      else if (cellPct < 15) fingerprint += "O";
      else fingerprint += "X";
    }
    if (gr < GRID_ROWS - 1) fingerprint += "|";
  }

  return {
    result: {
      diffPct: total > 0 ? (changed / total) * 100 : 0,
      totalPixels: total,
      changedPixels: changed,
      fingerprint,
    },
    diffImage: { width, height, pixels: out },
  };
}
