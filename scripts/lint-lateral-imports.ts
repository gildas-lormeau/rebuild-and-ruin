/**
 * Lateral import lint — keep same-layer imports explicit, temporary, and bounded.
 *
 * Rules:
 * 1. Same-layer imports must be allowlisted.
 * 2. Total same-layer imports must stay <= maxLateralImports.
 * 3. Allowlist entries must not be expired.
 * 4. Stale allowlist entries (no matching edge) fail lint.
 *
 * Usage:
 *   deno run -A scripts/lint-lateral-imports.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project } from "ts-morph";

interface LayerGroup {
  name: string;
  files: string[];
}

interface AllowlistEdge {
  from: string;
  to: string;
  rationale: string;
  owner: string;
  expiresOn: string;
  removalPlan: string;
}

interface AllowlistFile {
  maxLateralImports: number;
  edges: AllowlistEdge[];
}

interface LateralEdge {
  from: string;
  to: string;
  layer: number;
  layerName: string;
}

const LAYER_FILE = ".import-layers.json";
const ALLOWLIST_FILE = "scripts/lateral-imports-allowlist.json";

function normalizeRel(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function parseIsoDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

const groups: LayerGroup[] = JSON.parse(readFileSync(LAYER_FILE, "utf-8"));
const allowlist: AllowlistFile = JSON.parse(
  readFileSync(ALLOWLIST_FILE, "utf-8"),
);

const fileToLayer = new Map<string, number>();
const layerNames = new Map<number, string>();
for (let i = 0; i < groups.length; i++) {
  const group = groups[i]!;
  layerNames.set(i, group.name);
  for (const file of group.files) {
    fileToLayer.set(file, i);
  }
}

const allowlistByKey = new Map<string, AllowlistEdge>();
for (const edge of allowlist.edges) {
  allowlistByKey.set(edgeKey(edge.from, edge.to), edge);
}

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
project.addSourceFilesAtPaths("src/**/*.ts");
project.addSourceFilesAtPaths("server/**/*.ts");

const lateralEdges = new Map<string, LateralEdge>();
let checkedImports = 0;

for (const sourceFile of project.getSourceFiles()) {
  if (sourceFile.getBaseName().endsWith(".d.ts")) continue;
  const from = normalizeRel(sourceFile.getFilePath());
  const fromLayer = fileToLayer.get(from);
  if (fromLayer === undefined) continue;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const resolved = importDecl.getModuleSpecifierSourceFile();
    if (!resolved) continue;
    if (resolved.getBaseName().endsWith(".d.ts")) continue;

    const to = normalizeRel(resolved.getFilePath());
    const toLayer = fileToLayer.get(to);
    if (toLayer === undefined) continue;
    checkedImports++;

    if (from !== to && fromLayer === toLayer) {
      const key = edgeKey(from, to);
      if (!lateralEdges.has(key)) {
        lateralEdges.set(key, {
          from,
          to,
          layer: fromLayer,
          layerName: layerNames.get(fromLayer) ?? `layer ${fromLayer}`,
        });
      }
    }
  }
}

const violations: string[] = [];
const now = Date.now();

if (lateralEdges.size > allowlist.maxLateralImports) {
  violations.push(
    `Lateral import budget exceeded: found ${lateralEdges.size}, max ${allowlist.maxLateralImports}`,
  );
}

for (const [key, edge] of lateralEdges) {
  const allowed = allowlistByKey.get(key);
  if (!allowed) {
    violations.push(
      `Unallowlisted lateral import: ${edge.from} -> ${edge.to} [${edge.layerName}]`,
    );
    continue;
  }

  const expiry = parseIsoDate(allowed.expiresOn);
  if (expiry === null) {
    violations.push(
      `Invalid expiresOn date for allowlist edge ${key}: ${allowed.expiresOn}`,
    );
    continue;
  }
  if (expiry < now) {
    violations.push(
      `Expired lateral allowlist edge: ${key} (expired ${allowed.expiresOn})`,
    );
  }
}

for (const [key] of allowlistByKey) {
  if (!lateralEdges.has(key)) {
    violations.push(
      `Stale allowlist edge (no matching lateral import): ${key}`,
    );
  }
}

if (violations.length === 0) {
  console.log(
    `\n✔ Lateral import policy satisfied (${lateralEdges.size} edges, budget ${allowlist.maxLateralImports}, ${checkedImports} imports checked)\n`,
  );
  process.exit(0);
}

console.log(`\n✘ ${violations.length} lateral import policy violation(s):\n`);
for (const violation of violations) {
  console.log(`  - ${violation}`);
}

if (lateralEdges.size > 0) {
  console.log("\nCurrent lateral edges:");
  const sorted = [...lateralEdges.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
  for (const edge of sorted) {
    console.log(`  * ${edge.from} -> ${edge.to} [${edge.layerName}]`);
  }
}

console.log("");
process.exit(1);
