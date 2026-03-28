/**
 * Render the import-layer architecture as a collapsed dot graph.
 *
 * Each node = one layer from .import-layers.json
 * Each edge = at least one file in layer A imports a file in layer B
 *
 * Usage:
 *   npx tsx scripts/layer-graph.ts | dot -T svg > layer-graph.svg
 *   npx tsx scripts/layer-graph.ts --server | dot -T svg > layer-graph.svg
 *
 * Requires Graphviz: brew install graphviz
 */

import { Project } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const includeServer = process.argv.includes("--server");

// ---------------------------------------------------------------------------
// Load layer definitions
// ---------------------------------------------------------------------------

type LayerDef = { name: string; files: string[] };
const layers: LayerDef[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".import-layers.json"), "utf8"),
);

// Map normalised file path → layer index
const fileToLayer = new Map<string, number>();
for (let i = 0; i < layers.length; i++) {
  for (const f of layers[i]!.files) {
    fileToLayer.set(path.normalize(f), i);
  }
}

// ---------------------------------------------------------------------------
// Parse imports with ts-morph
// ---------------------------------------------------------------------------

const project = new Project({ tsConfigFilePath: path.join(ROOT, "tsconfig.json") });
if (includeServer) {
  project.addSourceFilesAtPaths(path.join(ROOT, "server/**/*.ts"));
}

// layer A → Set of layer B indices it imports
const edges = new Map<number, Set<number>>();
for (let i = 0; i < layers.length; i++) edges.set(i, new Set());

for (const sf of project.getSourceFiles()) {
  const abs = sf.getFilePath();
  const rel = path.normalize(path.relative(ROOT, abs));
  const srcLayer = fileToLayer.get(rel);
  if (srcLayer === undefined) continue;

  for (const decl of sf.getImportDeclarations()) {
    const mod = decl.getModuleSpecifierSourceFile();
    if (!mod) continue;
    const depRel = path.normalize(path.relative(ROOT, mod.getFilePath()));
    const depLayer = fileToLayer.get(depRel);
    if (depLayer === undefined || depLayer === srcLayer) continue;
    edges.get(srcLayer)!.add(depLayer);
  }
}

// ---------------------------------------------------------------------------
// Emit dot
// ---------------------------------------------------------------------------

const COLORS = [
  "#e8f4f8", "#d4edda", "#fff3cd", "#f8d7da",
  "#e2d9f3", "#d1ecf1", "#fde8d8", "#e9ecef",
  "#c3e6cb", "#bee5eb", "#ffeeba", "#f5c6cb",
  "#d6d8db", "#b8daff", "#c6efce",
];

const lines: string[] = [];
lines.push("digraph layers {");
lines.push('  rankdir=TB;');
lines.push('  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=11];');
lines.push('  edge [color="#555555"];');
lines.push('  splines=ortho;');
lines.push("");

// Nodes
for (let i = 0; i < layers.length; i++) {
  const color = COLORS[i % COLORS.length] ?? "#ffffff";
  const label = `${layers[i]!.name}\\n(${layers[i]!.files.length} files)`;
  lines.push(`  L${i} [label="${label}", fillcolor="${color}"];`);
}
lines.push("");

// Edges (skip upward arrows — they are violations, shown by the linter)
for (const [from, tos] of edges) {
  for (const to of tos) {
    if (to < from) {
      // downward (normal) — solid
      lines.push(`  L${from} -> L${to};`);
    } else {
      // upward (violation) — red dashed
      lines.push(`  L${from} -> L${to} [color=red, style=dashed, penwidth=2];`);
    }
  }
}

lines.push("}");
process.stdout.write(lines.join("\n") + "\n");
