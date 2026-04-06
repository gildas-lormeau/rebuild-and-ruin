/**
 * Merge duplicate imports from the same module into a single import statement.
 *
 * Transforms:
 *   import type { X } from "./foo.ts";
 *   import { Y } from "./foo.ts";
 * Into:
 *   import { type X, Y } from "./foo.ts";
 *
 * Usage:
 *   deno run -A scripts/merge-imports.ts [--check] [--write] [files...]
 *
 * --check  Exit 1 if any file has mergeable imports (CI mode)
 * --write  Apply merges in-place (default: dry-run, prints what would change)
 *
 * With no file args, processes all .ts files in src/ and server/.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

interface ParsedImport {
  line: number;
  raw: string;
  allType: boolean;
  specifiers: string[];
  source: string;
}

function parseImportLine(line: string): ParsedImport | null {
  const m = line.match(
    /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"\s*;?\s*$/,
  );
  if (!m) return null;
  const allType = !!m[1];
  const raw2 = m[2] ?? "";
  const source = m[3] ?? "";
  const specifiers = raw2
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { line: 0, raw: line, allType, specifiers, source };
}

function mergeImports(a: ParsedImport, b: ParsedImport): string {
  const specs = new Map<string, boolean>();

  for (const imp of [a, b]) {
    for (const spec of imp.specifiers) {
      const typeMatch = spec.match(/^type\s+(.+)$/);
      const name = typeMatch ? typeMatch[1]! : spec;
      const isType = imp.allType || !!typeMatch;
      if (specs.has(name)) {
        if (!isType) specs.set(name, false);
      } else {
        specs.set(name, isType);
      }
    }
  }

  // Sort alphabetically by name, ignoring type prefix (matches biome order)
  const sorted = [...specs.entries()].sort((x, y) =>
    x[0].localeCompare(y[0]),
  );

  const allAreType = sorted.every(([, isType]) => isType);

  const specStr = sorted
    .map(([name, isType]) => (isType && !allAreType ? `type ${name}` : name))
    .join(", ");

  const prefix = allAreType ? "import type" : "import";
  return `${prefix} { ${specStr} } from "${a.source}";`;
}

function processFile(
  filePath: string,
  write: boolean,
): { path: string; merges: string[] } | null {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const importsBySource = new Map<string, { lineIdx: number; parsed: ParsedImport }[]>();

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseImportLine(lines[i]!);
    if (!parsed) continue;
    parsed.line = i;
    const key = parsed.source;
    const group = importsBySource.get(key);
    if (group) {
      group.push({ lineIdx: i, parsed });
    } else {
      importsBySource.set(key, [{ lineIdx: i, parsed }]);
    }
  }

  const merges: string[] = [];
  const linesToRemove = new Set<number>();
  const lineReplacements = new Map<number, string>();

  for (const [source, imports] of importsBySource) {
    if (imports.length < 2) continue;

    const first = imports[0]!;
    let merged = first.parsed;
    for (let i = 1; i < imports.length; i++) {
      const entry = imports[i]!;
      const mergedLine = mergeImports(merged, entry.parsed);
      const parsed = parseImportLine(mergedLine);
      if (!parsed) continue;
      merged = parsed;
      merged.line = first.lineIdx;
      linesToRemove.add(entry.lineIdx);
    }

    lineReplacements.set(first.lineIdx, merged.raw);
    merges.push(
      `  L${first.lineIdx + 1}: ${imports.length} imports from "${source}" → merged`,
    );
  }

  if (merges.length === 0) return null;

  if (write) {
    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (linesToRemove.has(i)) continue;
      const replacement = lineReplacements.get(i);
      result.push(replacement ?? lines[i]!);
    }
    writeFileSync(filePath, result.join("\n"), "utf-8");
  }

  return { path: filePath, merges };
}

// --- main ---
const args = process.argv.slice(2);
const check = args.includes("--check");
const write = args.includes("--write");
const fileArgs = args.filter((a) => !a.startsWith("--"));

function findTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? findTsFiles(join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")
          ? [join(dir, e.name)]
          : [],
    );
}

const files =
  fileArgs.length > 0
    ? fileArgs
    : [...findTsFiles("src"), ...findTsFiles("server")];

let totalMerges = 0;
for (const file of files.sort()) {
  const result = processFile(file, write);
  if (result) {
    console.log(`${result.path}:`);
    for (const m of result.merges) console.log(m);
    totalMerges += result.merges.length;
  }
}

if (totalMerges === 0) {
  console.log("✔ No duplicate imports found");
  process.exit(0);
} else {
  const verb = write ? "Merged" : "Found";
  console.log(`\n${verb} ${totalMerges} duplicate import(s) across ${files.length} files`);
  if (!write && !check) console.log("Run with --write to apply, or --check for CI mode");
  if (check) process.exit(1);
}
