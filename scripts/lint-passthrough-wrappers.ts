/**
 * Detect passthrough wrapper functions and trivial single-caller exports
 * — LLM code smells where a delegation layer adds indirection without
 * changing the abstraction level.
 *
 * Four patterns:
 *
 * ARG_PASSTHROUGH    — `(a, b) => foo(a, b)`. Exact-arg delegation.
 * SPREAD_PASSTHROUGH — `(...args) => foo(...args)`. Rest-spread delegation.
 * ZERO_ARG_LITERAL   — `() => ({ type: X })`. Wraps a literal that's
 *                      shorter than the call site, so the wrapper saves
 *                      no typing and centralises nothing.
 * SINGLE_CALLER      — exported function with a trivial body (arrow expr
 *                      body, or block with ≤ 2 statements) that has
 *                      exactly one caller in the project. Inlining
 *                      removes the export without losing reuse.
 *
 * Multi-level chains (A → B → C, each a passthrough) are surfaced too.
 *
 * Usage:
 *   deno run -A scripts/lint-passthrough-wrappers.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --test              Include test/ files
 *   --update-baseline   Write current detections to baseline
 *
 * Baseline: .passthrough-baseline.json — entries are "file:name:pattern".
 *
 * Exits 1 if non-baselined violations or stale baseline entries are found.
 */

import fs from "node:fs";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  type Project as ProjectType,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

type Pattern =
  | "ARG_PASSTHROUGH"
  | "SPREAD_PASSTHROUGH"
  | "ZERO_ARG_LITERAL"
  | "SINGLE_CALLER";

interface Passthrough {
  file: string;
  line: number;
  name: string;
  pattern: Pattern;
  /** Identifier of the delegated callee (for *_PASSTHROUGH); null otherwise. */
  callee: string | null;
  /** Caller location for SINGLE_CALLER, literal description for ZERO_ARG_LITERAL. */
  detail: string | null;
  exported: boolean;
}

type CheckableFunction =
  | FunctionDeclaration
  | ArrowFunction
  | MethodDeclaration;

interface Chain {
  links: Passthrough[];
}

interface BodyMatch {
  pattern: Pattern;
  callee: string | null;
  detail: string | null;
}

const BASELINE_FILE = ".passthrough-baseline.json";

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const updateBaseline = args.includes("--update-baseline");

  const baseline = loadBaseline();
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts", "dev/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  // ── Body-shape scan: ARG / SPREAD / ZERO_ARG_LITERAL ─────────────

  const passthroughs: Passthrough[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = relPathOf(sourceFile);

    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const found = checkBodyShape(fn);
      if (found) {
        passthroughs.push({
          file: relPath,
          line: fn.getStartLineNumber(),
          name,
          pattern: found.pattern,
          callee: found.callee,
          detail: found.detail,
          exported: fn.isExported(),
        });
      }
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (!init) continue;
      const found = checkBodyShape(init);
      if (!found) continue;
      const varStmt = varDecl.getFirstAncestorByKind(
        SyntaxKind.VariableStatement,
      );
      passthroughs.push({
        file: relPath,
        line: varDecl.getStartLineNumber(),
        name: varDecl.getName(),
        pattern: found.pattern,
        callee: found.callee,
        detail: found.detail,
        exported: varStmt?.isExported() ?? false,
      });
    }
  }

  // ── Reference-count scan: SINGLE_CALLER ──────────────────────────

  const alreadyFlagged = new Set(
    passthroughs.map((pt) => `${pt.file}:${pt.name}`),
  );
  passthroughs.push(...findSingleCallerExports(project, alreadyFlagged));

  // ── Chain detection (callable patterns only) ─────────────────────

  const callable = passthroughs.filter((pt) => pt.callee !== null);
  const byName = new Map<string, Passthrough>();
  for (const pt of callable) byName.set(`${pt.file}:${pt.name}`, pt);

  const chains: Chain[] = [];
  const visited = new Set<string>();

  for (const pt of callable) {
    const key = `${pt.file}:${pt.name}`;
    if (visited.has(key)) continue;

    const links: Passthrough[] = [pt];
    visited.add(key);
    let current = pt;
    while (true) {
      const calleeKey = `${current.file}:${current.callee}`;
      const next = byName.get(calleeKey);
      if (!next || visited.has(calleeKey)) break;
      visited.add(calleeKey);
      links.push(next);
      current = next;
    }
    if (links.length >= 2) chains.push({ links });
  }

  // ── Baseline update mode ─────────────────────────────────────────

  if (updateBaseline) {
    const keys = passthroughs.map(ptKey).sort();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(keys, null, 2) + "\n");
    console.log(`✔ Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    process.exit(0);
  }

  // ── Filter by baseline ───────────────────────────────────────────

  const newViolations = passthroughs.filter((pt) => !baseline.has(ptKey(pt)));
  const newChains = chains.filter((chain) =>
    chain.links.some((link) => !baseline.has(ptKey(link))),
  );
  const currentKeys = new Set(passthroughs.map(ptKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  // ── Report ───────────────────────────────────────────────────────

  const fileCount = project.getSourceFiles().length;

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselined = passthroughs.length - newViolations.length;
    const suffix = baselined > 0 ? `, ${baselined} baselined` : "";
    console.log(
      `✔ No passthrough wrappers (${fileCount} files checked${suffix})`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    console.log(`✘ ${newViolations.length} passthrough wrapper(s) found:`);
    for (const pattern of [
      "ARG_PASSTHROUGH",
      "SPREAD_PASSTHROUGH",
      "ZERO_ARG_LITERAL",
      "SINGLE_CALLER",
    ] as const) {
      const group = newViolations.filter((pt) => pt.pattern === pattern);
      if (group.length === 0) continue;
      console.log(`\n  ${pattern} (${group.length}):`);
      for (const pt of group) {
        const exp = pt.exported ? " (exported)" : "";
        const tail = pt.callee ?? pt.detail ?? "";
        console.log(`    ${pt.file}:${pt.line}: ${pt.name}${exp} → ${tail}`);
      }
    }
  }

  if (newChains.length > 0) {
    console.log(`\n  Indirection chains (${newChains.length}):`);
    for (const chain of newChains) {
      const names = chain.links.map((link) => link.name);
      const last = chain.links[chain.links.length - 1]!;
      if (last.callee) names.push(last.callee);
      console.log(
        `    ${chain.links[0]!.file}:${chain.links[0]!.line}: ${names.join(" → ")}`,
      );
    }
  }

  if (staleEntries.length > 0) {
    console.log(
      `\n  ✘ ${staleEntries.length} stale baseline entry/entries (remove from ${BASELINE_FILE}):`,
    );
    for (const key of staleEntries) console.log(`    ${key}`);
  }

  process.exit(1);
}

function checkBodyShape(fn: CheckableFunction): BodyMatch | null {
  const params = fn.getParameters();

  if (params.length === 0) {
    const literal = checkZeroArgLiteral(fn);
    if (literal) {
      return { pattern: "ZERO_ARG_LITERAL", callee: null, detail: literal };
    }
    return null;
  }

  // Single rest param: (...args) => foo(...args)
  if (params.length === 1 && params[0]!.getDotDotDotToken()) {
    const callee = checkSpreadPassthrough(fn);
    if (callee) {
      return { pattern: "SPREAD_PASSTHROUGH", callee, detail: null };
    }
    return null;
  }

  // Bail on any rest / default / destructured params for ARG check.
  const paramNames: string[] = [];
  for (const param of params) {
    if (param.getDotDotDotToken()) return null;
    if (param.hasInitializer()) return null;
    const nameNode = param.getNameNode();
    if (!Node.isIdentifier(nameNode)) return null;
    paramNames.push(nameNode.getText());
  }

  const callee = checkArgPassthrough(fn, paramNames);
  if (callee) return { pattern: "ARG_PASSTHROUGH", callee, detail: null };
  return null;
}

function checkArgPassthrough(
  fn: CheckableFunction,
  paramNames: readonly string[],
): string | null {
  const callExpr = extractSingleCallBody(fn);
  if (!callExpr) return null;

  const callArgs = callExpr.getArguments();
  if (callArgs.length !== paramNames.length) return null;
  for (let i = 0; i < callArgs.length; i++) {
    const arg = callArgs[i]!;
    if (!Node.isIdentifier(arg)) return null;
    if (arg.getText() !== paramNames[i]) return null;
  }
  return callExpr.getExpression().getText();
}

function checkSpreadPassthrough(fn: CheckableFunction): string | null {
  const param = fn.getParameters()[0];
  if (!param || !param.getDotDotDotToken()) return null;
  if (param.hasInitializer()) return null;
  const nameNode = param.getNameNode();
  if (!Node.isIdentifier(nameNode)) return null;
  const restName = nameNode.getText();

  const callExpr = extractSingleCallBody(fn);
  if (!callExpr) return null;

  const callArgs = callExpr.getArguments();
  if (callArgs.length !== 1) return null;
  const onlyArg = callArgs[0]!;
  if (!Node.isSpreadElement(onlyArg)) return null;
  const inner = onlyArg.getExpression();
  if (!Node.isIdentifier(inner)) return null;
  if (inner.getText() !== restName) return null;

  return callExpr.getExpression().getText();
}

function checkZeroArgLiteral(fn: CheckableFunction): string | null {
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
  if (!isTrivialLiteral(returnExpr)) return null;
  return describeLiteral(returnExpr);
}

function extractSingleCallBody(fn: CheckableFunction) {
  const body = fn.getBody();
  if (!body) return null;

  if (Node.isCallExpression(body)) return body;
  if (!Node.isBlock(body)) return null;

  const stmts = body.getStatements();
  if (stmts.length !== 1) return null;
  const stmt = stmts[0]!;

  if (Node.isReturnStatement(stmt)) {
    const expr = stmt.getExpression();
    if (expr && Node.isCallExpression(expr)) return expr;
    return null;
  }
  if (Node.isExpressionStatement(stmt)) {
    const expr = stmt.getExpression();
    if (Node.isCallExpression(expr)) return expr;
  }
  return null;
}

function isTrivialLiteral(expr: Node): boolean {
  if (Node.isObjectLiteralExpression(expr)) {
    for (const prop of expr.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) continue;
      if (Node.isPropertyAssignment(prop)) {
        const init = prop.getInitializer();
        if (!init || !isBareReference(init)) return false;
        continue;
      }
      return false;
    }
    return true;
  }
  if (Node.isArrayLiteralExpression(expr)) {
    return expr.getElements().every(isBareReference);
  }
  return isBareReference(expr);
}

function isBareReference(expr: Node): boolean {
  if (Node.isIdentifier(expr)) return true;
  if (Node.isPropertyAccessExpression(expr)) {
    return isBareReference(expr.getExpression());
  }
  if (
    Node.isStringLiteral(expr) ||
    Node.isNumericLiteral(expr) ||
    Node.isBigIntLiteral(expr) ||
    Node.isTrueLiteral(expr) ||
    Node.isFalseLiteral(expr) ||
    Node.isNullLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    return true;
  }
  return false;
}

function describeLiteral(expr: Node): string {
  if (Node.isObjectLiteralExpression(expr)) {
    const keys = expr
      .getProperties()
      .map((prop) => {
        if (Node.isShorthandPropertyAssignment(prop)) return prop.getName();
        if (Node.isPropertyAssignment(prop)) return prop.getName();
        return "?";
      })
      .join(",");
    return `{ ${truncate(keys, 40)} }`;
  }
  if (Node.isArrayLiteralExpression(expr)) {
    return `[${expr.getElements().length}]`;
  }
  return truncate(expr.getText(), 40);
}

function findSingleCallerExports(
  project: ProjectType,
  alreadyFlagged: Set<string>,
): Passthrough[] {
  const out: Passthrough[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = relPathOf(sourceFile);

    for (const fn of sourceFile.getFunctions()) {
      if (!fn.isExported()) continue;
      const name = fn.getName();
      if (!name) continue;
      if (alreadyFlagged.has(`${relPath}:${name}`)) continue;
      if (!isTrivialBody(fn)) continue;
      const nameNode = fn.getNameNode();
      if (!nameNode) continue;
      const callerLoc = singleCallerLocation(nameNode);
      if (!callerLoc) continue;
      out.push({
        file: relPath,
        line: fn.getStartLineNumber(),
        name,
        pattern: "SINGLE_CALLER",
        callee: null,
        detail: callerLoc,
        exported: true,
      });
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (!init) continue;
      const varStmt = varDecl.getFirstAncestorByKind(
        SyntaxKind.VariableStatement,
      );
      if (!varStmt?.isExported()) continue;
      const name = varDecl.getName();
      if (alreadyFlagged.has(`${relPath}:${name}`)) continue;
      if (!isTrivialBody(init)) continue;
      const nameNode = varDecl.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      const callerLoc = singleCallerLocation(nameNode);
      if (!callerLoc) continue;
      out.push({
        file: relPath,
        line: varDecl.getStartLineNumber(),
        name,
        pattern: "SINGLE_CALLER",
        callee: null,
        detail: callerLoc,
        exported: true,
      });
    }
  }

  return out;
}

function isTrivialBody(fn: CheckableFunction): boolean {
  const body = fn.getBody();
  if (!body) return false;
  if (!Node.isBlock(body)) return true; // arrow expression body
  return body.getStatements().length <= 2;
}

/** Locate the sole reference of an export, or null if it doesn't have
 *  exactly one. Deliberately counts ALL non-declaration references (a
 *  same-file caller resolves to a single `[call]` ref; a cross-file caller
 *  carries an extra import specifier → 2 refs → skipped). This keeps the
 *  hard gate scoped to SAME-FILE trivial single-callers: cross-file
 *  one-liner single-callers are pervasive and overwhelmingly intentional
 *  boundary seams here (phase-entry helpers, registry hooks, AI phase
 *  composition), so they belong in the review-only
 *  `audit-single-call-exports.ts` (run with `--min-statements=1`), not in
 *  an exit-code lint. */
function singleCallerLocation(nameNode: Node): string | null {
  const finder = nameNode as { findReferencesAsNodes?: () => Node[] };
  if (typeof finder.findReferencesAsNodes !== "function") return null;
  const refs = finder.findReferencesAsNodes();
  const external = refs.filter((ref) => ref !== nameNode);
  if (external.length !== 1) return null;
  const ref = external[0]!;
  const sf = ref.getSourceFile();
  return `${relPathOf(sf)}:${ref.getStartLineNumber()}`;
}

function ptKey(pt: Passthrough): string {
  return `${pt.file}:${pt.name}:${pt.pattern}`;
}

function relPathOf(sf: SourceFile): string {
  return sf.getFilePath().replace(`${process.cwd()}/`, "");
}

function loadBaseline(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    return new Set(raw as string[]);
  } catch {
    return new Set();
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
