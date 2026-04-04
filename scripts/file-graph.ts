/**
 * Render the full file-level import graph as a dot file.
 *
 * Each node = one source file, grouped by layer cluster.
 * Each edge = an import from one file to another (cross-layer only by default).
 *
 * Usage:
 *   npx tsx scripts/file-graph.ts                  # cross-layer edges only
 *   npx tsx scripts/file-graph.ts --lateral         # include same-layer edges
 *   npx tsx scripts/file-graph.ts --layout fdp      # set layout engine hint
 *   npx tsx scripts/file-graph.ts > file-graph.dot  # pipe to file
 *
 * Render:
 *   dot  -Tsvg file-graph.dot > file-graph.svg   # hierarchical (default)
 *   fdp  -Tsvg file-graph.dot > file-graph.svg   # force-directed
 *   sfdp -Tsvg file-graph.dot > file-graph.svg   # scalable force-directed
 */

import { Project } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const includeLateral = process.argv.includes("--lateral");

const layoutIdx = process.argv.indexOf("--layout");
const layout = layoutIdx !== -1 ? process.argv[layoutIdx + 1] ?? "dot" : "dot";

// ---------------------------------------------------------------------------
// Load layer definitions
// ---------------------------------------------------------------------------

type LayerDef = { name: string; files: string[] };
const layers: LayerDef[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".import-layers.json"), "utf8"),
);

const fileToLayer = new Map<string, number>();
for (let i = 0; i < layers.length; i++) {
  for (const f of layers[i]!.files) {
    fileToLayer.set(path.normalize(f), i);
  }
}

// ---------------------------------------------------------------------------
// Parse imports with ts-morph
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
});
project.addSourceFilesAtPaths(path.join(ROOT, "server/**/*.ts"));

interface FileEdge {
  from: string;
  to: string;
}

const edges: FileEdge[] = [];
const nodeIds = new Map<string, string>();
let counter = 0;

function nodeId(rel: string): string {
  if (!nodeIds.has(rel)) nodeIds.set(rel, "n" + counter++);
  return nodeIds.get(rel)!;
}

for (const sf of project.getSourceFiles()) {
  const abs = sf.getFilePath();
  const rel = path.normalize(path.relative(ROOT, abs));
  if (!fileToLayer.has(rel)) continue;

  for (const decl of sf.getImportDeclarations()) {
    const mod = decl.getModuleSpecifierSourceFile();
    if (!mod) continue;
    const depRel = path.normalize(path.relative(ROOT, mod.getFilePath()));
    if (!fileToLayer.has(depRel) || rel === depRel) continue;
    edges.push({ from: rel, to: depRel });
  }
}

// ---------------------------------------------------------------------------
// Emit dot
// ---------------------------------------------------------------------------

const COLORS = [
  "#e8f4f8", "#d4edda", "#fff3cd", "#f8d7da",
  "#e2d9f3", "#d1ecf1", "#fde8d8", "#e9ecef",
  "#c3e6cb", "#bee5eb", "#ffeeba", "#f5c6cb",
  "#d6d8db", "#b8daff", "#c6efce", "#e8f4f8",
  "#d4edda",
];

const lines: string[] = [];
lines.push("digraph files {");
lines.push(`  layout=${layout};`);
lines.push(
  '  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=9];',
);
lines.push('  edge [color="#88888844", arrowsize=0.5];');
lines.push("  newrank=true;");
lines.push("  compound=true;");
lines.push("");

// Clusters
for (let i = 0; i < layers.length; i++) {
  const color = COLORS[i % COLORS.length] ?? "#ffffff";
  lines.push(`  subgraph cluster_L${i} {`);
  lines.push(
    `    label="L${i} ${layers[i]!.name}"; style=filled; fillcolor="${color}80"; fontname="Helvetica"; fontsize=10;`,
  );
  for (const f of layers[i]!.files) {
    const rel = path.normalize(f);
    const label = path.basename(rel, ".ts");
    lines.push(
      `    ${nodeId(rel)} [label="${label}", fillcolor="${color}"];`,
    );
  }
  lines.push("  }");
}
lines.push("");

// Edges
for (const { from, to } of edges) {
  const fromLayer = fileToLayer.get(from)!;
  const toLayer = fileToLayer.get(to)!;
  if (!includeLateral && fromLayer === toLayer) continue;
  lines.push(`  ${nodeId(from)} -> ${nodeId(to)};`);
}

lines.push("}");
process.stdout.write(lines.join("\n") + "\n");
