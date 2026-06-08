/**
 * Audit: Same-discriminant guard nested across a call chain.
 *
 * Pattern: function A has a first-statement guard `if (X) return ...;`,
 * then calls function B which has the same `if (X) return ...;` as its
 * first statement. B's guard is redundant along the path from A — but B
 * may have other callers, so this is a refactor hint, not a dead-code
 * claim. Common LLM tell: an extracted helper kept the parent's guard.
 *
 * Definition of "guard": first statement of a function body is
 * `if (<cond>) return <value>;` with no else clause and a single-return
 * then-branch.
 *
 * Matching: exact text equality of the if-condition. Callees resolved by
 * symbol lookup — works cross-file. Only plain `foo(...)` callees
 * (Identifier expressions); `obj.foo(...)` member calls are skipped
 * because they're typically dynamic dispatch into a registry impl, where
 * the impl-level guard is intentional defense at the registry boundary.
 *
 * AUDIT-ONLY: no baseline, no exit code.
 *
 * Usage:
 *   deno run -A scripts/audit-nested-same-guard.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON
 *   --filter=<re>    Only show findings whose file path matches the regex
 */

import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

type FnKey = FunctionDeclaration | VariableDeclaration;

type FnBody = FunctionDeclaration | ArrowFunction | FunctionExpression;

interface GuardedFn {
  name: string;
  file: string;
  line: number;
  guardCondition: string;
  body: FnBody;
}

interface Finding {
  outerFile: string;
  outerLine: number;
  outerName: string;
  innerFile: string;
  innerLine: number;
  innerName: string;
  callLine: number;
  condition: string;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const json = args.includes("--json");
  const filterArg = args.find((a) => a.startsWith("--filter="));
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

  const guardedByDecl = new Map<FnKey, GuardedFn>();
  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    indexGuardedFunctions(sf, relPath, guardedByDecl);
  }

  const findings: Finding[] = [];
  for (const [decl, outer] of guardedByDecl) {
    if (filter && !filter.test(outer.file)) continue;
    findNestedGuards(decl, outer, guardedByDecl, findings);
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (findings.length === 0) {
    console.log(
      `✔ No nested same-guard chains (${fileCount} files audited, ${guardedByDecl.size} guarded functions)`,
    );
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${guardedByDecl.size} guarded functions; ${findings.length} nested same-guard finding(s):\n`,
  );
  findings.sort(
    (a, b) =>
      a.outerFile.localeCompare(b.outerFile) ||
      a.outerLine - b.outerLine ||
      a.callLine - b.callLine,
  );
  for (const f of findings) {
    console.log(`  ${f.outerFile}:${f.outerLine}  ${f.outerName}`);
    console.log(`    calls  ${f.innerName}  at  ${f.outerFile}:${f.callLine}`);
    console.log(`    inner  ${f.innerFile}:${f.innerLine}`);
    console.log(`    both guard on  if (${f.condition}) return ...;`);
    console.log();
  }
}

function indexGuardedFunctions(
  sf: SourceFile,
  relPath: string,
  index: Map<FnKey, GuardedFn>,
): void {
  for (const fn of sf.getFunctions()) {
    const cond = tryGetGuardCondition(fn);
    if (cond !== null) {
      index.set(fn, {
        name: fn.getName() ?? "<anonymous>",
        file: relPath,
        line: fn.getStartLineNumber(),
        guardCondition: cond,
        body: fn,
      });
    }
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
    const fn = init as ArrowFunction | FunctionExpression;
    const cond = tryGetGuardCondition(fn);
    if (cond !== null) {
      index.set(vd, {
        name: vd.getName(),
        file: relPath,
        line: vd.getStartLineNumber(),
        guardCondition: cond,
        body: fn,
      });
    }
  }
}

function tryGetGuardCondition(fn: FnBody): string | null {
  const body = fn.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) return null;
  const block = body.asKindOrThrow(SyntaxKind.Block);
  const stmts = block.getStatements();
  if (stmts.length === 0) return null;
  const first = stmts[0];
  if (!first || first.getKind() !== SyntaxKind.IfStatement) return null;
  const ifStmt = first.asKindOrThrow(SyntaxKind.IfStatement);
  if (ifStmt.getElseStatement()) return null;
  const then = ifStmt.getThenStatement();
  if (then.getKind() === SyntaxKind.ReturnStatement) {
    return ifStmt.getExpression().getText();
  }
  if (then.getKind() === SyntaxKind.Block) {
    const innerStmts = then.asKindOrThrow(SyntaxKind.Block).getStatements();
    if (
      innerStmts.length === 1 &&
      innerStmts[0]!.getKind() === SyntaxKind.ReturnStatement
    ) {
      return ifStmt.getExpression().getText();
    }
  }
  return null;
}

function findNestedGuards(
  outerKey: FnKey,
  outer: GuardedFn,
  index: Map<FnKey, GuardedFn>,
  findings: Finding[],
): void {
  for (const call of outer.body.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) continue;
    const sym = callee.asKindOrThrow(SyntaxKind.Identifier).getSymbol();
    if (!sym) continue;
    for (const decl of sym.getDeclarations()) {
      const innerKey = resolveDeclToKey(decl);
      if (!innerKey) continue;
      const inner = index.get(innerKey);
      if (!inner) continue;
      if (innerKey === outerKey) continue; // self-recursion
      if (inner.guardCondition !== outer.guardCondition) continue;
      findings.push({
        outerFile: outer.file,
        outerLine: outer.line,
        outerName: outer.name,
        innerFile: inner.file,
        innerLine: inner.line,
        innerName: inner.name,
        callLine: call.getStartLineNumber(),
        condition: outer.guardCondition,
      });
    }
  }
}

function resolveDeclToKey(decl: Node): FnKey | null {
  const kind = decl.getKind();
  if (kind === SyntaxKind.FunctionDeclaration) {
    return decl.asKindOrThrow(SyntaxKind.FunctionDeclaration);
  }
  if (kind === SyntaxKind.VariableDeclaration) {
    return decl.asKindOrThrow(SyntaxKind.VariableDeclaration);
  }
  return null;
}
