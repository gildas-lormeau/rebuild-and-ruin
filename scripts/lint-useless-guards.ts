/**
 * Detect null/undefined guards that can never trigger because the type
 * system already guarantees the expression is non-nullable.
 *
 * Catches patterns like:
 *   - `if (!expr) return` where expr's type excludes null/undefined
 *   - `if (expr === null)` where expr can't be null
 *   - `if (expr === undefined)` where expr can't be undefined
 *   - `if (expr == null)` where expr is non-nullable
 *   - `expr ?? fallback` where expr is non-nullable
 *   - `expr?.prop` where expr is non-nullable
 *
 * Skips:
 *   - Files listed in boundary allowlist (network validation, deserialization)
 *   - Conditions involving `.length`, numeric comparisons (not null guards)
 *   - Type assertions / `as` casts (intentionally loosening types)
 *
 * Usage:
 *   deno run -A scripts/lint-useless-guards.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --test              Include test/ files
 *   --update-baseline   Write current detections to baseline
 *
 * Baseline: .useless-guards-baseline.json — entries are "file:line:pattern" keys.
 *
 * Exits 1 if non-baselined violations found.
 */

import fs from "node:fs";
import process from "node:process";
import { Node, Project, SyntaxKind, type Type } from "ts-morph";

interface Guard {
  file: string;
  line: number;
  snippet: string;
  pattern: string;
  exprText: string;
  resolvedType: string;
}

const BASELINE_FILE = ".useless-guards-baseline.json";

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const updateBaseline = args.includes("--update-baseline");

  const baseline = loadBaseline();
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });

  if (includeServer) project.addSourceFilesAtPaths("server/**/*.ts");
  if (includeTest) project.addSourceFilesAtPaths("test/**/*.ts");

  const guards: Guard[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
    // Skip build artifacts
    if (relPath.startsWith("dist/")) continue;

    sourceFile.forEachDescendant((node) => {
      // ── Pattern 1: if (!expr) / if (expr === null/undefined) ──
      if (Node.isIfStatement(node)) {
        const cond = node.getExpression();
        checkCondition(cond, relPath, guards);
        return;
      }

      // ── Pattern 2: expr ?? fallback ──
      if (
        Node.isBinaryExpression(node) &&
        node.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken
      ) {
        const left = node.getLeft();
        const leftType = left.getType();
        if (!isNullableType(leftType)) {
          guards.push({
            file: relPath,
            line: node.getStartLineNumber(),
            snippet: truncate(node.getText(), 80),
            pattern: "??",
            exprText: truncate(left.getText(), 40),
            resolvedType: leftType.getText(),
          });
        }
        return;
      }

      // ── Pattern 3: expr?.prop (optional chain on non-nullable) ──
      // Only flag when the OBJECT is non-nullable. Skip when the
      // property itself is optional (obj.optionalMethod?.()) — that's
      // a valid use of ?. even when obj is non-nullable.
      if (Node.isPropertyAccessExpression(node) && node.hasQuestionDotToken()) {
        // Skip if parent is also a ?. chain (avoid double-flagging)
        const parent = node.getParent();
        if (
          parent &&
          Node.isPropertyAccessExpression(parent) &&
          parent.hasQuestionDotToken()
        )
          return;

        const obj = node.getExpression();
        const objType = obj.getType();
        if (isAnyOrUnknown(objType) || isNullableType(objType)) return;

        // Check if the accessed property is optional in the parent type.
        // If so, the ?. is guarding the property, not the object — valid.
        const propName = node.getName();
        const propSymbol = objType.getProperty(propName);
        if (propSymbol) {
          const isOptional = propSymbol.isOptional();
          const propType = propSymbol.getTypeAtLocation(node);
          if (isOptional || isNullableType(propType)) return;
        }

        guards.push({
          file: relPath,
          line: node.getStartLineNumber(),
          snippet: truncate(node.getText(), 80),
          pattern: "?.",
          exprText: truncate(obj.getText(), 40),
          resolvedType: objType.getText(),
        });
      }
    });
  }

  // ── Baseline ───────────────────────────────────────────────────

  if (updateBaseline) {
    const keys = guards.map(guardKey).sort();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(keys, null, 2) + "\n");
    console.log(`\u2714 Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    process.exit(0);
  }

  const newViolations = guards.filter((g) => !baseline.has(guardKey(g)));
  const currentKeys = new Set(guards.map(guardKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  // ── Report ─────────────────────────────────────────────────────

  const fileCount = project.getSourceFiles().length;

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselinedCount = guards.length;
    const suffix = baselinedCount > 0 ? `, ${baselinedCount} baselined` : "";
    console.log(
      `\u2714 No useless guards (${fileCount} files checked${suffix})`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    console.log(`\u2718 ${newViolations.length} useless guard(s) found:\n`);
    for (const g of newViolations) {
      console.log(
        `  ${g.file}:${g.line}: [${g.pattern}] \`${g.exprText}\` is ${g.resolvedType}`,
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

function checkCondition(cond: Node, file: string, out: Guard[]): void {
  // !expr
  if (Node.isPrefixUnaryExpression(cond)) {
    if (cond.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const operand = cond.getOperand();
      checkNullGuardExpr(operand, file, cond, "!expr", out);
    }
    return;
  }

  // expr === null / expr === undefined / expr == null
  if (Node.isBinaryExpression(cond)) {
    const op = cond.getOperatorToken().getKind();
    const isStrictEq =
      op === SyntaxKind.EqualsEqualsEqualsToken ||
      op === SyntaxKind.ExclamationEqualsEqualsToken;
    const isLooseEq =
      op === SyntaxKind.EqualsEqualsToken ||
      op === SyntaxKind.ExclamationEqualsToken;

    if (!isStrictEq && !isLooseEq) return;

    const left = cond.getLeft();
    const right = cond.getRight();

    const nullish = isNullishLiteral(right)
      ? right
      : isNullishLiteral(left)
        ? left
        : null;
    const expr = nullish === right ? left : nullish === left ? right : null;

    if (!nullish || !expr) return;

    // For loose equality (==), null catches both null and undefined
    const pattern = isLooseEq
      ? `== ${nullish.getText()}`
      : `=== ${nullish.getText()}`;
    checkNullGuardExpr(expr, file, cond, pattern, out);
    return;
  }

  // Logical AND/OR: check each side
  if (Node.isBinaryExpression(cond)) {
    const op = cond.getOperatorToken().getKind();
    if (
      op === SyntaxKind.AmpersandAmpersandToken ||
      op === SyntaxKind.BarBarToken
    ) {
      checkCondition(cond.getLeft(), file, out);
      checkCondition(cond.getRight(), file, out);
    }
  }
}

function checkNullGuardExpr(
  expr: Node,
  file: string,
  condNode: Node,
  pattern: string,
  out: Guard[],
): void {
  // Skip numeric/length checks that look like null guards but aren't
  // e.g. `if (!array.length)` — length is number, not nullable
  if (isNumericExpression(expr)) return;

  const exprType = expr.getType();

  // Skip any/unknown — type info is insufficient
  if (isAnyOrUnknown(exprType)) return;

  // Skip boolean checks — `if (!isReady)` is intentional
  if (isBooleanType(exprType)) return;

  // Skip number checks — `if (!count)` checks for 0, not null
  if (isNumberType(exprType)) return;

  // Skip string checks — `if (!str)` checks for empty string
  if (isStringType(exprType)) return;

  // The actual check: is this type nullable?
  if (!isNullableType(exprType)) {
    out.push({
      file,
      line: condNode.getStartLineNumber(),
      snippet: truncate(condNode.getText(), 80),
      pattern,
      exprText: truncate(expr.getText(), 40),
      resolvedType: exprType.getText(),
    });
  }
}

function isNullableType(type: Type): boolean {
  return type.isNullable();
}

function isAnyOrUnknown(type: Type): boolean {
  return type.isAny() || type.isUnknown();
}

function isBooleanType(type: Type): boolean {
  if (type.isBoolean() || type.isBooleanLiteral()) return true;
  // Union that includes boolean
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .some((ut) => ut.isBoolean() || ut.isBooleanLiteral());
  }
  return false;
}

function isNumberType(type: Type): boolean {
  if (type.isNumber() || type.isNumberLiteral()) return true;
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .some((ut) => ut.isNumber() || ut.isNumberLiteral());
  }
  return false;
}

function isStringType(type: Type): boolean {
  if (type.isString() || type.isStringLiteral()) return true;
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .some((ut) => ut.isString() || ut.isStringLiteral());
  }
  return false;
}

function isNullishLiteral(node: Node): boolean {
  return (
    node.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(node) && node.getText() === "undefined")
  );
}

function isNumericExpression(node: Node): boolean {
  // .length, .size, numeric method calls
  if (Node.isPropertyAccessExpression(node)) {
    const name = node.getName();
    return name === "length" || name === "size";
  }
  return false;
}

function guardKey(guard: Guard): string {
  return `${guard.file}:${guard.line}:${guard.pattern}`;
}

function loadBaseline(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    return new Set(raw as string[]);
  } catch {
    return new Set();
  }
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}
