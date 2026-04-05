/**
 * Report exports that are imported by many files — a breadth-of-coupling signal.
 *
 * A symbol imported in many files isn't necessarily a problem, but high-count
 * functions and constants are worth reviewing: they may be doing too much, or
 * indicate that a module boundary is too leaky.
 *
 * Types and interfaces are excluded — widespread type imports are normal and
 * don't create runtime coupling.
 *
 * Usage:
 *   npx tsx scripts/report-hot-exports.ts [options]
 *
 * Options:
 *   --threshold <n>   Min file count to include (default: 5)
 *   --max <n>         Max file count to include (default: unlimited)
 *   --top <n>         Show only top N results (default: all above threshold)
 *   --server          Include server/ files
 *   --kinds <k,k>     Comma-separated kinds to include: function,const,enum,class
 *                     (default: function,const,enum)
 */

import { Project } from "ts-morph";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const includeServer = args.includes("--server");

const thresholdIdx = args.indexOf("--threshold");
const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 5;

const maxIdx = args.indexOf("--max");
const maxCount = maxIdx >= 0 ? Number(args[maxIdx + 1]) : Infinity;

const topIdx = args.indexOf("--top");
const topN = topIdx >= 0 ? Number(args[topIdx + 1]) : Infinity;

const kindsIdx = args.indexOf("--kinds");
const kindsArg = kindsIdx >= 0 ? args[kindsIdx + 1] : "function,const,enum";
const includeKinds = new Set(kindsArg!.split(",").map(k => k.trim()));
const summaryOnly = args.includes("--summary");

// ---------------------------------------------------------------------------
// Load project
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const globs = ["src/**/*.ts"];
if (includeServer) globs.push("server/**/*.ts");
for (const glob of globs) project.addSourceFilesAtPaths(glob);

function fileKey(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Collect exports (functions, consts, enums, classes — not types/interfaces)
// ---------------------------------------------------------------------------

type ExportKind = "function" | "const" | "enum" | "class";

interface ExportInfo {
  name: string;
  kind: ExportKind;
  file: string;
  line: number;
}

const exportMap = new Map<string, ExportInfo>();

for (const sf of project.getSourceFiles()) {
  const file = fileKey(sf.getFilePath());

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (name) exportMap.set(name, { name, kind: "function", file, line: fn.getStartLineNumber() });
  }

  for (const stmt of sf.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      exportMap.set(decl.getName(), { name: decl.getName(), kind: "const", file, line: decl.getStartLineNumber() });
    }
  }

  for (const en of sf.getEnums()) {
    if (!en.isExported()) continue;
    exportMap.set(en.getName(), { name: en.getName(), kind: "enum", file, line: en.getStartLineNumber() });
  }

  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) continue;
    const name = cls.getName();
    if (name) exportMap.set(name, { name, kind: "class", file, line: cls.getStartLineNumber() });
  }
}

// ---------------------------------------------------------------------------
// Count how many files import each symbol
// ---------------------------------------------------------------------------

// symbol → set of files that import it
const importers = new Map<string, Set<string>>();

for (const sf of project.getSourceFiles()) {
  const file = fileKey(sf.getFilePath());
  for (const decl of sf.getImportDeclarations()) {
    for (const named of decl.getNamedImports()) {
      const name = named.getName();
      if (!importers.has(name)) importers.set(name, new Set());
      importers.get(name)!.add(file);
    }
  }
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

interface ReportEntry {
  info: ExportInfo;
  count: number;
  importedBy: string[];
}

const results: ReportEntry[] = [];

for (const [name, info] of exportMap) {
  if (!includeKinds.has(info.kind)) continue;
  const files = importers.get(name);
  const count = files?.size ?? 0;
  if (count < threshold || count > maxCount) continue;
  // Exclude the file that defines the symbol
  const importedBy = [...(files ?? [])].filter(f => f !== info.file).sort();
  results.push({ info, count: importedBy.length, importedBy });
}

// Sort by count descending, then name
results.sort((a, b) => b.count - a.count || a.info.name.localeCompare(b.info.name));

const shown = results.slice(0, topN === Infinity ? undefined : topN);

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

if (shown.length === 0) {
  const rangeLabel = maxCount < Infinity ? `${threshold}–${maxCount}` : `${threshold}+`;
  console.log(`\nNo exports imported by ${rangeLabel} files.\n`);
  process.exit(0);
}

const rangeLabel = maxCount < Infinity ? `${threshold}–${maxCount}` : `${threshold}+`;
console.log(`\nExports imported by ${rangeLabel} files (kinds: ${[...includeKinds].join(", ")})\n`);
console.log(`${"Symbol".padEnd(36)} ${"Kind".padEnd(10)} ${"Files".padEnd(5)}  Defined in`);
console.log("─".repeat(90));

for (const { info, count, importedBy } of shown) {
  console.log(`${info.name.padEnd(36)} ${info.kind.padEnd(10)} ${String(count).padStart(4)}   ${info.file}:${info.line}`);
  if (!summaryOnly) {
    for (const f of importedBy) {
      console.log(`${"".padEnd(49)} ↳ ${f}`);
    }
  }
}

console.log(`\n${shown.length} symbol(s) shown (${results.length} total above threshold).\n`);
