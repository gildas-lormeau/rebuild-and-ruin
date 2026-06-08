/**
 * Audit assignments that don't change observable state.
 * AUDIT-ONLY: no baseline, no exit code logic.
 *
 * Three patterns:
 *
 * SELF_ASSIGN — `x = x`, `obj.k = obj.k`, `arr[i] = arr[i]`. The LHS and
 *   RHS expression text are identical. Always a dead write (modulo
 *   getter/setter side effects, which are rare in this codebase).
 *
 * NULLISH_SELF — `x ??= undefined` / `x ??= null`. `??=` writes only when
 *   the LHS is nullish; the new value is also nullish, so this is a
 *   guaranteed no-op.
 *
 * DEAD_GUARD — `if (<expr>) <expr> = <falsy>` (no else), where the guard
 *   excludes the falsy value being assigned. The simplification is to
 *   delete the guard (the unguarded write is equivalent). Forms covered:
 *     if (X) X = undefined          // X type includes undefined
 *     if (X) X = null               // X type includes null
 *     if (X !== undefined) X = undefined
 *     if (X !== null) X = null
 *     if (X != null) X = undefined  // X type must include undefined
 *     if (X != null) X = null       // X type must include null
 *
 * Skips:
 *   - Truthy guards on numeric/string types where the assigned value
 *     might be the only excluded value (e.g. `if (x) x = 0` on
 *     `0 | 1 | 2 | undefined` is NOT a dead guard; we don't claim
 *     `0` ⊆ excluded without flow analysis).
 *   - Inverse guards (`if (!X) X = X`) and `||=`/`&&=` patterns —
 *     surfaced rarely, high FP rate. Out of scope for v1.
 *
 * Known false-positive class: getter/setter properties or Proxies whose
 *   write triggers side effects intentionally. The codebase has none
 *   today; the audit doesn't try to detect them.
 *
 * Usage:
 *   deno run -A scripts/audit-no-op-writes.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON instead of human-readable
 *   --filter=<re>    Only show findings whose file path matches the regex
 */

import process from "node:process";
import {
  type BinaryExpression,
  type IfStatement,
  Node,
  Project,
  SyntaxKind,
} from "ts-morph";

type Pattern = "SELF_ASSIGN" | "NULLISH_SELF" | "DEAD_GUARD";

interface Finding {
  file: string;
  line: number;
  pattern: Pattern;
  text: string;
  detail: string;
}

interface ParsedGuard {
  lhsText: string;
  excluded: Set<"undefined" | "null">;
  kind: "truthy" | "compare";
  compareOp?: string;
  compareTo?: string;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const json = args.includes("--json");
  const filterArg = args.find((arg) => arg.startsWith("--filter="));
  const filter = filterArg
    ? new RegExp(filterArg.slice("--filter=".length))
    : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts", "dev/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    if (filter && !filter.test(relPath)) continue;

    for (const node of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const f = checkAssignment(node, relPath);
      if (f) findings.push(f);
    }
    for (const node of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
      const f = checkDeadGuard(node, relPath);
      if (f) findings.push(f);
    }
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;

  if (findings.length === 0) {
    console.log(`✔ No no-op writes found (${fileCount} files audited)`);
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${findings.length} suspect write(s):\n`,
  );

  for (const pattern of [
    "SELF_ASSIGN",
    "NULLISH_SELF",
    "DEAD_GUARD",
  ] as const) {
    const list = findings.filter((f) => f.pattern === pattern);
    if (list.length === 0) continue;
    console.log(
      `── ${pattern} (${list.length}) ──────────────────────────────`,
    );
    list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    let lastFile = "";
    for (const f of list) {
      if (f.file !== lastFile) {
        console.log(`\n  ${f.file}`);
        lastFile = f.file;
      }
      console.log(`    :${f.line}  ${truncate(f.text, 80)}`);
      console.log(`           ${f.detail}`);
    }
    console.log("");
  }
}

function checkAssignment(node: BinaryExpression, file: string): Finding | null {
  const op = node.getOperatorToken().getKind();
  const lhs = node.getLeft();
  const rhs = node.getRight();

  if (op === SyntaxKind.EqualsToken) {
    if (lhs.getText() !== rhs.getText()) return null;
    return {
      file,
      line: node.getStartLineNumber(),
      pattern: "SELF_ASSIGN",
      text: truncate(node.getText(), 80),
      detail: "LHS and RHS textually identical",
    };
  }

  if (op === SyntaxKind.QuestionQuestionEqualsToken) {
    const rhsKind = parseNullishLiteral(rhs);
    if (!rhsKind) return null;
    return {
      file,
      line: node.getStartLineNumber(),
      pattern: "NULLISH_SELF",
      text: truncate(node.getText(), 80),
      detail: `??= ${rhsKind} writes a nullish value when LHS is nullish`,
    };
  }

  return null;
}

function checkDeadGuard(node: IfStatement, file: string): Finding | null {
  if (node.getElseStatement()) return null;

  const cond = node.getExpression();
  const guard = parseGuard(cond);
  if (!guard) return null;

  const then = node.getThenStatement();
  let exprStmt: Node | undefined;
  if (Node.isBlock(then)) {
    const stmts = then.getStatements();
    if (stmts.length !== 1) return null;
    exprStmt = stmts[0];
  } else {
    exprStmt = then;
  }
  if (!exprStmt || !Node.isExpressionStatement(exprStmt)) return null;

  const expr = exprStmt.getExpression();
  if (!Node.isBinaryExpression(expr)) return null;
  if (expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return null;

  const lhs = expr.getLeft();
  const rhs = expr.getRight();
  if (lhs.getText() !== guard.lhsText) return null;

  const rhsKind = parseNullishLiteral(rhs);
  if (!rhsKind) return null;
  if (!guard.excluded.has(rhsKind)) return null;

  // Type-check: the LHS type must include the assigned nullish value, or
  // TypeScript wouldn't accept the unguarded write either.
  const lhsType = lhs.getType();
  if (!typeIncludesNullish(lhsType, rhsKind)) return null;

  const guardSummary =
    guard.kind === "truthy"
      ? `if (${guard.lhsText})`
      : `if (${guard.lhsText} ${guard.compareOp} ${guard.compareTo})`;

  return {
    file,
    line: node.getStartLineNumber(),
    pattern: "DEAD_GUARD",
    text: truncate(node.getText().replace(/\s+/g, " "), 100),
    detail: `${guardSummary} guard excludes ${rhsKind}; unguarded \`${guard.lhsText} = ${rhsKind}\` is equivalent`,
  };
}

function parseGuard(cond: Node): ParsedGuard | null {
  if (
    Node.isIdentifier(cond) ||
    Node.isPropertyAccessExpression(cond) ||
    Node.isElementAccessExpression(cond)
  ) {
    return {
      lhsText: cond.getText(),
      excluded: new Set(["undefined", "null"]),
      kind: "truthy",
    };
  }

  if (!Node.isBinaryExpression(cond)) return null;
  const op = cond.getOperatorToken().getKind();
  const isStrict = op === SyntaxKind.ExclamationEqualsEqualsToken;
  const isLoose = op === SyntaxKind.ExclamationEqualsToken;
  if (!isStrict && !isLoose) return null;

  const left = cond.getLeft();
  const right = cond.getRight();
  const leftLit = parseNullishLiteral(left);
  const rightLit = parseNullishLiteral(right);
  if (!leftLit && !rightLit) return null;
  if (leftLit && rightLit) return null;

  const lhs = leftLit ? right : left;
  const lit = leftLit ?? rightLit!;

  // X != null / null != X excludes both nullish values.
  if (isLoose) {
    return {
      lhsText: lhs.getText(),
      excluded: new Set(["undefined", "null"]),
      kind: "compare",
      compareOp: "!=",
      compareTo: lit,
    };
  }
  return {
    lhsText: lhs.getText(),
    excluded: new Set([lit]),
    kind: "compare",
    compareOp: "!==",
    compareTo: lit,
  };
}

function parseNullishLiteral(node: Node): "undefined" | "null" | null {
  if (node.getKind() === SyntaxKind.NullKeyword) return "null";
  if (Node.isIdentifier(node) && node.getText() === "undefined") {
    return "undefined";
  }
  return null;
}

function typeIncludesNullish(
  type: { getText(): string },
  kind: "undefined" | "null",
): boolean {
  const text = type.getText();
  // Cheap string check — if the union prints with the keyword, the type
  // contains it. False positives possible (e.g. literal types like
  // `"undefined"`) but vanishingly rare for nullish kinds.
  if (kind === "undefined") return /\bundefined\b/.test(text);
  return /\bnull\b/.test(text);
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}
