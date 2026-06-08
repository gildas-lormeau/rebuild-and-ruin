/**
 * Audit: registry-fold boilerplate.
 *
 * Detects functions whose body is a thin fold over a registry-like
 * iterable, calling a single hook method on each entry and aggregating.
 * The accumulation shape is classified so you can see at a glance how
 * often each shape repeats and whether extracting combinators is worth
 * the refactor cost.
 *
 * Shapes detected (`impl` is the loop variable, `H` the hook method):
 *
 *   OR_ANY            for (...) if (impl.H?.(args)) return true;
 *                     return false;
 *   AND_ALL           for (...) if (impl.H && !impl.H(args)) return false;
 *                     return true;
 *   SUM               let a = 0;
 *                     for (...) a += impl.H?.(args) ?? 0;
 *                     return a;
 *   PRODUCT           let a = 1;
 *                     for (...) a *= impl.H?.(args) ?? 1;
 *                     return a;
 *   FIRST_NON_NULL    for (...) { const r = impl.H?.(args); if (r) return r; }
 *                     return null;  // or undefined
 *   FOR_EACH          for (...) impl.H?.(args);   // no return / void
 *   GENERATOR_MERGE   function*… { for (...) { const g = impl.H?.(args);
 *                                              if (g) yield* g; } }
 *
 * Source patterns recognized: `X.values()`, `Object.values(X)`, or `X`
 * (direct iteration of an Iterable binding).
 *
 * "Hook" = the only `loopVar.METHOD(...)` / `loopVar.METHOD?.(...)` call
 * inside the loop body. Functions where two different methods are called
 * on the loop var are skipped.
 *
 * Known FP class — DOM/native-API wiring loops are structurally identical
 * to registry dispatch (one method call per iteration, no return). Example:
 * `for (const btn of buttons) btn.addEventListener(...)`. Filter these
 * out during review; the audit can't distinguish a registry impl from a
 * DOM node without semantic knowledge.
 *
 * AUDIT-ONLY: no baseline, no exit code.
 *
 * Usage:
 *   deno run -A scripts/audit-registry-folds.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON
 *   --filter=<re>    Only show findings whose file path matches the regex
 *   --shape=ID       Limit to one shape (OR_ANY, AND_ALL, SUM, PRODUCT,
 *                    FIRST_NON_NULL, FOR_EACH, GENERATOR_MERGE)
 *   --by=file|shape  Group output by file or by shape (default: shape)
 */

import process from "node:process";
import {
  type ArrowFunction,
  type Block,
  type ForOfStatement,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  Project,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "ts-morph";

type Shape =
  | "OR_ANY"
  | "AND_ALL"
  | "SUM"
  | "PRODUCT"
  | "FIRST_NON_NULL"
  | "FOR_EACH"
  | "GENERATOR_MERGE";

interface Finding {
  file: string;
  line: number;
  name: string;
  shape: Shape;
  hook: string;
  source: string;
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
  const shapeArg = args.find((a) => a.startsWith("--shape="));
  const onlyShape = shapeArg
    ? (shapeArg.slice("--shape=".length) as Shape)
    : null;
  const byArg = args.find((a) => a.startsWith("--by="));
  const groupBy = byArg ? byArg.slice("--by=".length) : "shape";

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
    auditFile(sf, relPath, findings);
  }

  const filtered = onlyShape
    ? findings.filter((f) => f.shape === onlyShape)
    : findings;

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (filtered.length === 0) {
    console.log(
      `✔ No registry-fold patterns found (${fileCount} files audited)`,
    );
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${filtered.length} registry-fold(s):\n`,
  );
  printShapeTally(filtered);
  console.log();
  if (groupBy === "file") printByFile(filtered);
  else printByShape(filtered);
}

function auditFile(sf: SourceFile, relPath: string, findings: Finding[]): void {
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    if (!name) continue;
    const finding = tryClassify(fn, name, relPath);
    if (finding) findings.push(finding);
  }
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (!init) continue;
    const k = init.getKind();
    if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression)
      continue;
    const name = vd.getName();
    const finding = tryClassify(
      init as ArrowFunction | FunctionExpression,
      name,
      relPath,
    );
    if (finding) findings.push(finding);
  }
}

function tryClassify(
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction,
  name: string,
  file: string,
): Finding | null {
  const body = fn.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) return null;
  const block = body.asKindOrThrow(SyntaxKind.Block) as Block;
  const stmts = block.getStatements();
  const forOfs = stmts.filter((s) => s.getKind() === SyntaxKind.ForOfStatement);
  if (forOfs.length !== 1) return null;
  const forOf = forOfs[0]!.asKindOrThrow(
    SyntaxKind.ForOfStatement,
  ) as ForOfStatement;

  const source = describeSource(forOf.getExpression());
  if (!source) return null;

  const loopVarName = extractLoopVarName(forOf);
  if (!loopVarName) return null;

  const hookMethod = findHookMethod(forOf, loopVarName);
  if (!hookMethod) return null;

  const isGenerator = isGeneratorFn(fn);
  const shape = classifyShape(forOf, stmts, isGenerator);
  if (!shape) return null;

  return {
    file,
    line: forOf.getStartLineNumber(),
    name,
    shape,
    hook: hookMethod,
    source,
  };
}

function isGeneratorFn(
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction,
): boolean {
  if (fn.getKind() === SyntaxKind.FunctionDeclaration) {
    return (fn as FunctionDeclaration).isGenerator();
  }
  if (fn.getKind() === SyntaxKind.FunctionExpression) {
    return (fn as FunctionExpression).isGenerator();
  }
  return false;
}

function describeSource(expr: Node): string | null {
  if (expr.getKind() === SyntaxKind.CallExpression) {
    const call = expr.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();
    if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const method = pa.getName();
      const obj = pa.getExpression();
      if (method === "values" && obj.getKind() === SyntaxKind.Identifier) {
        return `${obj.getText()}.values()`;
      }
      if (
        method === "values" &&
        obj.getKind() === SyntaxKind.Identifier &&
        obj.getText() === "Object"
      ) {
        const args = call.getArguments();
        if (args.length === 1 && args[0]?.getKind() === SyntaxKind.Identifier) {
          return `Object.values(${args[0]!.getText()})`;
        }
      }
    }
  }
  if (expr.getKind() === SyntaxKind.Identifier) {
    return expr.getText();
  }
  return null;
}

function extractLoopVarName(forOf: ForOfStatement): string | null {
  const initializer = forOf.getInitializer();
  if (initializer.getKind() !== SyntaxKind.VariableDeclarationList) return null;
  const vdl = initializer.asKindOrThrow(SyntaxKind.VariableDeclarationList);
  const decls = vdl.getDeclarations();
  if (decls.length !== 1) return null;
  const nameNode = decls[0]!.getNameNode();
  if (nameNode.getKind() !== SyntaxKind.Identifier) return null;
  return nameNode.getText();
}

function findHookMethod(
  forOf: ForOfStatement,
  loopVarName: string,
): string | null {
  const methods = new Set<string>();
  forOf.getStatement().forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const obj = pa.getExpression();
    if (
      obj.getKind() === SyntaxKind.Identifier &&
      obj.getText() === loopVarName
    ) {
      methods.add(pa.getName());
    }
  });
  if (methods.size !== 1) return null;
  return [...methods][0]!;
}

function classifyShape(
  forOf: ForOfStatement,
  stmts: Statement[],
  isGenerator: boolean,
): Shape | null {
  const forOfIdx = stmts.indexOf(forOf);
  const before = stmts.slice(0, forOfIdx);
  const after = stmts.slice(forOfIdx + 1);

  if (isGenerator) {
    let hasYieldStar = false;
    forOf.getStatement().forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.YieldExpression) return;
      const ye = node.asKindOrThrow(SyntaxKind.YieldExpression);
      if (ye.getAsteriskToken()) hasYieldStar = true;
    });
    if (hasYieldStar) return "GENERATOR_MERGE";
  }

  // FOR_EACH: no stmts before or after — body is just the call
  if (before.length === 0 && after.length === 0) return "FOR_EACH";

  // SUM / PRODUCT: 1 `let X = init;` before, 1 `return X;` after
  if (before.length === 1 && after.length === 1) {
    const accName = accumulatorName(before[0]!);
    const retName = returnName(after[0]!);
    if (accName && retName && accName.name === retName) {
      const bodyText = forOf.getStatement().getText();
      if (bodyText.includes(`${accName.name} +=`) && accName.init === "0") {
        return "SUM";
      }
      if (bodyText.includes(`${accName.name} *=`) && accName.init === "1") {
        return "PRODUCT";
      }
    }
  }

  // OR_ANY / AND_ALL / FIRST_NON_NULL: no decl before, 1 return after
  if (before.length === 0 && after.length === 1) {
    const ret = after[0]!;
    if (ret.getKind() !== SyntaxKind.ReturnStatement) return null;
    const retText =
      ret
        .asKindOrThrow(SyntaxKind.ReturnStatement)
        .getExpression()
        ?.getText() ?? "";

    const earlyRets = collectEarlyReturns(forOf);
    if (retText === "false" && earlyRets.includes("true")) return "OR_ANY";
    if (retText === "true" && earlyRets.includes("false")) return "AND_ALL";
    if (
      (retText === "null" || retText === "undefined") &&
      earlyRets.length === 1 &&
      earlyRets[0] !== "null" &&
      earlyRets[0] !== "undefined" &&
      earlyRets[0] !== "true" &&
      earlyRets[0] !== "false"
    ) {
      return "FIRST_NON_NULL";
    }
  }

  return null;
}

function accumulatorName(
  stmt: Statement,
): { name: string; init: string } | null {
  if (stmt.getKind() !== SyntaxKind.VariableStatement) return null;
  const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement);
  const decls = vs.getDeclarationList().getDeclarations();
  if (decls.length !== 1) return null;
  const init = decls[0]!.getInitializer();
  if (!init) return null;
  return { name: decls[0]!.getName(), init: init.getText() };
}

function returnName(stmt: Statement): string | null {
  if (stmt.getKind() !== SyntaxKind.ReturnStatement) return null;
  const expr = stmt.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
  if (!expr || expr.getKind() !== SyntaxKind.Identifier) return null;
  return expr.getText();
}

function collectEarlyReturns(forOf: ForOfStatement): string[] {
  const out: string[] = [];
  forOf.getStatement().forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.ReturnStatement) return;
    const expr = node.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
    out.push(expr?.getText() ?? "<void>");
  });
  return out;
}

function printShapeTally(findings: Finding[]): void {
  const tally: Record<string, number> = {};
  for (const f of findings) tally[f.shape] = (tally[f.shape] ?? 0) + 1;
  const order: Shape[] = [
    "OR_ANY",
    "AND_ALL",
    "SUM",
    "PRODUCT",
    "FIRST_NON_NULL",
    "FOR_EACH",
    "GENERATOR_MERGE",
  ];
  console.log("By shape:");
  for (const sh of order) {
    if (tally[sh]) console.log(`  ${sh.padEnd(16)} ${tally[sh]}`);
  }
}

function printByShape(findings: Finding[]): void {
  const sorted = [...findings].sort(
    (a, b) =>
      a.shape.localeCompare(b.shape) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  let curShape: Shape | null = null;
  for (const f of sorted) {
    if (f.shape !== curShape) {
      console.log(`\n[${f.shape}]`);
      curShape = f.shape;
    }
    console.log(
      `  ${f.file}:${f.line}  ${f.name}  — ${f.source} . ${f.hook}()`,
    );
  }
}

function printByFile(findings: Finding[]): void {
  const sorted = [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  let curFile: string | null = null;
  for (const f of sorted) {
    if (f.file !== curFile) {
      console.log(`\n${f.file}`);
      curFile = f.file;
    }
    console.log(`  :${f.line}  ${f.shape.padEnd(16)} ${f.name}  — ${f.hook}()`);
  }
}
