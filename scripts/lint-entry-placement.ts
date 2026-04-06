/**
 * Entry-point placement lint — verify files in the top layer group are true
 * entry points, not orchestration modules that belong in a lower layer.
 *
 * A file in the top layer is flagged if its maximum dependency layer is more
 * than MAX_GAP levels below the top layer. This catches files that were
 * classified too high and should be reclassified to a lower group.
 *
 * Usage:
 *   deno run -A scripts/lint-entry-placement.ts
 */

import { Project } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max allowed gap between a file's assigned layer and its computed minimum. */
const MAX_GAP = 2;

const LAYER_FILE = ".import-layers.json";

/** Files that use dynamic imports for code splitting — static deps understate their true layer. */
const DYNAMIC_ENTRY_POINTS = new Set(["src/entry.ts"]);

// ---------------------------------------------------------------------------
// Load layer definitions
// ---------------------------------------------------------------------------

interface LayerGroup {
  name: string;
  files: string[];
}

const groups: LayerGroup[] = JSON.parse(fs.readFileSync(LAYER_FILE, "utf-8"));
const topLayer = groups.length - 1;
const topGroup = groups[topLayer]!;

const fileToLayer = new Map<string, number>();
for (let i = 0; i < groups.length; i++) {
  for (const file of groups[i]!.files) {
    fileToLayer.set(file, i);
  }
}

// ---------------------------------------------------------------------------
// Parse imports
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

project.addSourceFilesAtPaths("src/**/*.ts");
project.addSourceFilesAtPaths("server/**/*.ts");

const allFiles = new Set<string>();
const edgesByFile = new Map<string, Set<string>>();

function fileKey(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, "/");
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile);
  return fileKey(path.resolve(dir, specifier));
}

for (const sf of project.getSourceFiles()) {
  allFiles.add(fileKey(sf.getFilePath()));
}

for (const sf of project.getSourceFiles()) {
  const key = fileKey(sf.getFilePath());
  if (!edgesByFile.has(key)) edgesByFile.set(key, new Set());

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const to = resolveImport(sf.getFilePath(), spec);
    if (to && allFiles.has(to)) edgesByFile.get(key)!.add(to);
  }

  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (!spec || !spec.startsWith(".")) continue;
    const to = resolveImport(sf.getFilePath(), spec);
    if (to && allFiles.has(to)) edgesByFile.get(key)!.add(to);
  }
}

// ---------------------------------------------------------------------------
// Check each file in the top layer
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  maxDepLayer: number;
  maxDepGroup: string;
  gap: number;
}

const violations: Violation[] = [];

for (const file of topGroup.files) {
  if (DYNAMIC_ENTRY_POINTS.has(file)) continue; // uses dynamic imports for code splitting
  const deps = edgesByFile.get(file);
  if (!deps || deps.size === 0) continue; // leaf entry point (e.g., barrel re-export) is fine

  let maxDepLayer = 0;
  for (const dep of deps) {
    const depLayer = fileToLayer.get(dep);
    if (depLayer !== undefined && depLayer > maxDepLayer) {
      maxDepLayer = depLayer;
    }
  }

  // A file's minimum viable layer = maxDepLayer + 1 (needs to be above its deps).
  // But within-group imports are allowed, so if maxDepLayer == topLayer, that's fine.
  // We only flag when the file could sit much lower.
  if (maxDepLayer === topLayer) continue; // imports from peers in the same top group

  const minViableLayer = maxDepLayer + 1;
  const gap = topLayer - minViableLayer;

  if (gap > MAX_GAP) {
    violations.push({
      file,
      maxDepLayer,
      maxDepGroup: groups[maxDepLayer]?.name ?? `layer ${maxDepLayer}`,
      gap,
    });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (violations.length === 0) {
  console.log(
    `\n\u2714 No entry-point placement issues (${topGroup.files.length} files in "${topGroup.name}" checked)\n`,
  );
  process.exit(0);
}

console.log(
  `\n\u2718 ${violations.length} entry-point placement issue(s) found:\n`,
);
for (const v of violations) {
  console.log(
    `  ${v.file} — max dep is ${v.maxDepGroup} (L${v.maxDepLayer}), gap of ${v.gap} layers`,
  );
  console.log(
    `    → consider reclassifying to L${v.maxDepLayer + 1} or lower`,
  );
}
console.log("");
process.exit(1);
