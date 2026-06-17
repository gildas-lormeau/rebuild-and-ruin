/**
 * Detect guards that can never trigger because the type system already
 * proves the result. Two classes:
 *
 * Null/undefined guards on non-nullable types:
 *   - `if (!expr) return` where expr's type excludes null/undefined
 *   - `if (expr === null)` where expr can't be null
 *   - `if (expr === undefined)` where expr can't be undefined
 *   - `if (expr == null)` where expr is non-nullable
 *   - `expr ?? fallback` where expr is non-nullable
 *   - `expr?.prop` where expr is non-nullable
 *
 * Literal-compare against a value the type can't hold:
 *   - `expr === false` where expr is `true | undefined`
 *   - `expr !== "foo"` where expr is `"bar" | "baz"`
 *   - `expr === 5` where expr is `1 | 2 | 3`
 *
 * The literal-compare class catches the cascading dead branches that
 * appear after a type is narrowed (e.g. `Cannon.mortar` from
 * `?: boolean` to `?: true` makes any `=== false` check unreachable).
 *
 * Skips:
 *   - Files listed in boundary allowlist (network validation, deserialization)
 *   - Conditions involving `.length`, numeric comparisons (not null guards)
 *   - Type assertions / `as` casts (intentionally loosening types)
 *   - Wide-primitive types (`string`, `number`, `boolean`) — every literal
 *     of the right primitive is reachable, so no enforcement
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

      // ── Pattern 4: expr === <literal> / expr !== <literal> ──
      // Wherever it appears (if-test, ternary cond, assignment, etc.).
      // Nullish-literal compares are handled by checkCondition above; this
      // pass focuses on boolean / string / number literal compares whose
      // result is statically determined by the type union.
      if (Node.isBinaryExpression(node)) {
        const op = node.getOperatorToken().getKind();
        if (
          op === SyntaxKind.EqualsEqualsEqualsToken ||
          op === SyntaxKind.ExclamationEqualsEqualsToken
        ) {
          checkLiteralCompare(node, relPath, guards);
        }
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

/** Check `expr === <literal>` / `expr !== <literal>` where the literal
 *  isn't reachable in expr's type. Skips nullish literals (handled by
 *  checkCondition) and wide primitives (every literal is reachable). */
function checkLiteralCompare(cond: Node, file: string, out: Guard[]): void {
  if (!Node.isBinaryExpression(cond)) return;
  const left = cond.getLeft();
  const right = cond.getRight();
  const leftType = left.getType();
  const rightType = right.getType();
  const leftLit = isComparableLiteral(leftType);
  const rightLit = isComparableLiteral(rightType);
  // Exactly one side must be a literal — comparisons between two literals
  // or two non-literals aren't this pattern.
  if (leftLit === rightLit) return;
  const litType = rightLit ? rightType : leftType;
  const exprSide = rightLit ? left : right;
  const exprType = exprSide.getType();
  // Nullish literals: `null` is special-cased to `undefined | null`-like
  // semantics in checkCondition; skip to avoid duplicate flagging.
  if (litType.isNull() || litType.isUndefined()) return;
  if (isAnyOrUnknown(exprType)) return;
  // Skip when expr's type accepts the litType's whole primitive — every
  // literal of that primitive is reachable so no enforcement is possible.
  // ts-morph expands `boolean` into `true | false` internally, so we
  // detect this by checking for a wide-primitive member alongside any
  // literal members.
  if (acceptsAnyOfPrimitive(exprType, litType)) return;
  // The actual check: can the literal value match any reachable value
  // of expr's type? Compares by underlying VALUE not by nominal type so
  // string-valued enums (`CannonMode.BALLOON` ≠ `"balloon"` nominally,
  // but they share the runtime value) don't false-positive.
  if (litCanMatchExprValues(exprType, litType)) return;
  const op = cond.getOperatorToken().getKind();
  const operator = op === SyntaxKind.EqualsEqualsEqualsToken ? "===" : "!==";
  out.push({
    file,
    line: cond.getStartLineNumber(),
    snippet: truncate(cond.getText(), 80),
    pattern: `${operator} ${litType.getText()}`,
    exprText: truncate(exprSide.getText(), 40),
    resolvedType: exprType.getText(),
  });
}

/** True when `type` is a literal type the lint can compare against —
 *  boolean/string/number literals only. Wide primitives and complex
 *  types return false. */
function isComparableLiteral(type: Type): boolean {
  return (
    type.isBooleanLiteral() || type.isStringLiteral() || type.isNumberLiteral()
  );
}

/** True when `litType`'s value matches any literal member of `exprType`,
 *  comparing by underlying value rather than nominal type. Handles
 *  string-valued enums where `CannonMode.BALLOON` and `"balloon"` are
 *  distinct nominal types but share the same runtime value. */
function litCanMatchExprValues(exprType: Type, litType: Type): boolean {
  const litValue = literalValueOf(litType);
  if (litValue === undefined) return false;
  return walkUnion(exprType, (member) => literalValueOf(member) === litValue);
}

/** Extract the runtime value of a literal type. ts-morph's
 *  `getLiteralValue()` covers string + number literals but not booleans;
 *  for booleans we fall back to the type's text. Returns undefined for
 *  non-literal types. */
function literalValueOf(type: Type): boolean | string | number | undefined {
  if (type.isBooleanLiteral()) {
    const text = type.getText();
    if (text === "true") return true;
    if (text === "false") return false;
    return undefined;
  }
  if (type.isStringLiteral() || type.isNumberLiteral()) {
    return type.getLiteralValue();
  }
  return undefined;
}

function walkUnion(type: Type, visit: (member: Type) => boolean): boolean {
  if (type.isUnion()) {
    return type.getUnionTypes().some((member) => walkUnion(member, visit));
  }
  return visit(type);
}

/** True when `exprType` accepts every literal of `litType`'s primitive —
 *  e.g. `boolean | "interactive"` accepts every boolean literal because
 *  it contains the wide `boolean`. Detection is needed because ts-morph
 *  expands top-level `boolean` into a `true | false` union; the only
 *  reliable signal that a wide primitive is reachable is BOTH literal
 *  endpoints (sawTrue + sawFalse) or the explicit primitive type. */
function acceptsAnyOfPrimitive(exprType: Type, litType: Type): boolean {
  if (litType.isBooleanLiteral()) return acceptsAnyBoolean(exprType);
  if (litType.isStringLiteral()) return acceptsAnyString(exprType);
  if (litType.isNumberLiteral()) return acceptsAnyNumber(exprType);
  return false;
}

function acceptsAnyBoolean(type: Type): boolean {
  if (isWideBoolean(type)) return true;
  // Branded boolean (`boolean & { __owned }`) holds any boolean at runtime.
  if (type.isIntersection())
    return type.getIntersectionTypes().some(acceptsAnyBoolean);
  if (!type.isUnion()) return false;
  let sawTrue = false;
  let sawFalse = false;
  for (const member of type.getUnionTypes()) {
    if (acceptsAnyBoolean(member)) return true;
    if (member.isBooleanLiteral()) {
      if (member.getText() === "true") sawTrue = true;
      else if (member.getText() === "false") sawFalse = true;
    }
  }
  return sawTrue && sawFalse;
}

function acceptsAnyString(type: Type): boolean {
  if (isWideString(type)) return true;
  // Branded string (`string & { __brand }`) holds any string at runtime.
  if (type.isIntersection())
    return type.getIntersectionTypes().some(acceptsAnyString);
  if (!type.isUnion()) return false;
  return type.getUnionTypes().some(acceptsAnyString);
}

function acceptsAnyNumber(type: Type): boolean {
  if (isWideNumber(type)) return true;
  // Branded number (`number & { __owned }`, e.g. Lives / Round) holds any
  // number at runtime, so `=== <literal>` / `!== <literal>` is a real check.
  if (type.isIntersection())
    return type.getIntersectionTypes().some(acceptsAnyNumber);
  if (!type.isUnion()) return false;
  return type.getUnionTypes().some(acceptsAnyNumber);
}

function isWideBoolean(type: Type): boolean {
  return type.isBoolean() && !type.isBooleanLiteral();
}

function isWideString(type: Type): boolean {
  return type.isString() && !type.isStringLiteral();
}

function isWideNumber(type: Type): boolean {
  return type.isNumber() && !type.isNumberLiteral();
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
