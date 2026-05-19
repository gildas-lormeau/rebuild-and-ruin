/**
 * Audit-only sibling to lint:passthrough. Catches looser passthrough
 * patterns the strict lint misses (because they're multi-caller, or
 * because the body shape is wider than ARG_PASSTHROUGH allows):
 *
 *   PROPERTY_GETTER  — `(obj) => obj.x.y` or
 *                      `function getX(obj) { return obj.x.y; }`
 *                      Single-arg wrapper returning a property-access
 *                      chain rooted at that arg. Often LLM-ceremonial:
 *                      multi-caller wrappers that save few chars over
 *                      direct property access. lint:passthrough's
 *                      SINGLE_CALLER only catches the 1-caller case.
 *
 *   CONSTANT_PARTIAL — `(a, b) => foo(a, b, CONST1, CONST2)`
 *                      All wrapper params forwarded in order as the
 *                      first N args; the remainder are literals or
 *                      qualified-name references (e.g. `Phase.BATTLE`).
 *                      Currying-style indirection. The strict
 *                      ARG_PASSTHROUGH check requires exact arg count;
 *                      this finds the "exact prefix + constant tail"
 *                      variant.
 *
 * AUDIT-ONLY: no baseline, no exit code. Heuristic — review each
 * finding before applying.
 *
 * Known FP classes:
 *   - API-surface wrappers — when the function name + JSDoc carry
 *     semantics the bare property access doesn't (e.g. `isStateInstalled`
 *     vs `runtimeState.stateInstalled`, or `getBattleInterior` vs
 *     `player.interior` which is intentionally phase-scoped). The wrapper
 *     IS the documentation surface; renaming back to a field access
 *     loses meaning. Reject during review.
 *   - Architectural wrappers — e.g. the `enter*Phase` helpers in
 *     phase-entry.ts wrap `setPhase` per a deep-import-allowlist
 *     convention. The body is a CONSTANT_PARTIAL but the wrapper is
 *     load-bearing for the layer/lint contract.
 *   - Speculative future divergence — wrappers whose JSDoc says
 *     "currently identity, but provides an abstraction point if X
 *     diverges". These ARE the real signal — apply them.
 *
 * Default `--min-callers=2` — single-caller wrappers are already
 * surfaced by lint:passthrough's SINGLE_CALLER pattern; audit at
 * `--min-callers=1` to widen scope.
 *
 * Output (default): human-readable, grouped by pattern.
 * Output (--json): JSON array.
 *
 * Usage:
 *   deno run -A scripts/audit-passthrough-functions.ts [options]
 *
 * Options:
 *   --server          Include server/ files
 *   --test            Include test/ files
 *   --json            Emit JSON
 *   --filter=<re>     Only show findings whose file path matches the regex
 *   --min-callers=N   Require at least N callers (default 2)
 *   --pattern=ID      Limit to PROPERTY_GETTER or CONSTANT_PARTIAL
 *   --exported-only   Only flag exported declarations
 */

import process from "node:process";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  Node,
  Project,
  SyntaxKind,
} from "ts-morph";

type Pattern = "PROPERTY_GETTER" | "CONSTANT_PARTIAL";

interface Finding {
  file: string;
  line: number;
  name: string;
  pattern: Pattern;
  detail: string;
  callerCount: number;
  exported: boolean;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const json = args.includes("--json");
  const exportedOnly = args.includes("--exported-only");
  const filterArg = args.find((a) => a.startsWith("--filter="));
  const filter = filterArg
    ? new RegExp(filterArg.slice("--filter=".length))
    : null;
  const minCallersArg = args.find((a) => a.startsWith("--min-callers="));
  const minCallers = minCallersArg
    ? parseInt(minCallersArg.slice("--min-callers=".length), 10)
    : 2;
  const patternArg = args.find((a) => a.startsWith("--pattern="));
  const onlyPattern = patternArg
    ? (patternArg.slice("--pattern=".length) as Pattern)
    : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    if (filter && !filter.test(relPath)) continue;

    for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      const nameNode = fn.getNameNode();
      if (!nameNode) continue;
      tryDetect(fn, nameNode, relPath, fn.isExported(), findings);
    }
    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = vd.getInitializer();
      if (!init) continue;
      const kind = init.getKind();
      if (
        kind !== SyntaxKind.ArrowFunction &&
        kind !== SyntaxKind.FunctionExpression
      ) {
        continue;
      }
      const nameNode = vd.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.Identifier) continue;
      const stmt = vd.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      const exported = stmt?.isExported() ?? false;
      tryDetect(
        init as ArrowFunction | FunctionExpression,
        nameNode as Identifier,
        relPath,
        exported,
        findings,
      );
    }
  }

  let filtered = onlyPattern
    ? findings.filter((f) => f.pattern === onlyPattern)
    : findings;
  if (exportedOnly) filtered = filtered.filter((f) => f.exported);
  const passing = filtered.filter((f) => f.callerCount >= minCallers);

  if (json) {
    console.log(JSON.stringify(passing, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (passing.length === 0) {
    console.log(
      `✔ No passthrough functions found (${fileCount} files audited)`,
    );
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${passing.length} passthrough function(s):\n`,
  );
  passing.sort(
    (a, b) =>
      a.pattern.localeCompare(b.pattern) ||
      b.callerCount - a.callerCount ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  let lastPattern: Pattern | "" = "";
  for (const f of passing) {
    if (f.pattern !== lastPattern) {
      console.log(`\n── ${f.pattern} ──────────────────────`);
      lastPattern = f.pattern;
    }
    const exp = f.exported ? " (exported)" : "";
    console.log(
      `  ${f.file}:${f.line}  ${f.name}${exp}  [${f.callerCount} caller${f.callerCount === 1 ? "" : "s"}]`,
    );
    console.log(`    → ${f.detail}`);
  }
  console.log("");
}

function tryDetect(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  nameNode: Identifier,
  file: string,
  exported: boolean,
  out: Finding[],
): void {
  const params = fn.getParameters();
  if (params.length === 0) return;

  // No rest / default / destructure / type-pattern weirdness.
  for (const p of params) {
    if (p.getDotDotDotToken()) return;
    if (p.hasInitializer()) return;
    if (!Node.isIdentifier(p.getNameNode())) return;
  }
  const paramNames = params.map((p) => p.getNameNode().getText());

  if (params.length === 1) {
    const getter = matchPropertyGetter(fn, paramNames[0]!);
    if (getter) {
      pushFinding(nameNode, file, "PROPERTY_GETTER", getter, exported, out);
      return;
    }
  }

  const partial = matchConstantPartial(fn, paramNames);
  if (partial) {
    pushFinding(nameNode, file, "CONSTANT_PARTIAL", partial, exported, out);
  }
}

function pushFinding(
  nameNode: Identifier,
  file: string,
  pattern: Pattern,
  detail: string,
  exported: boolean,
  out: Finding[],
): void {
  const refs = nameNode.findReferencesAsNodes();
  const callers = refs.filter((r) => r !== nameNode).length;
  out.push({
    file,
    line: nameNode.getStartLineNumber(),
    name: nameNode.getText(),
    pattern,
    detail,
    callerCount: callers,
    exported,
  });
}

/** Body is exactly `return obj.x.y…` (block) or `obj.x.y…` (arrow expression). */
function matchPropertyGetter(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  paramName: string,
): string | null {
  const body = fn.getBody();
  if (!body) return null;

  let returnExpr: Node | undefined;
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) return null;
    const stmt = stmts[0]!;
    if (!Node.isReturnStatement(stmt)) return null;
    returnExpr = stmt.getExpression();
  } else {
    returnExpr = body;
    while (returnExpr && Node.isParenthesizedExpression(returnExpr)) {
      returnExpr = returnExpr.getExpression();
    }
  }
  if (!returnExpr) return null;

  // Must be a plain property-access chain rooted at paramName.
  // OptionalChain (`obj?.x`) is intentionally NOT matched — those usually
  // carry null-handling semantics that the wrapper is preserving.
  if (!Node.isPropertyAccessExpression(returnExpr)) return null;
  if (returnExpr.getQuestionDotTokenNode()) return null;
  let cursor: Node = returnExpr;
  while (Node.isPropertyAccessExpression(cursor)) {
    if (cursor.getQuestionDotTokenNode()) return null;
    cursor = cursor.getExpression();
  }
  if (!Node.isIdentifier(cursor)) return null;
  if (cursor.getText() !== paramName) return null;

  return truncate(returnExpr.getText(), 80);
}

/** Body is exactly `return foo(p0, p1, …, CONST_OR_QUALIFIED, …)`. */
function matchConstantPartial(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  paramNames: readonly string[],
): string | null {
  const body = fn.getBody();
  if (!body) return null;

  let callExpr: CallExpression | undefined;
  if (Node.isCallExpression(body)) {
    callExpr = body;
  } else if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) return null;
    const stmt = stmts[0]!;
    if (Node.isReturnStatement(stmt)) {
      const expr = stmt.getExpression();
      if (!expr || !Node.isCallExpression(expr)) return null;
      callExpr = expr;
    } else if (Node.isExpressionStatement(stmt)) {
      const expr = stmt.getExpression();
      if (!Node.isCallExpression(expr)) return null;
      callExpr = expr;
    } else {
      return null;
    }
  } else {
    return null;
  }
  if (!callExpr) return null;

  const callArgs = callExpr.getArguments();
  // Must add ≥1 extra arg beyond the forwarded prefix — exact-arg passthroughs
  // are already caught by lint:passthrough's ARG_PASSTHROUGH.
  if (callArgs.length <= paramNames.length) return null;

  // First N args are the param identifiers in order.
  for (let i = 0; i < paramNames.length; i++) {
    const arg = callArgs[i]!;
    if (!Node.isIdentifier(arg)) return null;
    if (arg.getText() !== paramNames[i]) return null;
  }

  // Remaining args must be constant-ish (literals, qualified-name refs, or
  // identifiers that are NOT wrapper params).
  const paramSet = new Set(paramNames);
  for (let i = paramNames.length; i < callArgs.length; i++) {
    const arg = callArgs[i]!;
    if (!isConstantArg(arg, paramSet)) return null;
  }

  return truncate(callExpr.getText(), 80);
}

function isConstantArg(node: Node, paramSet: Set<string>): boolean {
  if (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return true;
  }
  if (Node.isIdentifier(node)) {
    // `undefined` is keyword-as-identifier; allow it.
    if (node.getText() === "undefined") return true;
    // Wrapper-param leakage past the prefix slot disqualifies — that's not
    // a constant partial, that's a reorder/duplicate.
    return !paramSet.has(node.getText());
  }
  if (Node.isPropertyAccessExpression(node)) {
    if (node.getQuestionDotTokenNode()) return false;
    let cursor: Node = node;
    while (Node.isPropertyAccessExpression(cursor)) {
      if (cursor.getQuestionDotTokenNode()) return false;
      cursor = cursor.getExpression();
    }
    if (Node.isIdentifier(cursor)) {
      return !paramSet.has(cursor.getText());
    }
    return false;
  }
  return false;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}
