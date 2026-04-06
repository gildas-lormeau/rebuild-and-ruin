/**
 * Build a searchable index of all exported symbols in the codebase.
 *
 * Parses every .ts file in src/ (and optionally server/), extracts all
 * exported functions, constants, types, interfaces, enums, and classes,
 * and writes a JSON index. Agents query this before writing new code to
 * avoid reinventing existing helpers.
 *
 * Output: .export-index.json — array of entries, each with:
 *   - name: symbol name
 *   - kind: "function" | "const" | "type" | "interface" | "enum" | "class"
 *   - file: relative path
 *   - line: line number
 *   - signature: short signature (params + return type for functions, type for constants)
 *   - doc: first line of JSDoc if present
 *
 * Usage:
 *   deno run -A scripts/generate-export-index.ts [options]
 *
 * Options:
 *   --print         Print to stdout instead of writing file
 *   --server        Include server/ files
 *   --search <q>    Search the index for a term (fuzzy name match)
 *   --kind <k>      Filter by kind (function, const, type, interface, enum, class)
 */

import { Project, type Node } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const includeServer = args.includes("--server");
const searchIdx = args.indexOf("--search");
const searchQuery = searchIdx >= 0 ? args[searchIdx + 1]?.toLowerCase() : null;
const kindIdx = args.indexOf("--kind");
const kindFilter = kindIdx >= 0 ? args[kindIdx + 1]?.toLowerCase() : null;

const OUTPUT_FILE = ".export-index.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportEntry {
  name: string;
  kind: "function" | "const" | "type" | "interface" | "enum" | "class";
  file: string;
  line: number;
  signature: string;
  doc: string;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const globs = ["src/**/*.ts"];
if (includeServer) globs.push("server/**/*.ts");
for (const glob of globs) {
  project.addSourceFilesAtPaths(glob);
}

function fileKey(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Extract the first line of JSDoc for a node, if any. */
function getDocLine(node: Node): string {
  const jsDocs = (node as { getJsDocs?: () => { getDescription: () => string }[] }).getJsDocs?.();
  if (!jsDocs || jsDocs.length === 0) return "";
  const desc = jsDocs[0]!.getDescription().trim();
  const firstLine = desc.split("\n")[0]!.trim();
  return firstLine;
}

/** Strip absolute import paths from type text, keeping just the type name. */
function shortenType(text: string, maxLen: number): string {
  // import("/abs/path/to/file").TypeName → TypeName
  const cleaned = text.replace(/import\("[^"]+"\)\./g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + "..." : cleaned;
}

/** Build a compact signature string for a function. */
function funcSignature(node: {
  getParameters: () => { getName: () => string; getType: () => { getText: () => string } }[];
  getReturnType: () => { getText: () => string };
}): string {
  const params = node.getParameters().map(p => {
    const typeText = shortenType(p.getType().getText(), 40);
    return `${p.getName()}: ${typeText}`;
  });
  const ret = shortenType(node.getReturnType().getText(), 40);
  return `(${params.join(", ")}) => ${ret}`;
}

const entries: ExportEntry[] = [];

for (const sf of project.getSourceFiles()) {
  const file = fileKey(sf.getFilePath());

  // Exported functions
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name) continue;
    entries.push({
      name,
      kind: "function",
      file,
      line: fn.getStartLineNumber(),
      signature: funcSignature(fn),
      doc: getDocLine(fn),
    });
  }

  // Exported variable statements (const)
  for (const stmt of sf.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const name = decl.getName();
      const short = shortenType(decl.getType().getText(), 60);
      entries.push({
        name,
        kind: "const",
        file,
        line: decl.getStartLineNumber(),
        signature: short,
        doc: getDocLine(stmt),
      });
    }
  }

  // Exported interfaces
  for (const iface of sf.getInterfaces()) {
    if (!iface.isExported()) continue;
    const members = iface.getMembers().map(m => {
      const name = (m as { getName?: () => string }).getName?.() ?? "?";
      return name;
    });
    const short = members.length > 5
      ? `{ ${members.slice(0, 5).join(", ")}, ... (${members.length} members) }`
      : `{ ${members.join(", ")} }`;
    entries.push({
      name: iface.getName(),
      kind: "interface",
      file,
      line: iface.getStartLineNumber(),
      signature: short,
      doc: getDocLine(iface),
    });
  }

  // Exported type aliases
  for (const ta of sf.getTypeAliases()) {
    if (!ta.isExported()) continue;
    const short = shortenType(ta.getType().getText(), 60);
    entries.push({
      name: ta.getName(),
      kind: "type",
      file,
      line: ta.getStartLineNumber(),
      signature: short,
      doc: getDocLine(ta),
    });
  }

  // Exported enums
  for (const en of sf.getEnums()) {
    if (!en.isExported()) continue;
    const members = en.getMembers().map(m => m.getName());
    const short = members.length > 6
      ? `${members.slice(0, 6).join(" | ")} | ... (${members.length})`
      : members.join(" | ");
    entries.push({
      name: en.getName(),
      kind: "enum",
      file,
      line: en.getStartLineNumber(),
      signature: short,
      doc: getDocLine(en),
    });
  }

  // Exported classes
  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) continue;
    const name = cls.getName();
    if (!name) continue;
    const methods = cls.getMethods().filter(m => m.getScope() === undefined || m.getScope() === "public");
    const methodNames = methods.map(m => m.getName());
    const short = methodNames.length > 5
      ? `${methodNames.slice(0, 5).join(", ")}, ... (${methodNames.length} methods)`
      : methodNames.join(", ");
    entries.push({
      name,
      kind: "class",
      file,
      line: cls.getStartLineNumber(),
      signature: short,
      doc: getDocLine(cls),
    });
  }
}

// Sort by file then line
entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// ---------------------------------------------------------------------------
// Search mode
// ---------------------------------------------------------------------------

if (searchQuery) {
  let results = entries.filter(e => {
    const haystack = `${e.name} ${e.doc} ${e.signature}`.toLowerCase();
    return haystack.includes(searchQuery);
  });
  if (kindFilter) {
    results = results.filter(e => e.kind === kindFilter);
  }

  if (results.length === 0) {
    console.log(`No exports matching "${searchQuery}"${kindFilter ? ` (kind: ${kindFilter})` : ""}`);
    process.exit(0);
  }

  console.log(`\n${results.length} export(s) matching "${searchQuery}"${kindFilter ? ` (kind: ${kindFilter})` : ""}:\n`);
  for (const e of results) {
    console.log(`  ${e.kind.padEnd(10)} ${e.name}`);
    console.log(`             ${e.file}:${e.line}`);
    if (e.doc) console.log(`             ${e.doc}`);
    console.log(`             ${e.signature}`);
    console.log("");
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const kindCounts = new Map<string, number>();
for (const e of entries) {
  kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
}

const summary = [...kindCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${v} ${k}s`)
  .join(", ");

console.log(`\nExport index: ${entries.length} symbols (${summary})\n`);

if (!printOnly) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(entries, null, 2) + "\n");
  console.log(`Written to ${OUTPUT_FILE}\n`);
}

if (printOnly) {
  let filtered = entries;
  if (kindFilter) {
    filtered = entries.filter(e => e.kind === kindFilter);
  }
  for (const e of filtered) {
    const doc = e.doc ? ` — ${e.doc}` : "";
    console.log(`  ${e.file}:${e.line}  ${e.kind.padEnd(10)} ${e.name}${doc}`);
  }
  console.log("");
}
