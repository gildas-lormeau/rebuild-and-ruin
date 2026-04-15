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
 *   deno run -A scripts/generate-import-layers.ts [options]
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

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project } from "ts-morph";

interface LayerGroup {
  name: string;
  tier?: string;
  files: string[];
}

interface ImportEdge {
  from: string;
  to: string;
  typeOnly: boolean;
}

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const printOnly = args.includes("--print");
const includeServer = args.includes("--server");
const LAYER_FILE = ".import-layers.json";
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
const globs = ["src/**/*.ts"];
const allFiles = new Set<string>();
const edges: ImportEdge[] = [];
const edgesByFile = new Map<string, Set<string>>();
const layers = new Map<string, number>();
const visiting = new Set<string>();
// Build groups sorted by layer then alphabetically
const groupMap = new Map<number, string[]>();
const maxLayer = Math.max(...layers.values());
const pad = String(maxLayer).length;
// If a layer file already exists, preserve group names and tiers for layers
// that still exist at the same index
const existingNames = new Map<number, string>();
const existingTiers = new Map<number, string>();
const outputGroups: LayerGroup[] = [];

if (includeServer) globs.push("server/**/*.ts");

for (const glob of globs) {
  project.addSourceFilesAtPaths(glob);
}

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

  // Re-export edges (`export ... from "./foo.ts"`) are intentionally NOT
  // tracked as architectural dependencies. They are aliases/routing — the
  // real dependency runs from the consumer to the underlying source, not
  // consumer → barrel → source. Treating them as edges would force barrel
  // files to sit at the tier of their highest re-export source, which then
  // makes consumer-of-barrel imports look upward. The fix is to recognize
  // that re-exports belong to the file dependency graph (what TypeScript
  // needs at compile time), not to the architectural dependency graph.
}

/** Resolve a relative import specifier to a file key. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile);
  return fileKey(path.resolve(dir, specifier));
}

/** Normalize a file path to a short key like "src/types.ts" */
function fileKey(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, "/");
}

if (checkMode) {
  if (!fs.existsSync(LAYER_FILE)) {
    console.error(
      `${LAYER_FILE} not found. Run without --check first to generate it.`,
    );
    process.exit(1);
  }

  const { fileToLayer, layerNames, layerTiers } = readLayerFile();

  function tierTag(layer: number): string {
    const tier = layerTiers.get(layer);
    return tier ? ` (${tier})` : "";
  }

  // Files missing from the layer map — fail so new files can't ship unlayered.
  // Run without --check to regenerate and assign a layer based on the file's imports.
  const missing: string[] = [];
  for (const file of allFiles) {
    if (!fileToLayer.has(file)) missing.push(file);
  }
  if (missing.length > 0) {
    console.error(`\n✗ ${missing.length} file(s) not in ${LAYER_FILE}:`);
    for (const f of missing.sort()) console.error(`  ${f}`);
    console.error(
      `\nRun: deno run -A scripts/generate-import-layers.ts${includeServer ? " --server" : ""}`,
    );
    process.exit(1);
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
      if (!violations.some((v) => v.from === edge.from && v.to === edge.to)) {
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

  violations.sort(
    (a, b) => a.fromLayer - b.fromLayer || a.from.localeCompare(b.from),
  );

  if (violations.length === 0) {
    console.log(
      `\n✔ No layer violations (${allFiles.size} files, ${edges.length} imports checked)\n`,
    );
    process.exit(0);
  }

  console.log(`\n✘ ${violations.length} layer violation(s) found:\n`);
  for (const v of violations) {
    const tag = v.typeOnly ? " (type-only)" : "";
    const fromTier = tierTag(v.fromLayer);
    const toTier = tierTag(v.toLayer);
    console.log(
      `  ${v.from} [${v.fromGroup}${fromTier}] → ${v.to} [${v.toGroup}${toTier}]${tag}`,
    );
  }
  console.log("");
  process.exit(1);
}

function readLayerFile(): {
  groups: LayerGroup[];
  fileToLayer: Map<string, number>;
  layerNames: Map<number, string>;
  layerTiers: Map<number, string>;
} {
  const raw = fs.readFileSync(LAYER_FILE, "utf-8");
  const groups: LayerGroup[] = JSON.parse(raw);

  const fileToLayer = new Map<string, number>();
  const layerNames = new Map<number, string>();
  const layerTiers = new Map<number, string>();

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    layerNames.set(i, g.name);
    if (g.tier) layerTiers.set(i, g.tier);
    for (const file of g.files) {
      fileToLayer.set(file, i);
    }
  }

  return { groups, fileToLayer, layerNames, layerTiers };
}

for (const file of allFiles) {
  computeLayer(file);
}

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

for (const [file, layer] of layers) {
  if (!groupMap.has(layer)) groupMap.set(layer, []);
  groupMap.get(layer)!.push(file);
}

for (const files of groupMap.values()) {
  files.sort();
}

if (fs.existsSync(LAYER_FILE)) {
  try {
    const existing: LayerGroup[] = JSON.parse(
      fs.readFileSync(LAYER_FILE, "utf-8"),
    );
    for (let i = 0; i < existing.length; i++) {
      existingNames.set(i, existing[i]!.name);
      if (existing[i]!.tier) existingTiers.set(i, existing[i]!.tier!);
    }
  } catch {
    /* ignore parse errors */
  }
}

for (let l = 0; l <= maxLayer; l++) {
  const files = groupMap.get(l) ?? [];
  const name = existingNames.get(l) ?? `layer ${l}`;
  const tier = existingTiers.get(l);
  outputGroups.push(tier ? { name, tier, files } : { name, files });
}

// Print
console.log(
  `\nImport layer map (${allFiles.size} files, ${maxLayer + 1} layers)\n`,
);

for (let l = 0; l <= maxLayer; l++) {
  const g = outputGroups[l]!;
  const tierLabel = g.tier ? ` [${g.tier}]` : "";
  console.log(
    `  ${String(l).padStart(pad)}: ${g.name}${tierLabel}  (${g.files.length} files)`,
  );
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
