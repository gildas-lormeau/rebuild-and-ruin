/**
 * Render the global domain-level dep graph.
 *
 * One node per domain (shared, protocol, game, ai, controllers, input,
 * render, online, runtime, server, entry), one edge per (from → to)
 * pair where the file-to-file edge count > 0. Edge label is the count;
 * edges that are fully dynamic-import are dashed.
 *
 * Usage:
 *   deno run -A scripts/domain-graph.ts                       # emit dot
 *   deno run -A scripts/domain-graph.ts --matrix              # also print matrix to stderr
 *   deno run -A scripts/domain-graph.ts > domain-graph.dot
 *
 * Render:
 *   dot -Tsvg domain-graph.dot > domain-graph.svg
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project, SyntaxKind } from "ts-morph";

interface LayerDef {
  name: string;
  files: string[];
}

interface PairStat {
  static: number;
  dynamic: number;
}

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const DOMAIN_COLORS: Record<string, string> = {
  entry: "#e0e0e0",
  shared: "#d4edda",
  protocol: "#fff3cd",
  game: "#bee5eb",
  ai: "#ffadad",
  controllers: "#ffe066",
  input: "#c3e6cb",
  render: "#b8daff",
  runtime: "#e2d9f3",
  online: "#fde8d8",
  server: "#f5c6cb",
};

main();

function main(): void {
  const includeMatrix = process.argv.includes("--matrix");

  const layers: LayerDef[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".import-layers.json"), "utf8"),
  );
  const fileSet = new Set<string>();
  for (const group of layers) {
    for (const f of group.files) fileSet.add(path.normalize(f));
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  });
  project.addSourceFilesAtPaths(path.join(ROOT, "server/**/*.ts"));

  const pairStats = new Map<string, PairStat>();
  const fileCount = new Map<string, number>();

  for (const sf of project.getSourceFiles()) {
    const rel = path.normalize(path.relative(ROOT, sf.getFilePath()));
    if (!fileSet.has(rel)) continue;
    const fromDom = domainOf(rel);
    if (!fromDom) continue;
    fileCount.set(fromDom, (fileCount.get(fromDom) ?? 0) + 1);

    for (const decl of sf.getImportDeclarations()) {
      const mod = decl.getModuleSpecifierSourceFile();
      if (!mod) continue;
      const depRel = path.normalize(path.relative(ROOT, mod.getFilePath()));
      if (!fileSet.has(depRel)) continue;
      const toDom = domainOf(depRel);
      if (!toDom || toDom === fromDom) continue;
      bumpPair(pairStats, fromDom, toDom, "static");
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const first = call.getArguments()[0];
      if (!first || first.getKind() !== SyntaxKind.StringLiteral) continue;
      const spec = first.getText().slice(1, -1);
      if (!spec.startsWith(".")) continue;
      let resolved = path.normalize(path.join(path.dirname(rel), spec));
      if (!resolved.endsWith(".ts")) resolved += ".ts";
      if (!fileSet.has(resolved)) continue;
      const toDom = domainOf(resolved);
      if (!toDom || toDom === fromDom) continue;
      bumpPair(pairStats, fromDom, toDom, "dynamic");
    }
  }

  const domains = [...fileCount.keys()].sort();
  emitDot(domains, fileCount, pairStats);
  if (includeMatrix) emitMatrix(domains, pairStats);
}

function emitDot(
  domains: string[],
  fileCount: Map<string, number>,
  pairStats: Map<string, PairStat>,
): void {
  const lines: string[] = [
    "digraph domains {",
    "  rankdir=TB;",
    "  splines=true;",
    "  nodesep=0.6;",
    "  ranksep=0.8;",
    '  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=11];',
    '  edge [fontname="Helvetica", fontsize=9, color="#666"];',
  ];

  for (const dom of domains) {
    const color = DOMAIN_COLORS[dom] ?? "#ffffff";
    const count = fileCount.get(dom)!;
    lines.push(
      `  "${dom}" [label="${dom}\\n${count} files", fillcolor="${color}"];`,
    );
  }

  for (const [key, stats] of [...pairStats.entries()].sort()) {
    const [from, to] = key.split("::") as [string, string];
    const total = stats.static + stats.dynamic;
    const allDynamic = stats.static === 0 && stats.dynamic > 0;
    const someDynamic = stats.dynamic > 0 && stats.static > 0;
    const label = allDynamic
      ? `${total} (dyn)`
      : someDynamic
        ? `${total} (${stats.dynamic} dyn)`
        : String(total);
    const penwidth = Math.min(0.5 + Math.log2(total + 1) * 0.6, 4).toFixed(1);
    const style = allDynamic ? "dashed" : "solid";
    lines.push(
      `  "${from}" -> "${to}" [label="${label}", penwidth=${penwidth}, style=${style}];`,
    );
  }

  lines.push("}");
  process.stdout.write(lines.join("\n") + "\n");
}

function emitMatrix(domains: string[], pairStats: Map<string, PairStat>): void {
  const colWidth = 5;
  process.stderr.write("\n");
  let header = "from \\ to".padEnd(13);
  for (const dom of domains) header += dom.slice(0, 4).padStart(colWidth);
  process.stderr.write(header + "\n");
  for (const fromDom of domains) {
    let row = fromDom.padEnd(13);
    for (const toDom of domains) {
      if (fromDom === toDom) {
        row += "-".padStart(colWidth);
        continue;
      }
      const stats = pairStats.get(`${fromDom}::${toDom}`);
      if (!stats) {
        row += ".".padStart(colWidth);
        continue;
      }
      const total = stats.static + stats.dynamic;
      const marker = stats.dynamic > 0 ? "*" : "";
      row += (total + marker).toString().padStart(colWidth);
    }
    process.stderr.write(row + "\n");
  }
  process.stderr.write("  (* = some dynamic imports in this pair)\n");
}

function domainOf(rel: string): string | null {
  const match = rel.match(/^src\/([^/]+)\//);
  if (match) return match[1]!;
  if (rel.startsWith("server/")) return "server";
  if (/^src\/[^/]+\.ts$/.test(rel)) return "entry";
  return null;
}

function bumpPair(
  pairStats: Map<string, PairStat>,
  from: string,
  to: string,
  kind: "static" | "dynamic",
): void {
  const key = `${from}::${to}`;
  const prior = pairStats.get(key) ?? { static: 0, dynamic: 0 };
  prior[kind]++;
  pairStats.set(key, prior);
}
