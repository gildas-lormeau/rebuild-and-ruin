/**
 * lint-repeated-ternary — flag functions that branch on the same condition
 * via 3+ separate ternary expressions.
 *
 * Pattern:
 *
 *     const iRow = vertical ? interior : cross;
 *     const iCol = vertical ? cross : interior;
 *     const rRow = vertical ? ring : cross;
 *     const rCol = vertical ? cross : ring;
 *
 * Five `vertical ?` ternaries doing axis projection. The fix is a tiny
 * helper (`cellAt(line, cross, vertical) → [row, col]`) — the function
 * goes from "branchy" to "uses an axis helper." The same shape appears
 * with `host ? "host" : "watcher"` selection, mode dispatch, and
 * `vertical/diagonal/horizontal` axis switches.
 *
 * Catches the pattern at its source — earlier and more precisely than
 * cognitive-complexity does, because CC sees only "function is branchy"
 * while this sees "same test branched on N times" with the test text
 * quoted in the diagnostic.
 *
 * What counts as the "same condition" (canonical text after whitespace
 * normalization):
 *   - bare identifier: `vertical`
 *   - property access: `state.online`, `ctx.vertical`
 *   - `!ident` and `!prop` (negation kept, so `vertical?` and `!vertical?`
 *     are distinct — they're sibling cases of the same selector)
 *
 * Ternaries inside nested fn / arrow bodies are scoped to those inner
 * functions, not the outer one — same rule used by audit-stale-snapshot.
 *
 * Allowed patterns (not flagged):
 *   - `// lint:allow-repeated-ternary -- <reason>` on the same line as
 *     the third+ ternary or in the leading comment block above the
 *     function declaration.
 *
 * Scope:
 *   src/**\/*.ts (excluding *.d.ts and *.test.ts)
 *
 * Usage:
 *   deno run -A scripts/lint-repeated-ternary.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

interface Violation {
  file: string;
  fnLine: number;
  fnName: string;
  conditionText: string;
  occurrences: number;
  lines: number[];
}

type FnLike =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

const ROOT = path.resolve(import.meta.dirname!, "..");
const SRC_DIR = path.join(ROOT, "src");
const DEV_DIR = path.join(ROOT, "dev");
const THRESHOLD = 3;
const ALLOW_MARKER = /lint:allow-repeated-ternary/;

main();

function main(): void {
  const files = [
    ...collectSourceFiles(SRC_DIR),
    ...collectSourceFiles(DEV_DIR),
  ];
  if (files.length === 0) {
    console.log("✔ No source files to scan");
    process.exit(0);
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of files) project.addSourceFileAtPath(file);

  const violations: Violation[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    scanFile(sourceFile, violations);
  }

  if (violations.length === 0) {
    console.log(
      `✔ No repeated-ternary patterns (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `✘ ${violations.length} function(s) with 3+ ternaries on the same condition:\n`,
  );
  for (const v of violations) {
    console.log(
      `  ${v.file}:${v.fnLine}  ${v.fnName}()  — \`${v.conditionText}\` ternary ×${v.occurrences} at L${v.lines.join(", L")}`,
    );
  }
  console.log("");
  console.log("Lift a tiny helper that takes the condition as a parameter and");
  console.log("returns the per-branch value, e.g.");
  console.log("  function cellAt(line, cross, vertical) {");
  console.log("    return vertical ? [line, cross] : [cross, line];");
  console.log("  }");
  console.log("");
  console.log("Or annotate intentional cases with");
  console.log("  // lint:allow-repeated-ternary -- <reason>");
  process.exit(1);
}

function scanFile(sourceFile: SourceFile, out: Violation[]): void {
  const relPath = path.relative(ROOT, sourceFile.getFilePath());
  const rawLines = sourceFile.getFullText().split("\n");

  const fns: FnLike[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];

  for (const fn of fns) {
    const body = fn.getBody?.();
    if (!body || !Node.isBlock(body)) continue;
    const counts = new Map<string, number[]>();
    for (const ternary of body.getDescendantsOfKind(
      SyntaxKind.ConditionalExpression,
    )) {
      if (!isDirectlyInFn(ternary, fn)) continue;
      const condText = canonicalConditionText(ternary.getCondition());
      if (!condText) continue;
      const line = ternary.getStartLineNumber();
      const list = counts.get(condText) ?? [];
      list.push(line);
      counts.set(condText, list);
    }
    for (const [condText, lines] of counts) {
      if (lines.length < THRESHOLD) continue;
      const fnLine = fn.getStartLineNumber();
      if (hasAllowMarker(rawLines, fnLine - 1)) continue;
      const lastLine = lines[lines.length - 1]!;
      if (hasAllowMarker(rawLines, lastLine - 1)) continue;
      out.push({
        file: relPath,
        fnLine,
        fnName: fnDisplayName(fn),
        conditionText: condText,
        occurrences: lines.length,
        lines,
      });
    }
  }
}

/** True iff `node` is inside `fn` and not inside any nested function/arrow
 *  body that itself sits inside `fn`. Mirrors the closure-skip logic used
 *  by audit-stale-snapshot. */
function isDirectlyInFn(node: Node, fn: FnLike): boolean {
  let cursor: Node | undefined = node.getParent();
  while (cursor && cursor !== fn) {
    if (
      Node.isArrowFunction(cursor) ||
      Node.isFunctionExpression(cursor) ||
      Node.isFunctionDeclaration(cursor) ||
      Node.isMethodDeclaration(cursor)
    ) {
      return false;
    }
    cursor = cursor.getParent();
  }
  return cursor === fn;
}

/** Canonical text for a ternary's condition. Returns null for conditions
 *  the lint deliberately ignores (binary expressions, calls — too varied
 *  to be a reliable "same selector" signal). */
function canonicalConditionText(condition: Node): string | null {
  if (Node.isIdentifier(condition)) return condition.getText();
  if (Node.isPropertyAccessExpression(condition)) return condition.getText();
  if (Node.isPrefixUnaryExpression(condition)) {
    if (condition.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const operand = condition.getOperand();
      const inner = canonicalConditionText(operand);
      if (inner) return `!${inner}`;
    }
  }
  return null;
}

function fnDisplayName(fn: FnLike): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? "<anonymous>";
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return "<arrow>";
}

function hasAllowMarker(rawLines: readonly string[], idx: number): boolean {
  if (idx < 0 || idx >= rawLines.length) return false;
  if (ALLOW_MARKER.test(rawLines[idx]!)) return true;
  for (let i = idx - 1; i >= 0; i--) {
    const trimmed = rawLines[i]!.trim();
    if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) return false;
    if (ALLOW_MARKER.test(trimmed)) return true;
  }
  return false;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const entryStat = statSync(full, { throwIfNoEntry: false });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entryStat.isFile()) continue;
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}
