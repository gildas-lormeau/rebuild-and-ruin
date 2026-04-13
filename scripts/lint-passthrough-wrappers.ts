/**
 * Detect passthrough wrapper functions — functions whose entire body is a
 * single call to another function with the exact same arguments in order.
 *
 * These are an LLM code smell: delegation layers that add indirection
 * without changing the abstraction level. Also detects multi-level chains
 * (A calls B calls C, each a passthrough).
 *
 * Detection rules:
 *   - Function has 1+ parameters (all simple identifiers, no destructuring/rest)
 *   - Body is a single statement (or expression body for arrows)
 *   - That statement calls another function with the exact same args in order
 *   - No extra args added, no params with default initializers
 *
 * Usage:
 *   deno run -A scripts/lint-passthrough-wrappers.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --test              Include test/ files
 *   --update-baseline   Write current detections to baseline (suppress in future runs)
 *
 * Baseline: .passthrough-baseline.json — entries are "file:functionName" keys.
 * Baselined entries are intentional facades (e.g. upgrade-system dispatchers).
 *
 * Exits 1 if non-baselined violations found.
 */

import fs from "node:fs";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  SyntaxKind,
} from "ts-morph";

interface Passthrough {
  file: string;
  line: number;
  name: string;
  callee: string;
  exported: boolean;
}

type CheckableFunction =
  | FunctionDeclaration
  | ArrowFunction
  | MethodDeclaration;

interface Chain {
  links: Passthrough[];
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

  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  // ── Scan ───────────────────────────────────────────────────────

  const passthroughs: Passthrough[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");

    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const result = checkPassthrough(fn);
      if (result) {
        passthroughs.push({
          file: relPath,
          line: fn.getStartLineNumber(),
          name,
          callee: result,
          exported: fn.isExported(),
        });
      }
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (!init) continue;
      const name = varDecl.getName();
      const result = checkPassthrough(init);
      if (result) {
        const varStmt = varDecl.getFirstAncestorByKind(
          SyntaxKind.VariableStatement,
        );
        passthroughs.push({
          file: relPath,
          line: varDecl.getStartLineNumber(),
          name,
          callee: result,
          exported: varStmt?.isExported() ?? false,
        });
      }
    }
  }

  // ── Chain detection ────────────────────────────────────────────

  const byName = new Map<string, Passthrough>();
  for (const pt of passthroughs) {
    byName.set(ptKey(pt), pt);
  }

  const chains: Chain[] = [];
  const visited = new Set<string>();

  for (const pt of passthroughs) {
    const key = ptKey(pt);
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
    if (links.length >= 2) {
      chains.push({ links });
    }
  }

  // ── Baseline update mode ───────────────────────────────────────

  if (updateBaseline) {
    const keys = passthroughs.map(ptKey).sort();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(keys, null, 2) + "\n");
    console.log(`\u2714 Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    process.exit(0);
  }

  // ── Filter by baseline ─────────────────────────────────────────

  const newViolations = passthroughs.filter((pt) => !baseline.has(ptKey(pt)));
  const newChains = chains.filter((chain) =>
    chain.links.some((link) => !baseline.has(ptKey(link))),
  );

  const currentKeys = new Set(passthroughs.map(ptKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  // ── Report ─────────────────────────────────────────────────────

  const fileCount = project.getSourceFiles().length;

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselinedCount = passthroughs.length - newViolations.length;
    const suffix = baselinedCount > 0 ? `, ${baselinedCount} baselined` : "";
    console.log(
      `\u2714 No passthrough wrappers (${fileCount} files checked${suffix})`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    console.log(
      `\u2718 ${newViolations.length} passthrough wrapper(s) found:\n`,
    );
    for (const pt of newViolations) {
      const exp = pt.exported ? " (exported)" : "";
      console.log(
        `  ${pt.file}:${pt.line}: ${pt.name}${exp} \u2192 ${pt.callee}`,
      );
    }
  }

  if (newChains.length > 0) {
    console.log(`\n  Indirection chains (${newChains.length}):\n`);
    for (const chain of newChains) {
      const names = chain.links.map((link) => link.name);
      const last = chain.links[chain.links.length - 1]!;
      names.push(last.callee);
      console.log(
        `  ${chain.links[0]!.file}:${chain.links[0]!.line}: ${names.join(" \u2192 ")}`,
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

function ptKey(pt: Passthrough): string {
  return `${pt.file}:${pt.name}`;
}

function loadBaseline(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    return new Set(raw as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Check if a function is a passthrough wrapper. Returns the callee name
 * if it is, or null if it isn't.
 */
function checkPassthrough(fn: CheckableFunction): string | null {
  const params = fn.getParameters();
  if (params.length === 0) return null;

  // Bail on destructured, rest, or default-value params
  const paramNames: string[] = [];
  for (const param of params) {
    if (param.getDotDotDotToken()) return null;
    if (param.hasInitializer()) return null;
    const nameNode = param.getNameNode();
    if (!Node.isIdentifier(nameNode)) return null;
    paramNames.push(nameNode.getText());
  }

  const body = fn.getBody();
  if (!body) return null;

  // Arrow function with expression body: (a, b) => foo(a, b)
  if (Node.isCallExpression(body)) {
    return matchCall(body, paramNames);
  }

  // Block body — must have exactly 1 statement
  if (!Node.isBlock(body)) return null;
  const stmts = body.getStatements();
  if (stmts.length !== 1) return null;
  const stmt = stmts[0]!;

  // return foo(a, b);
  if (Node.isReturnStatement(stmt)) {
    const expr = stmt.getExpression();
    if (expr && Node.isCallExpression(expr)) {
      return matchCall(expr, paramNames);
    }
    return null;
  }

  // foo(a, b);  (void passthrough)
  if (Node.isExpressionStatement(stmt)) {
    const expr = stmt.getExpression();
    if (Node.isCallExpression(expr)) {
      return matchCall(expr, paramNames);
    }
  }

  return null;
}

/**
 * Check if a call expression passes exactly the given param names as
 * arguments, in order. Returns the callee name or null.
 */
function matchCall(call: Node, paramNames: readonly string[]): string | null {
  if (!Node.isCallExpression(call)) return null;

  const callArgs = call.getArguments();
  if (callArgs.length !== paramNames.length) return null;

  for (let i = 0; i < callArgs.length; i++) {
    const arg = callArgs[i]!;
    if (!Node.isIdentifier(arg)) return null;
    if (arg.getText() !== paramNames[i]) return null;
  }

  return call.getExpression().getText();
}
