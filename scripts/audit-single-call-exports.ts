/**
 * Audit: exported functions called exactly once with non-trivial bodies.
 *
 * Catches the gap between two existing tools:
 *   - knip                          → 0 callers (dead exports)
 *   - lint:passthrough SINGLE_CALLER → 1 caller + trivial body (≤ 2 statements),
 *                                      but only when the caller is in the
 *                                      SAME FILE (its `external.length === 1`
 *                                      ref count is inflated to 2 by the
 *                                      import specifier on any cross-file call).
 *
 * This audit covers everything that gate misses: any exported function
 * with exactly 1 direct call site, regardless of body size or whether the
 * caller is cross-file. The default `--min-statements=1` includes one-liner
 * single-callers (e.g. a cross-file `state.x = CONST` wrapper) — these fall
 * through both knip and the same-file-only SINGLE_CALLER gate. Raise the
 * floor (`--min-statements=3`) to focus on the higher-signal extractions.
 * Two common LLM causes:
 *
 *   1. Premature extraction — pulled out "just in case", never reused.
 *   2. Stale extraction — used to have multiple callers, refactored down
 *      to one, never inlined.
 *
 * Case 3 (legitimately naming a logic paragraph) is judgment-call; the
 * audit can't decide for you. JSDoc presence is used as a heuristic
 * API-surface marker — without --include-documented, exports that carry
 * a JSDoc comment are skipped on the assumption that the documentation
 * itself is the wrapper's purpose.
 *
 * AUDIT-ONLY: no baseline, no exit code. Heuristic — review each
 * finding before applying.
 *
 * Reference classification (more rigorous than lint:passthrough's
 * "refs.length === 2" heuristic):
 *
 *   - decl     — the declaration name node itself; skipped.
 *   - import   — `import { foo } from "..."` specifier; skipped.
 *   - reexport — `export { foo } from "..."` or `export { foo }`; skipped.
 *   - call     — `foo(...)` or `obj.foo(...)` direct call site; counted.
 *   - value    — `arr.map(foo)`, `[foo, bar]`, aliasing, etc; counted
 *                separately. Any value-ref disqualifies — you can't
 *                straightforwardly inline a function that's also passed
 *                as a value.
 *
 * Flagged iff (callRefs === 1 && valueRefs === 0).
 *
 * Usage:
 *   deno run -A scripts/audit-single-call-exports.ts [options]
 *
 * Known FP classes:
 *   - **DI factory functions** — the project's canonical composition
 *     pattern is one `createXSystem` / `createXManager` factory per
 *     subsystem, called exactly once at wiring time. Non-trivial bodies
 *     (setup + closure state) and single callers by design. Names
 *     matching `^(create|init)[A-Z]` are skipped by default; use
 *     `--include-factories` to widen.
 *   - **Logical-paragraph / named-intent helpers** — case 3 above.
 *     The function exists to give a name to a logical paragraph
 *     (`resetDedupMaps`, `resetSessionState`). Inlinable in principle
 *     but the name carries intent the inline body wouldn't. Reviewer
 *     judgment required; the audit can't filter these out without
 *     suppressing real findings.
 *   - **Dynamic-import targets** — exports loaded via
 *     `import("./mod.ts").then((m) => m.fn())`. The function name is
 *     the contract with the deferred loader; refactor only by changing
 *     both sides together.
 *
 * Options:
 *   --server               Include server/ files
 *   --test                 Include test/ files
 *   --json                 Emit JSON
 *   --filter=<re>          Only show findings whose file path matches the regex
 *   --min-statements=N     Min block statements to flag (default 1 — includes
 *                          one-liners the same-file-only SINGLE_CALLER gate
 *                          misses; raise to 3 for higher-signal extractions)
 *   --include-documented   Also flag exports that have a JSDoc comment
 *   --include-factories    Also flag DI factories (create / init prefix)
 */

import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  Node,
  Project,
  SyntaxKind,
} from "ts-morph";

interface Finding {
  file: string;
  line: number;
  name: string;
  statementCount: number;
  hasJsDoc: boolean;
  callerFile: string;
  callerLine: number;
}

type RefKind = "import" | "reexport" | "call" | "value";

interface WalkOpts {
  minStatements: number;
  includeDocumented: boolean;
  includeFactories: boolean;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const json = args.includes("--json");
  const includeDocumented = args.includes("--include-documented");
  const includeFactories = args.includes("--include-factories");
  const filterArg = args.find((a) => a.startsWith("--filter="));
  const filter = filterArg
    ? new RegExp(filterArg.slice("--filter=".length))
    : null;
  const minStmtArg = args.find((a) => a.startsWith("--min-statements="));
  const minStatements = minStmtArg
    ? parseInt(minStmtArg.slice("--min-statements=".length), 10)
    : 1;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts", "dev/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  const opts: WalkOpts = {
    minStatements,
    includeDocumented,
    includeFactories,
  };
  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    if (filter && !filter.test(relPath)) continue;
    collectFromSourceFile(sf, relPath, opts, findings);
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (findings.length === 0) {
    console.log(`✔ No single-call exports found (${fileCount} files audited)`);
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${findings.length} single-call export(s):\n`,
  );
  findings.sort(
    (a, b) =>
      b.statementCount - a.statementCount ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  for (const f of findings) {
    const doc = f.hasJsDoc ? " [doc]" : "";
    console.log(
      `  ${f.file}:${f.line}  ${f.name}${doc}  [${f.statementCount} stmts]`,
    );
    console.log(`    called from: ${f.callerFile}:${f.callerLine}`);
  }
  console.log("");
}

function collectFromSourceFile(
  sf: import("ts-morph").SourceFile,
  relPath: string,
  opts: WalkOpts,
  findings: Finding[],
): void {
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (!fn.isExported()) continue;
    const nameNode = fn.getNameNode();
    if (!nameNode) continue;
    const stmtCount = blockStmtCount(fn);
    if (stmtCount < opts.minStatements) continue;
    const docs = fn.getJsDocs().length > 0;
    if (docs && !opts.includeDocumented) continue;
    if (!opts.includeFactories && isFactoryName(nameNode.getText())) continue;
    tryFlag(nameNode, relPath, stmtCount, docs, findings);
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
    const varStmt = vd.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (!varStmt?.isExported()) continue;
    const nameNode = vd.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.Identifier) continue;
    const stmtCount = blockStmtCount(
      init as ArrowFunction | FunctionExpression,
    );
    if (stmtCount < opts.minStatements) continue;
    const docs = varStmt.getJsDocs().length > 0;
    if (docs && !opts.includeDocumented) continue;
    if (!opts.includeFactories && isFactoryName(nameNode.getText())) continue;
    tryFlag(nameNode as Identifier, relPath, stmtCount, docs, findings);
  }
}

function isFactoryName(name: string): boolean {
  return /^(create|init)[A-Z]/.test(name);
}

function tryFlag(
  nameNode: Identifier,
  file: string,
  stmtCount: number,
  hasJsDoc: boolean,
  out: Finding[],
): void {
  const refs = nameNode.findReferencesAsNodes();
  let callRef: Node | null = null;
  let valueRefs = 0;
  let callRefs = 0;

  for (const ref of refs) {
    if (ref === nameNode) continue;
    const kind = classifyRef(ref);
    if (kind === "import" || kind === "reexport") continue;
    if (kind === "call") {
      callRefs++;
      callRef = ref;
    } else {
      valueRefs++;
    }
  }

  if (callRefs !== 1 || valueRefs !== 0 || !callRef) return;

  const callerSf = callRef.getSourceFile();
  out.push({
    file,
    line: nameNode.getStartLineNumber(),
    name: nameNode.getText(),
    statementCount: stmtCount,
    hasJsDoc,
    callerFile: callerSf.getFilePath().replace(`${process.cwd()}/`, ""),
    callerLine: callRef.getStartLineNumber(),
  });
}

function classifyRef(ref: Node): RefKind {
  const parent = ref.getParent();
  if (!parent) return "value";

  if (Node.isImportSpecifier(parent)) return "import";
  if (Node.isExportSpecifier(parent)) return "reexport";

  if (Node.isCallExpression(parent) && parent.getExpression() === ref) {
    return "call";
  }
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref) {
    const grand = parent.getParent();
    if (Node.isCallExpression(grand) && grand.getExpression() === parent) {
      return "call";
    }
    return "value";
  }
  return "value";
}

function blockStmtCount(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
): number {
  const body = fn.getBody();
  if (!body) return 0;
  if (!Node.isBlock(body)) return 1;
  return body.getStatements().length;
}
