/**
 * Detect if-chains that should be switch statements.
 *
 * Flags sequences of 4+ consecutive `if` statements (or `if`/`else if`)
 * that all test the same variable with `===` against different constants.
 * These are clearer as `switch` (or a dispatch map).
 *
 * Detection rules:
 *   - 4+ consecutive if/else-if statements in the same block
 *   - Each condition is `variable === expr` (or `expr === variable`)
 *   - Same variable identifier across all branches
 *   - Ignores chains with <, >, <=, >=, != comparisons (those don't map to switch)
 *
 * Usage:
 *   deno run -A scripts/lint-if-chain.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --test              Include test/ files
 *   --min-branches N    Minimum branches to flag (default: 4)
 *   --update-baseline   Write current detections to baseline
 *
 * Baseline: .if-chain-baseline.json — entries are "file:line" keys.
 *
 * Exits 1 if non-baselined violations found.
 */

import fs from "node:fs";
import process from "node:process";
import { Node, Project, SyntaxKind } from "ts-morph";

interface IfChain {
  file: string;
  line: number;
  endLine: number;
  discriminant: string;
  branches: number;
  functionName: string | null;
}

interface ChainResult {
  discriminant: string;
  count: number;
}

const BASELINE_FILE = ".if-chain-baseline.json";

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const updateBaseline = args.includes("--update-baseline");
  const minIdx = args.indexOf("--min-branches");
  const minBranches = minIdx >= 0 ? Number(args[minIdx + 1]) : 4;

  const baseline = loadBaseline();
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  // ── Scan ───────────────────────────────────────────────────────

  const chains: IfChain[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");

    sourceFile.forEachDescendant((node) => {
      // Only check blocks (function bodies, if bodies, etc.)
      if (!Node.isBlock(node)) return;

      const stmts = node.getStatements();
      let idx = 0;

      while (idx < stmts.length) {
        const chain = tryExtractChain(stmts, idx);
        if (chain && chain.count >= minBranches) {
          const firstIf = stmts[idx]!;
          const lastIf = stmts[idx + chain.count - 1]!;

          // Find enclosing function name
          const fnName = findEnclosingFunctionName(firstIf);

          chains.push({
            file: relPath,
            line: firstIf.getStartLineNumber(),
            endLine: lastIf.getEndLineNumber(),
            discriminant: chain.discriminant,
            branches: chain.count,
            functionName: fnName,
          });
          idx += chain.count;
        } else {
          idx++;
        }
      }
    });
  }

  // Also check if/else-if chains (single IfStatement with alternates)
  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");

    sourceFile.forEachDescendant((node) => {
      if (!Node.isIfStatement(node)) return;
      // Skip if this is an else-if (already counted from the parent)
      const parent = node.getParent();
      if (Node.isIfStatement(parent)) return;

      const elseIfChain = extractElseIfChain(node);
      if (elseIfChain && elseIfChain.count >= minBranches) {
        // Check this chain isn't already reported as consecutive ifs
        const line = node.getStartLineNumber();
        const alreadyReported = chains.some(
          (ch) => ch.file === relPath && ch.line === line,
        );
        if (!alreadyReported) {
          chains.push({
            file: relPath,
            line,
            endLine: node.getEndLineNumber(),
            discriminant: elseIfChain.discriminant,
            branches: elseIfChain.count,
            functionName: findEnclosingFunctionName(node),
          });
        }
      }
    });
  }

  // ── Baseline ───────────────────────────────────────────────────

  if (updateBaseline) {
    const keys = chains.map(chainKey).sort();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(keys, null, 2) + "\n");
    console.log(`\u2714 Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    process.exit(0);
  }

  const newViolations = chains.filter((ch) => !baseline.has(chainKey(ch)));
  const currentKeys = new Set(chains.map(chainKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  // ── Report ─────────────────────────────────────────────────────

  const fileCount = project.getSourceFiles().length;

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselinedCount = chains.length;
    const suffix = baselinedCount > 0 ? `, ${baselinedCount} baselined` : "";
    console.log(
      `\u2714 No if-chain violations (${fileCount} files checked${suffix})`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    console.log(
      `\u2718 ${newViolations.length} if-chain(s) should be switch:\n`,
    );
    for (const ch of newViolations) {
      const fn = ch.functionName ? ` in ${ch.functionName}` : "";
      console.log(
        `  ${ch.file}:${ch.line}-${ch.endLine}: ${ch.branches} branches on \`${ch.discriminant}\`${fn}`,
      );
    }
  }

  if (staleEntries.length > 0) {
    console.log(
      `\n  \u2718 ${staleEntries.length} stale baseline entry/entries (remove from ${BASELINE_FILE}):\n`,
    );
    for (const key of staleEntries) {
      console.log(`  ${key}`);
    }
  }

  process.exit(1);
}

function chainKey(ch: IfChain): string {
  return `${ch.file}:${ch.functionName ?? "anonymous"}:${ch.discriminant}`;
}

function loadBaseline(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    return new Set(raw as string[]);
  } catch {
    return new Set();
  }
}

function findEnclosingFunctionName(node: Node): string | null {
  let current = node.getParent();
  while (current) {
    if (Node.isFunctionDeclaration(current)) {
      return current.getName() ?? null;
    }
    if (Node.isMethodDeclaration(current)) {
      return current.getName();
    }
    if (Node.isArrowFunction(current)) {
      const parent = current.getParent();
      if (parent && Node.isVariableDeclaration(parent)) {
        return parent.getName();
      }
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Try to extract a chain of consecutive `if (x === CONST)` statements
 * starting at index `start`. Returns the discriminant and count, or null.
 */
function tryExtractChain(
  stmts: ReturnType<Node<import("ts-morph").ts.Block>["getStatements"]>,
  start: number,
): ChainResult | null {
  const first = stmts[start];
  if (!first || !Node.isIfStatement(first)) return null;

  const firstDisc = extractStrictEqualityDiscriminant(first);
  if (!firstDisc) return null;

  let count = 1;
  for (let idx = start + 1; idx < stmts.length; idx++) {
    const stmt = stmts[idx]!;
    if (!Node.isIfStatement(stmt)) break;
    const disc = extractStrictEqualityDiscriminant(stmt);
    if (!disc || disc !== firstDisc) break;
    count++;
  }

  return count >= 2 ? { discriminant: firstDisc, count } : null;
}

/**
 * Walk an if/else-if chain (single IfStatement with else-if alternates)
 * and check if all branches test the same variable with ===.
 */
function extractElseIfChain(node: Node): ChainResult | null {
  if (!Node.isIfStatement(node)) return null;

  const branches: Node[] = [];
  let current: Node | undefined = node;

  while (current && Node.isIfStatement(current)) {
    branches.push(current);
    const elseStmt = current.getElseStatement();
    current = elseStmt && Node.isIfStatement(elseStmt) ? elseStmt : undefined;
  }

  if (branches.length < 2) return null;

  let discriminant: string | null = null;
  for (const branch of branches) {
    if (!Node.isIfStatement(branch)) return null;
    const disc = extractStrictEqualityDiscriminant(branch);
    if (!disc) return null;
    if (discriminant === null) {
      discriminant = disc;
    } else if (disc !== discriminant) {
      return null;
    }
  }

  return discriminant ? { discriminant, count: branches.length } : null;
}

/**
 * Extract the discriminant variable from an if-statement's condition,
 * if the condition is `variable === expr` or `expr === variable`.
 * Returns the variable name, or null if the pattern doesn't match.
 */
function extractStrictEqualityDiscriminant(ifStmt: Node): string | null {
  if (!Node.isIfStatement(ifStmt)) return null;
  const condition = ifStmt.getExpression();

  // Direct: x === Y
  const direct = extractFromBinaryEquals(condition);
  if (direct) return direct;

  // Negated: !(x === Y) — unlikely but handle
  // Logical OR: x === A || x === B — count as 1 branch on x
  // For now, only handle the simple case
  return null;
}

/**
 * Given a BinaryExpression with ===, return the identifier side.
 * Returns the identifier text, or null if neither side is a simple identifier
 * or property access chain.
 */
function extractFromBinaryEquals(expr: Node): string | null {
  if (!Node.isBinaryExpression(expr)) return null;

  const op = expr.getOperatorToken();
  if (
    op.getKind() !== SyntaxKind.EqualsEqualsEqualsToken &&
    op.getKind() !== SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return null;
  }

  const left = expr.getLeft();
  const right = expr.getRight();

  // Prefer the side that looks like a variable (identifier or property access)
  // over the side that looks like a constant (enum member, string literal, etc.)
  const leftVar = extractVariableName(left);
  const rightVar = extractVariableName(right);

  if (leftVar && !rightVar) return leftVar;
  if (rightVar && !leftVar) return rightVar;

  // Both are identifiers — pick the shorter one (heuristic: constants are longer)
  if (leftVar && rightVar) {
    return leftVar.length <= rightVar.length ? leftVar : rightVar;
  }

  return null;
}

/**
 * Extract a variable name from a node that could be:
 * - An Identifier: `x`
 * - A PropertyAccessExpression: `state.modern?.activeModifier`
 * - An optional chain: `state.modern?.activeModifier`
 *
 * Returns null for literals, call expressions, etc.
 */
function extractVariableName(node: Node): string | null {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isPropertyAccessExpression(node)) return node.getText();

  // Handle non-null assertion: `x!`
  if (Node.isNonNullExpression(node)) {
    return extractVariableName(node.getExpression());
  }

  // Handle parenthesized: `(x)`
  if (Node.isParenthesizedExpression(node)) {
    return extractVariableName(node.getExpression());
  }

  return null;
}
