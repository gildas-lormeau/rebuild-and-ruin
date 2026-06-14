/**
 * Report source files that export exactly one symbol.
 *
 * Reads `.export-index.json` (regenerate with `npm run export-index`), groups
 * exports by file, and lists every file whose export count is exactly one.
 * The count can ignore type-declaration kinds (so a file pairing one function
 * with a co-located helper interface still reads as "single export"), and the
 * intentional one-per-file registry/factory families can be hidden to surface
 * the odd standalone singletons.
 *
 * Usage:
 *   deno run -A scripts/report-single-export-files.ts [options]
 *
 * Options:
 *   --ignore-kinds <k1,k2>  Exclude these export kinds from the per-file count.
 *                           Kinds: function, const, class, interface, type,
 *                           enum. Default: none (every export counts).
 *   --loose                 Hide the known one-per-file families (modifier /
 *                           upgrade pools, 3D effect + entity factories,
 *                           ai-plan-* strategies, runtime subsystems) so only
 *                           the non-family singletons remain.
 *   --json                  Emit JSON instead of the grouped text report.
 */

import fs from "node:fs";
import process from "node:process";

interface ExportEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
}

const INDEX_FILE = ".export-index.json";
/** Path patterns for the intentional one-per-file families `--loose` hides. */
const FAMILY_PATTERNS: readonly RegExp[] = [
  /^src\/game\/modifiers\//,
  /^src\/game\/upgrades\//,
  /^src\/render\/3d\/effects\//,
  /^src\/render\/3d\/entities\//,
  /^src\/runtime\/subsystems\//,
  /^src\/ai\/ai-plan-/,
];

main();

function main(): void {
  const args = process.argv.slice(2);
  const ignoreKinds = parseListFlag(args, "--ignore-kinds");
  const loose = args.includes("--loose");
  const jsonOutput = args.includes("--json");

  const ignore = new Set(ignoreKinds);
  const byFile = new Map<string, ExportEntry[]>();
  for (const entry of loadIndex()) {
    if (ignore.has(entry.kind)) continue;
    const list = byFile.get(entry.file) ?? [];
    list.push(entry);
    byFile.set(entry.file, list);
  }

  let singles = [...byFile.entries()].filter(([, list]) => list.length === 1);
  if (loose) {
    singles = singles.filter(
      ([file]) => !FAMILY_PATTERNS.some((pattern) => pattern.test(file)),
    );
  }
  singles.sort(([fileA], [fileB]) => fileA.localeCompare(fileB));

  if (jsonOutput) {
    const out = singles.map(([file, list]) => ({
      file,
      name: list[0]!.name,
      kind: list[0]!.kind,
      line: list[0]!.line,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printReport(singles, ignoreKinds, loose);
}

function loadIndex(): ExportEntry[] {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error(
      `${INDEX_FILE} not found — run \`npm run export-index\` first.`,
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as ExportEntry[];
}

function parseListFlag(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx < 0 || !args[idx + 1]) return [];
  return args[idx + 1]!.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function printReport(
  singles: [string, ExportEntry[]][],
  ignoreKinds: string[],
  loose: boolean,
): void {
  const ignoreNote = ignoreKinds.length
    ? ` (ignoring ${ignoreKinds.join("/")})`
    : "";
  const looseNote = loose ? ", families hidden" : "";
  console.log(
    `Files with exactly one export${ignoreNote}${looseNote}: ${singles.length}\n`,
  );

  const groups = new Map<string, [string, ExportEntry[]][]>();
  for (const single of singles) {
    const domain = domainOf(single[0]);
    const list = groups.get(domain) ?? [];
    list.push(single);
    groups.set(domain, list);
  }

  for (const domain of [...groups.keys()].sort()) {
    const list = groups.get(domain)!;
    console.log(`── ${domain} (${list.length}) ──`);
    for (const [file, exports] of list) {
      const only = exports[0]!;
      console.log(`   ${file}  →  ${only.kind} ${only.name}`);
    }
    console.log();
  }
}

/** Top-level domain a file belongs to (mirrors the cell-map derivation). */
function domainOf(file: string): string {
  if (file.startsWith("src/")) {
    const rest = file.slice("src/".length);
    return rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : "entry";
  }
  return file.includes("/") ? file.slice(0, file.indexOf("/")) : file;
}
