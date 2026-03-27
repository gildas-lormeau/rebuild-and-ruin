/**
 * Import layer analysis — generate, visualize, and lint the module hierarchy.
 *
 * Parses every .ts file in src/, builds a directed dependency graph,
 * and computes the "natural" layer of each file:
 *   layer(f) = 0                              if f has no intra-project imports
 *   layer(f) = 1 + max(layer(dep) for dep)    otherwise
 *
 * The layer map is stored in .import-layers.json as an array of named groups.
 * Position in the array = layer number (0 = bottom, N = top). Each group has
 * a human-readable name and a list of files. Hand-edit this file to express
 * your intended architecture: rename groups, merge layers, move files between
 * groups. Then use --check to lint actual imports against your intent.
 *
 * Usage:
 *   npx tsx scripts/generate-import-layers.ts [options]
 *
 * Modes:
 *   (default)       Compute layers from import graph, write .import-layers.json
 *   --check         Lint: read .import-layers.json as intended layers,
 *                   report imports that go from a lower intended layer to a
 *                   higher one. Exit 1 if violations found.
 *
 * Options:
 *   --print         Print layer map to stdout without writing to disk
 *   --server        Include server/ files in the analysis
 */

import { Project } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const printOnly = args.includes("--print");
const includeServer = args.includes("--server");

const LAYER_FILE = ".import-layers.json";

// ---------------------------------------------------------------------------
// Layer file format
// ---------------------------------------------------------------------------

interface LayerGroup {
  name: string;
  files: string[];
}

// ---------------------------------------------------------------------------
// Parse imports — shared by both modes
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const globs = ["src/**/*.ts"];
if (includeServer) globs.push("server/**/*.ts");
for (const glob of globs) {
  project.addSourceFilesAtPaths(glob);
}

/** Normalize a file path to a short key like "src/types.ts" */
function fileKey(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Resolve a relative import specifier to a file key. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile);
  return fileKey(path.resolve(dir, specifier));
}

interface ImportEdge {
  from: string;
  to: string;
  typeOnly: boolean;
}

const allFiles = new Set<string>();
const edges: ImportEdge[] = [];
const edgesByFile = new Map<string, Set<string>>();

for (const sf of project.getSourceFiles()) {
  allFiles.add(fileKey(sf.getFilePath()));
}

for (const sf of project.getSourceFiles()) {
  const from = fileKey(sf.getFilePath());
  if (!edgesByFile.has(from)) edgesByFile.set(from, new Set());

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const to = resolveImport(sf.getFilePath(), spec);
    if (!to || !allFiles.has(to)) continue;
    edgesByFile.get(from)!.add(to);
    edges.push({ from, to, typeOnly: imp.isTypeOnly() });
  }

  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (!spec || !spec.startsWith(".")) continue;
    const to = resolveImport(sf.getFilePath(), spec);
    if (!to || !allFiles.has(to)) continue;
    edgesByFile.get(from)!.add(to);
    edges.push({ from, to, typeOnly: exp.isTypeOnly() });
  }
}

// ---------------------------------------------------------------------------
// Read layer file → file-to-layer map
// ---------------------------------------------------------------------------

function readLayerFile(): { groups: LayerGroup[]; fileToLayer: Map<string, number>; layerNames: Map<number, string> } {
  const raw = fs.readFileSync(LAYER_FILE, "utf-8");
  const groups: LayerGroup[] = JSON.parse(raw);

  const fileToLayer = new Map<string, number>();
  const layerNames = new Map<number, string>();

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    layerNames.set(i, g.name);
    for (const file of g.files) {
      fileToLayer.set(file, i);
    }
  }

  return { groups, fileToLayer, layerNames };
}

// ---------------------------------------------------------------------------
// --check mode: lint against intended layer map
// ---------------------------------------------------------------------------

if (checkMode) {
  if (!fs.existsSync(LAYER_FILE)) {
    console.error(`${LAYER_FILE} not found. Run without --check first to generate it.`);
    process.exit(1);
  }

  const { fileToLayer, layerNames } = readLayerFile();

  // Warn about files missing from the layer map
  const missing: string[] = [];
  for (const file of allFiles) {
    if (!fileToLayer.has(file)) missing.push(file);
  }
  if (missing.length > 0) {
    console.log(`\nWarning: ${missing.length} file(s) not in ${LAYER_FILE} (treated as layer 0):`);
    for (const f of missing.sort()) console.log(`  ${f}`);
  }

  // Collect violations: from_layer < to_layer means an upward import
  interface Violation {
    from: string;
    fromLayer: number;
    fromGroup: string;
    to: string;
    toLayer: number;
    toGroup: string;
    typeOnly: boolean;
  }
  const violations: Violation[] = [];

  for (const edge of edges) {
    const fromLayer = fileToLayer.get(edge.from) ?? 0;
    const toLayer = fileToLayer.get(edge.to) ?? 0;
    if (fromLayer < toLayer) {
      if (!violations.some(v => v.from === edge.from && v.to === edge.to)) {
        violations.push({
          from: edge.from,
          fromLayer,
          fromGroup: layerNames.get(fromLayer) ?? `layer ${fromLayer}`,
          to: edge.to,
          toLayer,
          toGroup: layerNames.get(toLayer) ?? `layer ${toLayer}`,
          typeOnly: edge.typeOnly,
        });
      }
    }
  }

  violations.sort((a, b) => a.fromLayer - b.fromLayer || a.from.localeCompare(b.from));

  if (violations.length === 0) {
    console.log(`\n✔ No layer violations (${allFiles.size} files, ${edges.length} imports checked)\n`);
    process.exit(0);
  }

  console.log(`\n✘ ${violations.length} layer violation(s) found:\n`);
  for (const v of violations) {
    const tag = v.typeOnly ? " (type-only)" : "";
    console.log(
      `  ${v.from} [${v.fromGroup}] → ${v.to} [${v.toGroup}]${tag}`,
    );
  }
  console.log("");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Default mode: compute layers from import graph
// ---------------------------------------------------------------------------

const layers = new Map<string, number>();
const visiting = new Set<string>();

function computeLayer(file: string): number {
  if (layers.has(file)) return layers.get(file)!;
  if (visiting.has(file)) return 0;

  visiting.add(file);
  const deps = edgesByFile.get(file);
  let maxDep = -1;
  if (deps) {
    for (const dep of deps) {
      if (allFiles.has(dep)) {
        maxDep = Math.max(maxDep, computeLayer(dep));
      }
    }
  }
  visiting.delete(file);

  const layer = maxDep + 1;
  layers.set(file, layer);
  return layer;
}

for (const file of allFiles) {
  computeLayer(file);
}

// Build groups sorted by layer then alphabetically
const groupMap = new Map<number, string[]>();
for (const [file, layer] of layers) {
  if (!groupMap.has(layer)) groupMap.set(layer, []);
  groupMap.get(layer)!.push(file);
}
for (const files of groupMap.values()) {
  files.sort();
}

const maxLayer = Math.max(...layers.values());
const pad = String(maxLayer).length;

// If a layer file already exists, preserve group names for layers that
// still exist at the same index
const existingNames = new Map<number, string>();
if (fs.existsSync(LAYER_FILE)) {
  try {
    const existing: LayerGroup[] = JSON.parse(fs.readFileSync(LAYER_FILE, "utf-8"));
    for (let i = 0; i < existing.length; i++) {
      existingNames.set(i, existing[i]!.name);
    }
  } catch { /* ignore parse errors */ }
}

const outputGroups: LayerGroup[] = [];
for (let l = 0; l <= maxLayer; l++) {
  const files = groupMap.get(l) ?? [];
  const name = existingNames.get(l) ?? `layer ${l}`;
  outputGroups.push({ name, files });
}

// Print
console.log(`\nImport layer map (${allFiles.size} files, ${maxLayer + 1} layers)\n`);
for (let l = 0; l <= maxLayer; l++) {
  const g = outputGroups[l]!;
  console.log(`  ${String(l).padStart(pad)}: ${g.name}  (${g.files.length} files)`);
  for (const f of g.files) {
    console.log(`      ${f}`);
  }
}

if (!printOnly) {
  const json = JSON.stringify(outputGroups, null, 2) + "\n";
  fs.writeFileSync(LAYER_FILE, json);
  console.log(`\nWritten to ${LAYER_FILE}`);
}

console.log("");
