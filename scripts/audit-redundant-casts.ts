/**
 * Audit `as` casts whose inferred inner type is already assignable to the
 * asserted type — the cast adds no information the type system doesn't
 * already know. AUDIT-ONLY: no baseline, no exit code logic. Run before
 * promoting to a baseline-aware lint.
 *
 * Detection:
 *   For every `expr as T` and `<T>expr`:
 *     - Skip `as const` (semantically load-bearing).
 *     - Skip `as any` / `as unknown` (explicit escape hatches).
 *     - Skip when inferred or asserted is `any`/`unknown`/`never`.
 *     - Skip empty-literal widening (`[] as Foo[]`, `{} as Bar`) — the cast
 *       primes inference rather than restating it.
 *     - Skip `null` / `undefined` literal init — same reason.
 *     - Flag `expr as unknown as T` chains separately (the inner half is
 *       the escape valve; the outer half rarely buys anything).
 *     - Flag if `inferredType.text === assertedType.text` (clearly identity).
 *     - Flag if the compiler reports `isTypeAssignableTo(inferred, asserted)`.
 *
 * Output (default): human-readable, grouped by reason, then by file.
 * Output (`--json`): JSON array.
 *
 * Known false-positive class — ts-morph's `inner.getType()` can be
 * contextually influenced by the surrounding cast. For `expr as T` it
 * can return the type after the cast has resolved generic / inference
 * choices, not the type `expr` would have if the cast were deleted.
 * Two visible patterns from the first run:
 *   - Generic-call return narrowing: `el.closest(sel) as HTMLElement | null`.
 *     `closest()` actually returns `Element | null`; the cast genuinely
 *     narrows. The audit reports both sides as `HTMLElement | null`
 *     (post-cast) and flags as "same".
 *   - Tuple coercion: `[a, b] as [number, number]`. Without the cast
 *     the inner array literal would infer as `number[]`; the cast does
 *     real work. The audit sees `[number, number]` on both sides.
 * Treat "same" findings that involve generic-method return values or
 * literal-shape coercions with skepticism. Manual review remains required.
 *
 * Usage:
 *   deno run -A scripts/audit-redundant-casts.ts [options]
 *
 * Scope: src/ and dev/ by default (dev tooling is linted alongside src/).
 *
 * Options:
 *   --server         Also include server/ files
 *   --test           Also include test/ files
 *   --json           Emit JSON instead of human-readable
 *   --filter=<re>    Only show findings whose file path matches the regex
 */

import process from "node:process";
import { Node, Project, SyntaxKind } from "ts-morph";

type Reason = "same" | "assignable" | "double-unknown";

interface Finding {
  file: string;
  line: number;
  text: string;
  inner: string;
  asserted: string;
  reason: Reason;
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

  const checker = project.getTypeChecker().compilerObject;
  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    if (filter && !filter.test(relPath)) continue;

    for (const node of sf.getDescendantsOfKind(SyntaxKind.AsExpression)) {
      const finding = checkCast(node, relPath, checker);
      if (finding) findings.push(finding);
    }
    for (const node of sf.getDescendantsOfKind(
      SyntaxKind.TypeAssertionExpression,
    )) {
      const finding = checkCast(node, relPath, checker);
      if (finding) findings.push(finding);
    }
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;

  if (findings.length === 0) {
    console.log(`✔ No redundant casts found (${fileCount} files audited)`);
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${findings.length} suspect cast(s):\n`,
  );

  for (const reason of ["same", "assignable", "double-unknown"] as const) {
    const list = findings.filter((f) => f.reason === reason);
    if (list.length === 0) continue;
    console.log(`── ${reason} (${list.length}) ──────────────────────────────`);
    list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    let lastFile = "";
    for (const f of list) {
      if (f.file !== lastFile) {
        console.log(`\n  ${f.file}`);
        lastFile = f.file;
      }
      console.log(`    :${f.line}  ${truncate(f.text, 60)}`);
      console.log(
        `           ${truncate(f.inner, 70)}  →  ${truncate(f.asserted, 70)}`,
      );
    }
    console.log("");
  }
}

function checkCast(
  node: Node,
  file: string,
  checker: { isTypeAssignableTo(a: unknown, b: unknown): boolean },
): Finding | null {
  if (!Node.isAsExpression(node) && !Node.isTypeAssertion(node)) return null;

  const inner = node.getExpression();
  const typeNode = node.getTypeNode();
  if (!inner || !typeNode) return null;

  const assertedText = typeNode.getText();

  // Escape hatches: `as const`, `as any`, `as unknown`
  if (assertedText === "const") return null;
  if (assertedText === "any") return null;
  if (assertedText === "unknown") return null;

  // Empty-literal widening: `[] as Foo[]`, `{} as Bar`
  if (
    Node.isArrayLiteralExpression(inner) &&
    inner.getElements().length === 0
  ) {
    return null;
  }
  if (
    Node.isObjectLiteralExpression(inner) &&
    inner.getProperties().length === 0
  ) {
    return null;
  }

  // Literal nullish init: `null as T | null`, `undefined as ...`
  if (inner.getKind() === SyntaxKind.NullKeyword) return null;
  if (Node.isIdentifier(inner) && inner.getText() === "undefined") return null;

  // `expr as unknown as T` chain — surface the outer half once.
  if (Node.isAsExpression(inner)) {
    const innerTypeNode = inner.getTypeNode();
    if (innerTypeNode && innerTypeNode.getText() === "unknown") {
      return {
        file,
        line: node.getStartLineNumber(),
        text: truncate(node.getText(), 80),
        inner: inner.getText(),
        asserted: assertedText,
        reason: "double-unknown",
      };
    }
  }

  const innerType = inner.getType();
  const assertedType = node.getType();

  if (innerType.isAny() || innerType.isUnknown() || innerType.isNever()) {
    return null;
  }
  if (
    assertedType.isAny() ||
    assertedType.isUnknown() ||
    assertedType.isNever()
  ) {
    return null;
  }

  const innerText = cleanType(innerType.getText());
  const assertedTypeText = cleanType(assertedType.getText());

  if (innerText === assertedTypeText) {
    return {
      file,
      line: node.getStartLineNumber(),
      text: truncate(node.getText(), 80),
      inner: innerText,
      asserted: assertedTypeText,
      reason: "same",
    };
  }

  let assignable = false;
  try {
    assignable = checker.isTypeAssignableTo(
      innerType.compilerType,
      assertedType.compilerType,
    );
  } catch {
    return null;
  }

  if (assignable) {
    return {
      file,
      line: node.getStartLineNumber(),
      text: truncate(node.getText(), 80),
      inner: innerText,
      asserted: assertedTypeText,
      reason: "assignable",
    };
  }

  return null;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

function cleanType(text: string): string {
  return text.replace(/import\("[^"]+"\)\./g, "");
}
