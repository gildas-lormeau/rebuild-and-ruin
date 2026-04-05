/**
 * Generate a compact export map for LLM agents.
 *
 * Reads .export-index.json and .import-layers.json, emits .export-map.txt
 * grouped by layer → file, one line per file with all exported symbols.
 *
 * Format:
 *   ## L0 — leaf modules
 *   src/shared/grid.ts: GRID_COLS, GRID_ROWS, TILE_SIZE, Tile (enum)
 *   src/shared/rng.ts: Rng (class), createSeededRng
 *
 * Agents scan this to spot misplaced exports (e.g. "RGB" in geometry-types).
 * Use .export-index.json for full signatures/docs.
 *
 * Usage: npx tsx scripts/generate-export-map.ts [--print]
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname!, "..");
const INDEX_PATH = path.join(ROOT, ".export-index.json");
const LAYERS_PATH = path.join(ROOT, ".import-layers.json");
const OUTPUT_PATH = path.join(ROOT, ".export-map.txt");

interface ExportEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
}

interface LayerGroup {
  name: string;
  files: string[];
}

const index: ExportEntry[] = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
const layers: LayerGroup[] = JSON.parse(
  fs.readFileSync(LAYERS_PATH, "utf-8"),
);

// Build file → exports map
const byFile = new Map<string, ExportEntry[]>();
for (const entry of index) {
  const list = byFile.get(entry.file) ?? [];
  list.push(entry);
  byFile.set(entry.file, list);
}

// Kinds that are always tagged (less obvious than function/const)
const TAG_KINDS = new Set(["type", "interface", "enum", "class"]);

function formatExport(ex: ExportEntry): string {
  return TAG_KINDS.has(ex.kind) ? `${ex.name} (${ex.kind})` : ex.name;
}

const lines: string[] = [];

// Emit layer groups
const layerFiles = new Set<string>();
for (let li = 0; li < layers.length; li++) {
  const layer = layers[li]!;
  lines.push(`## L${li} — ${layer.name}`);
  for (const file of layer.files) {
    layerFiles.add(file);
    const exports = byFile.get(file);
    if (!exports || exports.length === 0) {
      lines.push(`${file}: (no exports)`);
      continue;
    }
    exports.sort((a, b) => a.line - b.line);
    const symbols = exports.map(formatExport).join(", ");
    lines.push(`${file}: ${symbols}`);
  }
  lines.push("");
}

// Unlayered files (if any)
const unlayered: string[] = [];
for (const [file, exports] of byFile) {
  if (layerFiles.has(file)) continue;
  exports.sort((a, b) => a.line - b.line);
  const symbols = exports.map(formatExport).join(", ");
  unlayered.push(`${file}: ${symbols}`);
}
if (unlayered.length > 0) {
  lines.push("## unlayered");
  lines.push(...unlayered);
  lines.push("");
}

const output = lines.join("\n");

if (process.argv.includes("--print")) {
  console.log(output);
} else {
  fs.writeFileSync(OUTPUT_PATH, output);
  const fileCount = byFile.size;
  const symbolCount = index.length;
  console.log(
    `Export map: ${symbolCount} symbols across ${fileCount} files → ${OUTPUT_PATH}`,
  );
}
