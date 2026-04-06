/**
 * Comprehensive import/export audit — single-command health check.
 *
 * Checks:
 *   1. Duplicate export names (same symbol exported from multiple files)
 *   2. Unnecessary re-exports (export { X } from "...")
 *   3. Types imported from a higher layer than their canonical source
 *   4. Orphan .ts files not listed in .import-layers.json
 *   5. Phantom files listed in layers but missing from disk
 *
 * Usage:
 *   deno run -A scripts/audit-imports.ts          # report
 *   deno run -A scripts/audit-imports.ts --check  # exit 1 on issues
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

interface LayerGroup {
  name: string;
  files: string[];
}
interface ExportEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
}

const layers: LayerGroup[] = JSON.parse(
  readFileSync(".import-layers.json", "utf-8"),
);
const exports: ExportEntry[] = JSON.parse(
  readFileSync(".export-index.json", "utf-8"),
);
const check = process.argv.includes("--check");

// Build lookup tables
const fileLayer = new Map<string, { idx: number; name: string }>();
for (let i = 0; i < layers.length; i++) {
  const group = layers[i]!;
  for (const f of group.files) {
    fileLayer.set(f, { idx: i, name: group.name });
  }
}

const symbolSources = new Map<string, { file: string; layer: number }[]>();
for (const e of exports) {
  const layer = fileLayer.get(e.file)?.idx ?? 999;
  const list = symbolSources.get(e.name);
  if (list) list.push({ file: e.file, layer });
  else symbolSources.set(e.name, [{ file: e.file, layer }]);
}

function findTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? findTsFiles(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

let issues = 0;

function heading(title: string) {
  console.log(`\n${title}`);
}

// 1. Duplicate export names
heading("Duplicate export names");
const nameCounts = new Map<string, string[]>();
for (const e of exports) {
  const list = nameCounts.get(e.name);
  if (list) list.push(e.file);
  else nameCounts.set(e.name, [e.file]);
}
let dupeCount = 0;
for (const [name, files] of nameCounts) {
  if (files.length > 1) {
    console.log(`  ${name}: ${files.join(", ")}`);
    dupeCount++;
  }
}
if (dupeCount === 0) console.log("  ✔ none");
else issues += dupeCount;

// 2. Re-exports
heading("Re-exports (export { X } from ...)");
const reExportPattern = /^export\s+(?:type\s+)?\{[^}]*\}\s+from\s+"[^"]+"/;
let reExportCount = 0;
const allFiles = [...findTsFiles("src"), ...findTsFiles("server")];
for (const path of allFiles.sort()) {
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (reExportPattern.test(lines[i]!)) {
      console.log(`  ${path}:${i + 1}: ${lines[i]!.trim()}`);
      reExportCount++;
    }
  }
}
if (reExportCount === 0) console.log("  ✔ none");

// 3. Types imported from higher layer than canonical source
heading("Types from higher layer than necessary");
const typeImportPattern =
  /import\s*\{([^}]+)\}\s+from\s+"([^"]+)"/g;
const typeSpecPattern = /\btype\s+(\w+)/g;
let higherCount = 0;
for (const path of allFiles) {
  const content = readFileSync(path, "utf-8");
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
  for (const m of content.matchAll(typeImportPattern)) {
    const inner = m[1]!;
    const source = m[2]!;
    let resolved: string;
    if (source.startsWith("./")) resolved = `${dir}/${source.substring(2)}`;
    else if (source.startsWith("../")) resolved = source.substring(3);
    else continue;

    const srcLayer = fileLayer.get(resolved);
    if (!srcLayer) continue;

    for (const tm of inner.matchAll(typeSpecPattern)) {
      const name = tm[1]!;
      const sources = symbolSources.get(name);
      if (!sources) continue;
      const canonical = sources.reduce<{ file: string; layer: number } | null>(
        (best, s) => (!best || s.layer < best.layer ? s : best),
        null,
      );
      if (
        canonical &&
        canonical.layer < srcLayer.idx &&
        canonical.file !== resolved
      ) {
        const importerLayer = fileLayer.get(path);
        if (importerLayer && canonical.layer <= importerLayer.idx) {
          console.log(
            `  ${path}: '${name}' from ${resolved} (L${srcLayer.idx}:${srcLayer.name}) → canonical: ${canonical.file} (L${canonical.layer})`,
          );
          higherCount++;
        }
      }
    }
  }
}
if (higherCount === 0) console.log("  ✔ none");
else issues += higherCount;

// 4. Orphan files (on disk but not in layers)
heading("Orphan .ts files (not in layers)");
const layerFileSet = new Set<string>();
for (const g of layers) for (const f of g.files) layerFileSet.add(f);
const orphans = allFiles.filter((f) => !layerFileSet.has(f)).sort();
for (const f of orphans) console.log(`  ${f}`);
if (orphans.length === 0) console.log("  ✔ none");
else issues += orphans.length;

// 5. Phantom files (in layers but not on disk)
heading("Phantom files (in layers, not on disk)");
const phantoms = [...layerFileSet].filter((f) => !existsSync(f)).sort();
for (const f of phantoms) console.log(`  ${f}`);
if (phantoms.length === 0) console.log("  ✔ none");
else issues += phantoms.length;

// Summary
console.log("");
if (issues === 0 && reExportCount === 0) {
  console.log("✔ Import/export audit clean");
} else if (issues === 0) {
  console.log(
    `✔ Audit clean (${reExportCount} re-export(s) found — review if intentional)`,
  );
} else {
  console.log(`✘ ${issues} issue(s) found`);
  if (check) process.exit(1);
}
