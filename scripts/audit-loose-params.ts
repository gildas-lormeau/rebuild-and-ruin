/**
 * Audit function/method parameters typed `number` whose every caller passes
 * the SAME branded subtype of `number`. The parameter could be tightened
 * to the brand without changing any callsite.
 *
 * Catches the "loose param + branded call" pattern: helpers accept
 * `number` defensively while every real call passes `TileKey` /
 * `ValidPlayerId` / `TowerIdx` etc. Useful when adding brands — the
 * declaration is the natural place to enforce the constraint instead of
 * casting at every call site.
 *
 * Detection:
 *   For each parameter declared `number` (or `number | undefined`) on:
 *     - FunctionDeclaration
 *     - MethodDeclaration / MethodSignature
 *     - ArrowFunction / FunctionExpression bound to a VariableDeclaration
 *
 *   Walk every reference to the function. For each direct CallExpression
 *   (function is the callee, not a higher-order argument), take the
 *   argument at the parameter's positional index and record its inferred
 *   type. If every call provides the SAME branded subtype of `number`
 *   (text != "number", assignable to number), suggest tightening.
 *
 * AUDIT-ONLY: no baseline, no exit code logic. Heuristic — review each
 * finding before applying.
 *
 * Known FP class — validator functions. Helpers like `validPid(pid: number)`
 * intentionally accept a wider type so they can run runtime checks
 * (`Number.isInteger(pid) && pid >= 0 && pid < N`). Even when every src/
 * caller already provides a brand, the wider param is load-bearing for
 * defense-in-depth at the trust boundary. Reject these findings during
 * review.
 *
 * Output (default): human-readable, grouped by suggested target type.
 * Output (--json): JSON array.
 *
 * Usage:
 *   deno run -A scripts/audit-loose-params.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON
 *   --filter=<re>    Only show findings whose file path matches the regex
 *   --min-calls=N    Require at least N direct calls (default 2 — single-call
 *                    helpers often have a brand-narrow source that's
 *                    coincidental, not contractual)
 */

import process from "node:process";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type MethodDeclaration,
  type MethodSignature,
  type Node,
  type ParameterDeclaration,
  Project,
  SyntaxKind,
} from "ts-morph";

interface CallSite {
  file: string;
  line: number;
  snippet: string;
  argTypeText: string;
}

interface Finding {
  file: string;
  line: number;
  functionName: string;
  paramName: string;
  paramIndex: number;
  currentTypeText: string;
  suggestedTypeText: string;
  callCount: number;
  calls: CallSite[];
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
  const minCallsArg = args.find((a) => a.startsWith("--min-calls="));
  const minCalls = minCallsArg
    ? parseInt(minCallsArg.slice("--min-calls=".length), 10)
    : 2;

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
      collectFromFunctionLike(fn, fn.getNameNode(), relPath, findings);
    }
    for (const m of sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
      const name = m.getNameNode();
      if (name.getKind() === SyntaxKind.Identifier) {
        collectFromFunctionLike(m, name as Identifier, relPath, findings);
      }
    }
    for (const m of sf.getDescendantsOfKind(SyntaxKind.MethodSignature)) {
      const name = m.getNameNode();
      if (name.getKind() === SyntaxKind.Identifier) {
        collectFromFunctionLike(m, name as Identifier, relPath, findings);
      }
    }
    // Arrow / function-expression bound to `const X = (…) => …`
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
      collectFromFunctionLike(
        init as ArrowFunction | FunctionExpression,
        nameNode as Identifier,
        relPath,
        findings,
      );
    }
  }

  const filtered = findings.filter((f) => f.callCount >= minCalls);

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (filtered.length === 0) {
    console.log(`✔ No loose-param drift found (${fileCount} files audited)`);
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${filtered.length} loose param(s):\n`,
  );

  filtered.sort(
    (a, b) =>
      a.suggestedTypeText.localeCompare(b.suggestedTypeText) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  let lastSuggested = "";
  for (const f of filtered) {
    if (f.suggestedTypeText !== lastSuggested) {
      console.log(
        `\n── ${f.currentTypeText} → ${f.suggestedTypeText} ──────────────────────`,
      );
      lastSuggested = f.suggestedTypeText;
    }
    console.log(
      `  ${f.file}:${f.line}  ${f.functionName}(…, ${f.paramName}: ${f.currentTypeText}, …)  [${f.callCount} call${f.callCount === 1 ? "" : "s"}]`,
    );
    for (const c of f.calls.slice(0, 3)) {
      console.log(`    ${c.file}:${c.line}  ${truncate(c.snippet, 64)}`);
    }
    if (f.calls.length > 3) {
      console.log(`    ... and ${f.calls.length - 3} more`);
    }
  }
  console.log("");
}

function collectFromFunctionLike(
  fn:
    | FunctionDeclaration
    | MethodDeclaration
    | MethodSignature
    | ArrowFunction
    | FunctionExpression,
  nameNode: Identifier | undefined,
  file: string,
  out: Finding[],
): void {
  if (!nameNode) return;
  const params = fn.getParameters();
  if (params.length === 0) return;

  // Find loose-number parameter slots first; bail early if none.
  const looseSlots: Array<{ param: ParameterDeclaration; index: number }> = [];
  for (let idx = 0; idx < params.length; idx++) {
    const param = params[idx]!;
    if (param.isRestParameter()) continue;
    const typeNode = param.getTypeNode();
    if (!typeNode) continue;
    const text = typeNode.getText().trim();
    // Match `number` or `number | undefined` (or with parens). Anything
    // wider (e.g. `number | string`) doesn't make sense to brand-tighten.
    if (text !== "number" && text !== "number | undefined") continue;
    looseSlots.push({ param, index: idx });
  }
  if (looseSlots.length === 0) return;

  // Find all call sites for this function.
  const refs = nameNode.findReferencesAsNodes();
  const calls = refs
    .map((ref) => directCallFromReference(ref))
    .filter((c): c is CallExpression => c !== null);
  if (calls.length === 0) return;

  for (const slot of looseSlots) {
    const callSites: CallSite[] = [];
    for (const call of calls) {
      const args = call.getArguments();
      if (slot.index >= args.length) continue; // optional / omitted
      const arg = args[slot.index]!;
      // Skip spread args at the matching index — type can't be mapped 1:1.
      if (arg.getKind() === SyntaxKind.SpreadElement) continue;
      const t = arg.getType();
      if (!t) continue;
      const file2 = arg
        .getSourceFile()
        .getFilePath()
        .replace(`${process.cwd()}/`, "");
      callSites.push({
        file: file2,
        line: arg.getStartLineNumber(),
        snippet: call.getText().slice(0, 100).replace(/\s+/g, " "),
        argTypeText: t.getText(arg),
      });
    }
    if (callSites.length === 0) continue;

    const suggestion = findCommonBrand(
      callSites,
      slot.param.getTypeNode()!.getText().trim(),
    );
    if (!suggestion) continue;

    out.push({
      file,
      line: nameNode.getStartLineNumber(),
      functionName: nameNode.getText(),
      paramName: slot.param.getName(),
      paramIndex: slot.index,
      currentTypeText: slot.param.getTypeNode()!.getText().trim(),
      suggestedTypeText: suggestion,
      callCount: callSites.length,
      calls: callSites,
    });
  }
}

/** Return the CallExpression iff `ref` appears as the callee of a call.
 *  Skips when the reference is itself an argument to a higher-order call
 *  (`arr.map(fn)`), assigned somewhere, etc. — those don't establish a
 *  positional argument relationship we can use. */
function directCallFromReference(ref: Node): CallExpression | null {
  // `fn(…)` — direct CallExpression with the ident as the expression
  const parent = ref.getParent();
  if (!parent) return null;
  if (parent.getKind() === SyntaxKind.CallExpression) {
    const call = parent.asKindOrThrow(SyntaxKind.CallExpression);
    if (call.getExpression() === ref) return call;
    return null;
  }
  // `obj.method(…)` — ref is in a PropertyAccessExpression that's the
  // callee of a CallExpression. Methods reach this branch.
  if (parent.getKind() === SyntaxKind.PropertyAccessExpression) {
    const pae = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pae.getNameNode() !== ref) return null;
    const grand = pae.getParent();
    if (grand && grand.getKind() === SyntaxKind.CallExpression) {
      const call = grand.asKindOrThrow(SyntaxKind.CallExpression);
      if (call.getExpression() === pae) return call;
    }
    return null;
  }
  return null;
}

/** Find a brand text that every call's argument shares. Same logic as
 *  audit-array-element-drift but applied to argument type text. */
function findCommonBrand(
  calls: CallSite[],
  currentText: string,
): string | null {
  if (calls.length === 0) return null;
  const distinct = new Set<string>();
  for (const c of calls) {
    const txt = normalizeTypeText(c.argTypeText);
    if (txt === "any" || txt === "never") return null;
    distinct.add(txt);
  }
  if (distinct.size !== 1) return null;
  const only = [...distinct][0]!;
  if (only === currentText) return null;
  if (only === "number") return null;
  if (only === "number | undefined") return null;
  // `undefined` as the only argument type means every src/ caller passes
  // `undefined`; the param is effectively unused in src/. The right fix
  // depends on out-of-scope callers (tests, dev) and isn't a brand
  // tightening — leave this for audit:optional / dead-params.
  if (only === "undefined") return null;
  // Skip literal-number and unions-of-literal-numbers — not brand
  // tightenings, just constant-call patterns.
  if (/^-?\d+(?:\.\d+)?(?:\s*\|\s*-?\d+(?:\.\d+)?)*$/.test(only)) return null;
  return only;
}

function normalizeTypeText(text: string): string {
  const m = text.match(/^import\([^)]+\)\.(.+)$/);
  return m ? m[1]! : text;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
