/**
 * Detect parameters that are effectively never passed by callers.
 *
 * Three patterns reported:
 *   1. always-omitted     — optional/default param, every caller omits it
 *   2. always-same-literal — every caller passes the same primitive literal
 *   3. always-undefined    — every caller's effective value is undefined
 *                           (mix of omits + explicit `undefined` literals)
 *
 * Caveats handled (to keep the report low-noise):
 *   - Skip if the function/method is ever referenced as a value (callback,
 *     stored in variable, JSX attribute, etc.) — we can only reason about
 *     direct call sites.
 *   - Skip methods on classes that `extends` or `implements` anything —
 *     the param may be dictated by a parent contract.
 *   - Skip methods marked `override` or `abstract`.
 *   - Skip rest (`...args`), destructured, and `this` params.
 *   - Skip a call site that uses spread (`f(...args)`) — defeats positional
 *     analysis; the whole function is skipped if any caller spreads.
 *   - Need ≥ MIN_CALLERS direct call sites in the loaded project — anything
 *     less means we can't draw a conclusion (or the function is unused, in
 *     which case knip is the right tool).
 *   - Always loads src/ + server/ + test/ so reference resolution catches
 *     external callers; reporting scope defaults to src/.
 *
 * Load-bearing exclusions (param is genuinely not dead even if call sites converge):
 *   - Param name starts with `_` — developer-tagged "intentional" / type-level guard.
 *   - Param's type is a string-literal union (`"a" | "b" | "c"`) — discriminator.
 *   - Param is used as a Map/Set/dict key in the function body
 *     (`.get(p)`, `.set(p, …)`, `.has(p)`, `.delete(p)`, `obj[p]`) — the body
 *     dispatches on it; same-string callers just mean one variant is in use.
 *
 * Baseline (`.dead-params-baseline.json`) suppresses known-intentional findings
 * (spec dials, format primitives) that don't fit the load-bearing patterns.
 *
 * Usage:
 *   deno run -A scripts/lint-dead-params.ts
 *     [--json] [--include-server] [--include-test]
 *     [--min-callers=N] [--update-baseline]
 *
 * Exits 1 on non-baselined findings or stale baseline entries.
 */

import fs from "node:fs";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type MethodDeclaration,
  Node,
  type ParameterDeclaration,
  Project,
  SyntaxKind,
  type Node as TsNode,
} from "ts-morph";

interface DeadParam {
  file: string;
  line: number;
  fnName: string;
  paramName: string;
  paramIndex: number;
  pattern: "always-omitted" | "always-same-literal" | "always-undefined";
  callerCount: number;
  detail: string;
}

interface CallSite {
  args: TsNode[];
}

type Callable = FunctionDeclaration | ArrowFunction | MethodDeclaration;

type ClassifiedArg = "omitted" | "other" | { value: string };

const DEFAULT_MIN_CALLERS = 2;
const BASELINE_FILE = ".dead-params-baseline.json";
const LOOKUP_METHODS = new Set(["get", "set", "has", "delete"]);

main();

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const includeServer = args.includes("--include-server");
  const includeTest = args.includes("--include-test");
  const updateBaseline = args.includes("--update-baseline");
  const minCallersArg = args.find((argText) =>
    argText.startsWith("--min-callers="),
  );
  const minCallers = minCallersArg
    ? Math.max(
        1,
        Number.parseInt(minCallersArg.split("=")[1] ?? "", 10) ||
          DEFAULT_MIN_CALLERS,
      )
    : DEFAULT_MIN_CALLERS;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Always load everything so cross-tree references resolve.
  project.addSourceFilesAtPaths("src/**/*.ts");
  project.addSourceFilesAtPaths("server/**/*.ts");
  project.addSourceFilesAtPaths("test/**/*.ts");

  const findings: DeadParam[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");

    const inReportScope =
      relPath.startsWith("src/") ||
      (includeServer && relPath.startsWith("server/")) ||
      (includeTest && relPath.startsWith("test/"));
    if (!inReportScope) continue;

    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const nameNode = fn.getNameNode();
      if (!nameNode) continue;
      analyze(
        fn,
        nameNode,
        name,
        fn.getStartLineNumber(),
        relPath,
        minCallers,
        findings,
      );
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (!init) continue;
      const nameNode = varDecl.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      analyze(
        init,
        nameNode,
        varDecl.getName(),
        varDecl.getStartLineNumber(),
        relPath,
        minCallers,
        findings,
      );
    }

    for (const cls of sourceFile.getClasses()) {
      // Conservative: any subclass / interface implementor is skipped wholesale
      // — methods may be parent-contract overrides whose signature we can't change.
      if (cls.getExtends() || cls.getImplements().length > 0) continue;

      for (const method of cls.getMethods()) {
        if (method.hasOverrideKeyword()) continue;
        if (method.isAbstract()) continue;
        const nameNode = method.getNameNode();
        if (!Node.isIdentifier(nameNode)) continue;
        analyze(
          method,
          nameNode,
          method.getName(),
          method.getStartLineNumber(),
          relPath,
          minCallers,
          findings,
        );
      }
    }
  }

  // ── Baseline update mode ───────────────────────────────────────
  if (updateBaseline) {
    const keys = findings.map(paramKey).sort();
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(keys, null, 2)}\n`);
    console.log(`✔ Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    return;
  }

  // ── Filter by baseline ─────────────────────────────────────────
  const baseline = loadBaseline();
  const newFindings = findings.filter((f) => !baseline.has(paramKey(f)));
  const currentKeys = new Set(findings.map(paramKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  if (asJson) {
    console.log(
      JSON.stringify(
        { findings: newFindings, staleBaselineEntries: staleEntries },
        null,
        2,
      ),
    );
    if (newFindings.length > 0 || staleEntries.length > 0) process.exit(1);
    return;
  }
  reportText(
    newFindings,
    project.getSourceFiles().length,
    findings.length - newFindings.length,
    staleEntries,
  );
  if (newFindings.length > 0 || staleEntries.length > 0) process.exit(1);
}

function analyze(
  fn: Callable,
  nameNode: TsNode,
  name: string,
  line: number,
  file: string,
  minCallers: number,
  findings: DeadParam[],
): void {
  const params = fn.getParameters();
  if (params.length === 0) return;

  const callSites = collectCallSites(nameNode);
  if (callSites === null) return; // referenced as value somewhere — bail
  if (callSites.length < minCallers) return;

  for (let i = 0; i < params.length; i++) {
    const finding = checkParam(params[i]!, i, callSites, fn, name, file, line);
    if (finding) findings.push(finding);
  }
}

/**
 * Walk all references to `nameNode`. Return null if any reference is not a
 * direct call (i.e. the function leaks as a value). Otherwise return the list
 * of call expressions' argument lists.
 */
function collectCallSites(nameNode: TsNode): CallSite[] | null {
  if (!Node.isIdentifier(nameNode)) return null;

  let refs: TsNode[];
  try {
    refs = nameNode.findReferencesAsNodes();
  } catch {
    return null;
  }

  const sites: CallSite[] = [];
  for (const ref of refs) {
    if (ref === nameNode) continue;
    const parent = ref.getParent();
    if (!parent) return null;

    // foo(...)
    if (Node.isCallExpression(parent) && parent.getExpression() === ref) {
      sites.push({ args: parent.getArguments() });
      continue;
    }

    // obj.foo(...) — ref is the property name
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === ref
    ) {
      const grand = parent.getParent();
      if (
        grand &&
        Node.isCallExpression(grand) &&
        grand.getExpression() === parent
      ) {
        sites.push({ args: grand.getArguments() });
        continue;
      }
      return null; // method passed as a value
    }

    // Re-export / import / typeof — neutral, doesn't escape as value
    if (Node.isExportSpecifier(parent)) continue;
    if (Node.isImportSpecifier(parent)) continue;
    if (Node.isTypeQuery(parent)) continue;

    // Anything else (assignment, JSX attr, array literal, etc.) — leaked as value.
    return null;
  }
  return sites;
}

function checkParam(
  param: ParameterDeclaration,
  paramIndex: number,
  callSites: CallSite[],
  fn: Callable,
  fnName: string,
  file: string,
  line: number,
): DeadParam | null {
  if (param.getDotDotDotToken()) return null;
  const paramNameNode = param.getNameNode();
  if (!Node.isIdentifier(paramNameNode)) return null;
  const paramName = paramNameNode.getText();
  if (paramName === "this") return null;

  // ── Load-bearing exclusions ───────────────────────────────────
  if (paramName.startsWith("_")) return null;
  if (isStringLiteralUnion(param)) return null;
  if (isParamUsedAsLookupKey(paramName, fn)) return null;

  const isOptional = param.isOptional() || param.hasInitializer();

  const classified: ClassifiedArg[] = [];
  for (const site of callSites) {
    const arg = site.args[paramIndex];
    if (arg === undefined) {
      classified.push("omitted");
      continue;
    }
    if (Node.isSpreadElement(arg)) return null;
    classified.push(classifyArg(arg));
  }

  // Pattern A: always-omitted (only meaningful for optional/default params)
  if (isOptional && classified.every((entry) => entry === "omitted")) {
    const init = param.getInitializer()?.getText();
    return {
      file,
      line,
      fnName,
      paramName,
      paramIndex,
      pattern: "always-omitted",
      callerCount: callSites.length,
      detail: init ? `default = ${init}` : "optional, never passed",
    };
  }

  // Pattern C: always-undefined (mix of omits + explicit `undefined`)
  let hasExplicitUndefined = false;
  let allUndefinedish = true;
  for (const entry of classified) {
    if (entry === "omitted") {
      if (!isOptional) {
        allUndefinedish = false;
        break;
      }
    } else if (entry === "other") {
      allUndefinedish = false;
      break;
    } else if (entry.value === "undefined") {
      hasExplicitUndefined = true;
    } else {
      allUndefinedish = false;
      break;
    }
  }
  if (allUndefinedish && hasExplicitUndefined) {
    return {
      file,
      line,
      fnName,
      paramName,
      paramIndex,
      pattern: "always-undefined",
      callerCount: callSites.length,
      detail: "every caller passes undefined or omits",
    };
  }

  // Pattern B: every caller passes the same non-undefined literal
  const literals = new Set<string>();
  let allLiteral = true;
  for (const entry of classified) {
    if (entry === "omitted" || entry === "other") {
      allLiteral = false;
      break;
    }
    literals.add(entry.value);
  }
  if (allLiteral && literals.size === 1) {
    const value = [...literals][0]!;
    if (value === "undefined") {
      return {
        file,
        line,
        fnName,
        paramName,
        paramIndex,
        pattern: "always-undefined",
        callerCount: callSites.length,
        detail: "every caller passes undefined",
      };
    }
    return {
      file,
      line,
      fnName,
      paramName,
      paramIndex,
      pattern: "always-same-literal",
      callerCount: callSites.length,
      detail: `every caller passes ${value}`,
    };
  }

  return null;
}

function classifyArg(arg: TsNode): ClassifiedArg {
  if (Node.isNumericLiteral(arg)) return { value: arg.getText() };
  if (Node.isStringLiteral(arg)) return { value: arg.getText() };
  if (Node.isNoSubstitutionTemplateLiteral(arg))
    return { value: arg.getText() };
  const kind = arg.getKind();
  if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword) {
    return { value: arg.getText() };
  }
  if (kind === SyntaxKind.NullKeyword) return { value: "null" };
  if (Node.isIdentifier(arg) && arg.getText() === "undefined") {
    return { value: "undefined" };
  }
  return "other";
}

/**
 * Returns true if the param's type resolves to a union of string literals
 * (a discriminator like `"readonly" | "readwrite"`). Optional params: undefined
 * and null members are stripped before the check.
 */
function isStringLiteralUnion(param: ParameterDeclaration): boolean {
  const type = param.getType();
  if (!type.isUnion()) return false;
  const nonNullish = type
    .getUnionTypes()
    .filter((member) => !member.isUndefined() && !member.isNull());
  if (nonNullish.length < 2) return false;
  return nonNullish.every((member) => member.isStringLiteral());
}

/**
 * Returns true if the param is used inside the function body as a lookup key:
 *   - `map.get(param)` / `.set(param, …)` / `.has(param)` / `.delete(param)`
 *   - `obj[param]` (computed property access)
 *
 * Same-literal callers don't make such a param dead — the body dispatches on
 * the value, so each caller's choice produces a different result/cache key.
 */
function isParamUsedAsLookupKey(paramName: string, fn: Callable): boolean {
  const body = fn.getBody();
  if (!body) return false;

  for (const ident of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (ident.getText() !== paramName) continue;
    const parent = ident.getParent();
    if (!parent) continue;

    // obj[param]
    if (
      Node.isElementAccessExpression(parent) &&
      parent.getArgumentExpression() === ident
    ) {
      return true;
    }

    // .get(param) / .set(param, …) / .has(param) / .delete(param)
    if (Node.isCallExpression(parent)) {
      const callArgs = parent.getArguments();
      if (!callArgs.includes(ident)) continue;
      const callee = parent.getExpression();
      if (Node.isPropertyAccessExpression(callee)) {
        if (LOOKUP_METHODS.has(callee.getName())) return true;
      }
    }
  }
  return false;
}

function paramKey(p: {
  file: string;
  fnName: string;
  paramName: string;
}): string {
  return `${p.file}:${p.fnName}:${p.paramName}`;
}

function loadBaseline(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    return new Set(raw as string[]);
  } catch {
    return new Set();
  }
}

function reportText(
  findings: DeadParam[],
  fileCount: number,
  baselinedCount: number,
  staleEntries: string[],
): void {
  if (findings.length === 0 && staleEntries.length === 0) {
    const suffix = baselinedCount > 0 ? `, ${baselinedCount} baselined` : "";
    console.log(
      `✔ No dead parameters detected (${fileCount} files scanned${suffix})`,
    );
    return;
  }

  if (findings.length > 0) {
    const byPattern = new Map<DeadParam["pattern"], DeadParam[]>();
    for (const finding of findings) {
      const list = byPattern.get(finding.pattern) ?? [];
      list.push(finding);
      byPattern.set(finding.pattern, list);
    }

    console.log(`✘ ${findings.length} dead parameter(s) found:\n`);
    for (const [pattern, list] of byPattern) {
      console.log(`  [${pattern}] (${list.length})`);
      for (const finding of list) {
        console.log(
          `    ${finding.file}:${finding.line}  ${finding.fnName}(...${finding.paramName}@${finding.paramIndex})  ` +
            `${finding.callerCount} callers — ${finding.detail}`,
        );
      }
      console.log("");
    }
  }

  if (staleEntries.length > 0) {
    console.log(
      `  ✘ ${staleEntries.length} stale baseline entry/entries (remove from ${BASELINE_FILE}):\n`,
    );
    for (const key of staleEntries) {
      console.log(`    ${key}`);
    }
  }
}
