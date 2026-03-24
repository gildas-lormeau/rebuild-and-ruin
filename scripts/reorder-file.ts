/**
 * AST-based file reorder tool.
 *
 * Reorders top-level statements in a TypeScript file to follow:
 *   1. Imports (and re-exports)
 *   2. Type aliases / interfaces / enums
 *   3. All `const` declarations (data + arrow functions) — dependency-sorted
 *      (non-exported before exported as tiebreaker)
 *   4. `function` declarations (hoisted) — callers before callees
 *
 * `const` is not hoisted so deps-first is required for correctness.
 * `function` declarations are hoisted so callers-first is safe and gives
 * a top-down reading experience.
 *
 * Usage: npx tsx scripts/reorder-file.ts <path> [--dry-run] [--debug]
 */

import {
  type Node,
  Project,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "ts-morph";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cliArgs = process.argv.slice(2);
const dryRun = cliArgs.includes("--dry-run");
const debug = cliArgs.includes("--debug");
const filePath = cliArgs.find((a) => !a.startsWith("--"));

if (!filePath) {
  console.error("Usage: npx tsx scripts/reorder-file.ts <path> [--dry-run] [--debug]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const enum Cat {
  Import = 0,
  Type = 1,
  Const = 2,  // all const (data + arrow fns, exported + private)
  Fn = 3,     // function declarations only (hoisted)
}

const CAT_NAMES = ["Import", "Type", "Const", "Fn"];

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function isExported(stmt: Statement): boolean {
  return stmt.getText().trimStart().startsWith("export ");
}

function classify(stmt: Statement): Cat {
  const k = stmt.getKind();
  if (k === SyntaxKind.ImportDeclaration || k === SyntaxKind.ImportEqualsDeclaration) return Cat.Import;
  if (k === SyntaxKind.ExportDeclaration) return Cat.Import; // re-exports
  if (
    k === SyntaxKind.TypeAliasDeclaration ||
    k === SyntaxKind.InterfaceDeclaration ||
    k === SyntaxKind.EnumDeclaration
  ) {
    return Cat.Type;
  }
  // function declarations → hoisted bucket (callers-first)
  if (k === SyntaxKind.FunctionDeclaration) return Cat.Fn;
  // All const (data + arrow fns) → non-hoisted bucket (deps-first)
  if (stmt.isKind(SyntaxKind.VariableStatement)) return Cat.Const;
  return Cat.Fn; // fallback (export default, etc.)
}

// ---------------------------------------------------------------------------
// Name extraction
// ---------------------------------------------------------------------------

function getName(stmt: Statement): string | undefined {
  if (stmt.isKind(SyntaxKind.FunctionDeclaration)) return stmt.getName();
  if (stmt.isKind(SyntaxKind.VariableStatement)) {
    const decls = stmt.getDeclarationList().getDeclarations();
    if (decls.length === 1) return decls[0]!.getName();
  }
  if (
    stmt.isKind(SyntaxKind.TypeAliasDeclaration) ||
    stmt.isKind(SyntaxKind.InterfaceDeclaration) ||
    stmt.isKind(SyntaxKind.EnumDeclaration)
  ) {
    return (stmt as { getName(): string }).getName();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------

function collectRefs(node: Node): Set<string> {
  const names = new Set<string>();
  node.forEachDescendant((child) => {
    if (child.isKind(SyntaxKind.Identifier)) names.add(child.getText());
  });
  return names;
}

// ---------------------------------------------------------------------------
// Text extraction — preserves JSDoc, strips section separators
// ---------------------------------------------------------------------------

/** Matches `// ----------` or `// ==========` separator lines. */
const SEP_RE = /^\/\/\s*[-=]{10,}\s*$/;

/**
 * Extract a statement's text with its directly-attached comment (JSDoc or `//`).
 * Strips section-separator blocks and detaches unrelated leading comments.
 *
 * @param stmt         The statement node.
 * @param triviaStart  Override start of trivia region (used to skip file header).
 */
function extractOwnText(stmt: Statement, triviaStart?: number): string {
  const sf = stmt.getSourceFile().getFullText();
  const stmtStart = stmt.getStart(); // first token position
  const tStart = triviaStart ?? stmt.getFullStart();
  const trivia = sf.slice(tStart, stmtStart);
  const stmtText = stmt.getText();

  if (!trivia.trim()) return stmtText;

  // Strip the very last \n (artifact before the statement token).
  let raw = trivia;
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  const lines = raw.split("\n");

  // Walk backwards: collect comment lines, stop at blank / separator
  let keepFrom = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t === "") break;
    if (SEP_RE.test(t)) break;
    // Section title between separators: `// Title` preceded by `// ----`
    if (t.startsWith("//") && i > 0 && SEP_RE.test(lines[i - 1]!.trim())) break;
    keepFrom = i;
  }

  if (keepFrom < lines.length) {
    const comment = lines.slice(keepFrom).join("\n").trimEnd();
    if (comment) return comment + "\n" + stmtText;
  }
  return stmtText;
}

/**
 * Extract file-level header comment (module JSDoc, copyright notice).
 * Returns the header text and the byte position where it ends in the source.
 */
function extractFileHeader(sf: SourceFile): { text: string; endPos: number } {
  const stmts = sf.getStatements();
  if (stmts.length === 0) return { text: "", endPos: 0 };

  const firstStart = stmts[0]!.getStart();
  const before = sf.getFullText().slice(0, firstStart);
  const trimmed = before.trim();

  if (!trimmed || !(trimmed.startsWith("/*") || trimmed.startsWith("//"))) {
    return { text: "", endPos: 0 };
  }

  const headerEnd = before.indexOf(trimmed) + trimmed.length;
  return { text: trimmed, endPos: headerEnd };
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm
// ---------------------------------------------------------------------------

function buildEdges(stmts: Statement[]): Set<number>[] {
  const nameToIdx = new Map<string, number>();
  for (let i = 0; i < stmts.length; i++) {
    const n = getName(stmts[i]!);
    if (n) nameToIdx.set(n, i);
  }
  const edges: Set<number>[] = stmts.map(() => new Set());
  for (let i = 0; i < stmts.length; i++) {
    const refs = collectRefs(stmts[i]!);
    const self = getName(stmts[i]!);
    for (const ref of refs) {
      if (ref === self) continue;
      const t = nameToIdx.get(ref);
      if (t !== undefined && t !== i) edges[i]!.add(t);
    }
  }
  return edges;
}

/**
 * Callers before callees (for hoisted `function` declarations).
 * Among equal candidates: exported first, then original order (stable).
 */
function topoSortCallersFirst(stmts: Statement[]): Statement[] {
  if (stmts.length <= 1) return stmts;

  const edges = buildEdges(stmts);
  const exp = stmts.map((s) => isExported(s));

  // in-degree = how many callers reference me
  const inDeg = new Array(stmts.length).fill(0) as number[];
  for (let i = 0; i < stmts.length; i++)
    for (const t of edges[i]!) inDeg[t] = (inDeg[t] ?? 0) + 1;

  const q: number[] = [];
  const enqueue = (idx: number) => {
    q.push(idx);
    q.sort((a, b) => {
      const ea = exp[a]! ? 0 : 1;
      const eb = exp[b]! ? 0 : 1;
      return ea !== eb ? ea - eb : a - b;
    });
  };
  for (let i = 0; i < stmts.length; i++) if (inDeg[i] === 0) enqueue(i);

  const result: number[] = [];
  while (q.length > 0) {
    const idx = q.shift()!;
    result.push(idx);
    for (const t of edges[idx]!) {
      if (--inDeg[t]! === 0) enqueue(t);
    }
  }
  // Cycles: append remaining in original order
  if (result.length < stmts.length) {
    const done = new Set(result);
    for (let i = 0; i < stmts.length; i++) if (!done.has(i)) result.push(i);
  }
  return result.map((i) => stmts[i]!);
}

/**
 * Dependencies first (for non-hoisted `const` declarations).
 * Among equal candidates: non-exported before exported, then original order.
 */
function sortDepsFirst(stmts: Statement[]): Statement[] {
  if (stmts.length <= 1) return stmts;

  const edges = buildEdges(stmts); // edges[i] = things i depends on
  const exp = stmts.map((s) => isExported(s));

  // in-degree of i = number of its own dependencies
  const inDeg = stmts.map((_, i) => edges[i]!.size);

  // Reverse edges: dep → dependents
  const rev: Set<number>[] = stmts.map(() => new Set());
  for (let i = 0; i < stmts.length; i++)
    for (const dep of edges[i]!) rev[dep]!.add(i);

  // Tiebreaker: non-exported first, then original index
  const q: number[] = [];
  const enqueue = (idx: number) => {
    q.push(idx);
    q.sort((a, b) => {
      const ea = exp[a]! ? 1 : 0;
      const eb = exp[b]! ? 1 : 0;
      return ea !== eb ? ea - eb : a - b;
    });
  };
  for (let i = 0; i < stmts.length; i++) if (inDeg[i] === 0) enqueue(i);

  const result: number[] = [];
  while (q.length > 0) {
    const idx = q.shift()!;
    result.push(idx);
    for (const dependent of rev[idx]!) {
      if (--inDeg[dependent]! === 0) enqueue(dependent);
    }
  }
  // Cycles
  if (result.length < stmts.length) {
    const done = new Set(result);
    for (let i = 0; i < stmts.length; i++) if (!done.has(i)) result.push(i);
  }
  return result.map((i) => stmts[i]!);
}

// ---------------------------------------------------------------------------
// Main reorder
// ---------------------------------------------------------------------------

function reorderFile(sf: SourceFile): string {
  const stmts = sf.getStatements();
  if (stmts.length === 0) return sf.getFullText();

  const header = extractFileHeader(sf);
  const firstStmt = stmts[0]!;

  // Bucket by category
  const buckets: Record<Cat, Statement[]> = {
    [Cat.Import]: [],
    [Cat.Type]: [],
    [Cat.Const]: [],
    [Cat.Fn]: [],
  };
  for (const s of stmts) buckets[classify(s)]!.push(s);

  if (debug) {
    console.log(`  Header: ${header.text ? "yes" : "none"}`);
    for (const [cat, list] of Object.entries(buckets)) {
      const names = list.map((s) => getName(s) ?? "?").join(", ");
      console.log(`  ${CAT_NAMES[Number(cat)]}: ${list.length}${names ? ` (${names})` : ""}`);
    }
  }

  // Sort within categories
  const sortedConsts = sortDepsFirst(buckets[Cat.Const]!);
  const sortedFns = topoSortCallersFirst(buckets[Cat.Fn]!);

  if (debug) {
    if (sortedConsts.length > 0)
      console.log(`  Const order: ${sortedConsts.map((c) => getName(c) ?? "?").join(" → ")}`);
    if (sortedFns.length > 0)
      console.log(`  Fn order: ${sortedFns.map((f) => getName(f) ?? "?").join(" → ")}`);
  }

  // Split imports from re-exports (biome wants a blank line between them)
  const imports = buckets[Cat.Import]!.filter(
    (s) => !s.isKind(SyntaxKind.ExportDeclaration),
  );
  const reExports = buckets[Cat.Import]!.filter((s) =>
    s.isKind(SyntaxKind.ExportDeclaration),
  );

  // Assemble sections
  const sections: Statement[][] = [
    imports,
    reExports,
    buckets[Cat.Type]!,
    sortedConsts,
    sortedFns,
  ];

  const parts: string[] = [];
  if (header.text) parts.push(header.text + "\n");

  let prevSection = false;
  for (const section of sections) {
    if (section.length === 0) continue;
    if (prevSection) parts.push("\n"); // blank line between sections
    for (const stmt of section) {
      const skip = stmt === firstStmt && header.endPos > 0 ? header.endPos : undefined;
      const text = extractOwnText(stmt, skip);
      parts.push("\n" + text);
    }
    prevSection = true;
  }

  let result = parts.join("");
  result = result.replace(/\n{3,}/g, "\n\n"); // collapse 3+ newlines to 2
  result = result.replace(/^\n+/, "");         // no leading blank lines
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const sourceFile = project.addSourceFileAtPath(filePath);
const originalText = sourceFile.getFullText();

console.log(`Reordering: ${filePath}`);

// Run up to 2 passes to guarantee idempotency.
// The first pass may shift trivia boundaries; the second pass stabilizes them.
let current = originalText;
for (let pass = 1; pass <= 2; pass++) {
  const sf = pass === 1 ? sourceFile : project.createSourceFile("__temp__.ts", current, { overwrite: true });
  const result = reorderFile(sf);
  if (result === current) break;
  current = result;
}

if (current === originalText) {
  console.log("  No changes needed.");
  process.exit(0);
}

if (dryRun) {
  console.log("  Changes detected (dry-run).\n");
  console.log(current);
  process.exit(0);
}

sourceFile.replaceWithText(current);
sourceFile.saveSync();
console.log("  Saved.");
console.log("  Run: npm run build && npx biome check --write " + filePath);
