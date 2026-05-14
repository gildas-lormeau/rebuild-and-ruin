/**
 * File → impact map. For a given source file, list the radius of
 * change before editing — same-cell peers, deps (what it imports,
 * grouped by cell), and consumers (what imports it, grouped by cell),
 * plus test files that reference it. This replaces the multi-grep
 * "find every site I need to touch" workflow when an agent is about
 * to modify a cross-cutting file (controller protocols, runtime
 * contracts, wire payloads).
 *
 * Usage:
 *   deno run -A scripts/cells/cell-edit-impact.ts src/controllers/controller-types.ts
 *   deno run -A scripts/cells/cell-edit-impact.ts src/runtime/runtime-types.ts --json
 *
 * The script loads all files in src/ + server/ via ts-morph, builds a
 * full reverse-import map once, and answers the query against it. Run
 * time is dominated by the ts-morph load (~3-5s) — for repeated
 * lookups, prefer batching multiple file args in one invocation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Project } from "ts-morph";

interface Cell {
  layer: number;
  domain: string;
  tier?: string;
  role: string;
  files: string[];
}

interface ImpactReport {
  target: string;
  cell: Cell | null;
  sameCellPeers: string[];
  depsByCell: Array<{ cellId: string; role: string; files: string[] }>;
  consumersByCell: Array<{ cellId: string; role: string; files: string[] }>;
  testConsumers: string[];
}

const ROOT = path.resolve(import.meta.dirname!, "..", "..");
const CELLS_PATH = path.join(ROOT, ".import-cells.json");

main();

function main(): void {
  const args = parseArgs(Deno.args);
  if (args.targets.length === 0) {
    console.error(
      "Usage: deno run -A scripts/cells/cell-edit-impact.ts <file> [<file>...] [--json]",
    );
    Deno.exit(2);
  }

  const cells: Cell[] = JSON.parse(readFileSync(CELLS_PATH, "utf-8"));
  const fileToCell = buildFileToCell(cells);
  const { depsByFile, consumersByFile } = buildImportGraph(fileToCell);
  const testConsumersByFile = scanTestConsumers(fileToCell);

  const reports = args.targets.map((target) =>
    buildReport(
      target,
      cells,
      fileToCell,
      depsByFile,
      consumersByFile,
      testConsumersByFile,
    ),
  );

  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const report of reports) printReport(report);
}

function parseArgs(argv: string[]): { targets: string[]; json: boolean } {
  const targets: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else targets.push(arg);
  }
  return { targets, json };
}

function buildFileToCell(cells: Cell[]): Map<string, Cell> {
  const map = new Map<string, Cell>();
  for (const cell of cells) {
    for (const file of cell.files) map.set(file, cell);
  }
  return map;
}

function buildImportGraph(fileToCell: Map<string, Cell>): {
  depsByFile: Map<string, Set<string>>;
  consumersByFile: Map<string, Set<string>>;
} {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of fileToCell.keys()) {
    try {
      project.addSourceFileAtPath(path.join(ROOT, file));
    } catch {
      /* skip */
    }
  }

  const depsByFile = new Map<string, Set<string>>();
  const consumersByFile = new Map<string, Set<string>>();
  for (const sf of project.getSourceFiles()) {
    const from = path.relative(ROOT, sf.getFilePath()).replace(/\\/g, "/");
    if (!fileToCell.has(from)) continue;
    const deps = depsByFile.get(from) ?? new Set<string>();
    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const to = path
        .relative(ROOT, resolved.getFilePath())
        .replace(/\\/g, "/");
      if (!fileToCell.has(to)) continue;
      deps.add(to);
      const consumers = consumersByFile.get(to) ?? new Set<string>();
      consumers.add(from);
      consumersByFile.set(to, consumers);
    }
    depsByFile.set(from, deps);
  }

  return { depsByFile, consumersByFile };
}

/**
 * Grep `test/` for filenames-as-import-specifiers. We match
 * `from "...basename"` rather than scanning every line so we don't
 * false-positive on bare mentions inside comments.
 */
function scanTestConsumers(
  fileToCell: Map<string, Cell>,
): Map<string, string[]> {
  const testDir = path.join(ROOT, "test");
  if (!existsSync(testDir)) return new Map();

  const testFiles: string[] = [];
  collectTsFiles(testDir, testFiles);

  const result = new Map<string, string[]>();
  for (const target of fileToCell.keys()) {
    result.set(target, []);
  }

  for (const testFile of testFiles) {
    const content = readFileSync(testFile, "utf-8");
    const rel = path.relative(ROOT, testFile).replace(/\\/g, "/");
    for (const target of fileToCell.keys()) {
      const basename = path.basename(target).replace(/\.ts$/, "");
      const pattern = new RegExp(
        `from\\s+["'][^"']*${escapeRegex(basename)}(?:\\.ts)?["']`,
      );
      if (pattern.test(content)) {
        result.get(target)!.push(rel);
      }
    }
  }

  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectTsFiles(dir: string, accumulator: string[]): void {
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) collectTsFiles(fullPath, accumulator);
    else if (name.endsWith(".ts")) accumulator.push(fullPath);
  }
}

function buildReport(
  target: string,
  cells: Cell[],
  fileToCell: Map<string, Cell>,
  depsByFile: Map<string, Set<string>>,
  consumersByFile: Map<string, Set<string>>,
  testConsumersByFile: Map<string, string[]>,
): ImpactReport {
  const cell = fileToCell.get(target) ?? null;
  const sameCellPeers = cell
    ? cell.files.filter((file) => file !== target)
    : [];

  const depsByCell = groupByCell(
    depsByFile.get(target) ?? new Set(),
    fileToCell,
  );
  const consumersByCell = groupByCell(
    consumersByFile.get(target) ?? new Set(),
    fileToCell,
  );

  // Filter own-cell out of deps/consumers (already covered by peers).
  const ownCellId = cell ? `${cell.layer}::${cell.domain}` : "";
  const depsFiltered = depsByCell.filter((group) => group.cellId !== ownCellId);
  const consumersFiltered = consumersByCell.filter(
    (group) => group.cellId !== ownCellId,
  );

  return {
    target,
    cell,
    sameCellPeers,
    depsByCell: depsFiltered,
    consumersByCell: consumersFiltered,
    testConsumers: testConsumersByFile.get(target) ?? [],
  };
}

function groupByCell(
  files: Set<string>,
  fileToCell: Map<string, Cell>,
): Array<{ cellId: string; role: string; files: string[] }> {
  const groups = new Map<
    string,
    { cellId: string; role: string; files: string[] }
  >();
  for (const file of files) {
    const cell = fileToCell.get(file);
    if (!cell) continue;
    const cellId = `${cell.layer}::${cell.domain}`;
    if (!groups.has(cellId)) {
      groups.set(cellId, {
        cellId,
        role: `L${cell.layer} · ${cell.domain} — ${cell.role}`,
        files: [],
      });
    }
    groups.get(cellId)!.files.push(file);
  }
  for (const group of groups.values()) group.files.sort();
  return [...groups.values()].sort((leftGroup, rightGroup) => {
    const [leftLayer] = leftGroup.cellId.split("::").map(Number);
    const [rightLayer] = rightGroup.cellId.split("::").map(Number);
    return rightLayer! - leftLayer!;
  });
}

function printReport(report: ImpactReport): void {
  console.log(`\n=== ${report.target} ===`);
  if (!report.cell) {
    console.log(
      `  ⚠ Not in any cell — file may be unregistered or excluded from layers`,
    );
    return;
  }
  console.log(
    `  Cell: L${report.cell.layer} · ${report.cell.domain} — ${report.cell.role}`,
  );

  if (report.sameCellPeers.length > 0) {
    console.log(`\n  Same-cell peers (${report.sameCellPeers.length}):`);
    for (const peer of report.sameCellPeers) console.log(`    ${peer}`);
  } else {
    console.log(`\n  Same-cell peers: (none — solo file at this cell)`);
  }

  if (report.consumersByCell.length > 0) {
    const total = report.consumersByCell.reduce(
      (sum, group) => sum + group.files.length,
      0,
    );
    console.log(
      `\n  Consumers (${total} file(s) across ${report.consumersByCell.length} cell(s)):`,
    );
    for (const group of report.consumersByCell) {
      console.log(`    ${group.role}  (${group.files.length})`);
      for (const file of group.files) console.log(`      ${file}`);
    }
  } else {
    console.log(
      `\n  Consumers: (none — leaf file, only consumed within same cell or unused)`,
    );
  }

  if (report.depsByCell.length > 0) {
    const total = report.depsByCell.reduce(
      (sum, group) => sum + group.files.length,
      0,
    );
    console.log(
      `\n  Deps (${total} file(s) across ${report.depsByCell.length} cell(s)):`,
    );
    for (const group of report.depsByCell) {
      console.log(`    ${group.role}  (${group.files.length})`);
      for (const file of group.files) console.log(`      ${file}`);
    }
  }

  if (report.testConsumers.length > 0) {
    console.log(`\n  Test consumers (${report.testConsumers.length}):`);
    for (const test of report.testConsumers) console.log(`    ${test}`);
  }
}
