/**
 * audit-closure-captures — flag inner closures that capture N+ stable
 * locals from their enclosing function.
 *
 * Pattern:
 *
 *     function castleRect(state, ...) {
 *       const margin = ...; const tiles = ...;
 *       const towers = ...; const tower = ...;
 *       const maxMarginForSide = (side: Side) => {
 *         // body uses margin, tiles, towers, tower
 *       };
 *       maxMarginForSide("top");
 *       maxMarginForSide("bottom");
 *       maxMarginForSide("left");
 *       maxMarginForSide("right");
 *     }
 *
 * Four captured parent locals (`margin`, `tiles`, `towers`, `tower`),
 * four invocations with identical captures. The closure is doing
 * hidden partial application — lifting it to module scope with an
 * explicit params object (`MarginCtx`) makes the data-flow visible.
 *
 * What counts as a capture:
 *   - Identifier in the closure body that resolves (via `getDefinitions`)
 *     to a declaration sitting in an ancestor function strictly between
 *     the closure and module scope.
 *   - NOT counted: imports, module-scope declarations, identifiers
 *     declared inside the closure itself, property names in `a.b`,
 *     identifiers inside type annotations.
 *
 * Closure kinds scanned: ArrowFunction, FunctionExpression. Top-level
 * declarations and method bodies aren't closures.
 *
 * Scope:
 *   src/**\/*.ts (excluding *.d.ts and *.test.ts)
 *
 * Usage:
 *   deno run -A scripts/audit-closure-captures.ts [--threshold N]
 *
 * Audit-only: exits 0 even if findings exist.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type ArrowFunction,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

type ClosureRole =
  | "factory-return" // value of a return statement (directly or in returned obj)
  | "iterator-callback" // arg to .map/.forEach/.filter/etc.
  | "listener-arg" // arg to addEventListener / setTimeout / bus.on / etc.
  | "named-local-multi" // const X = ...; X() called 2+ times in parent body
  | "named-local-once" // const X = ...; X() called 0-1 times
  | "other";

interface Finding {
  file: string;
  closureLine: number;
  closureKind: "arrow" | "function-expr";
  parentFnLine: number;
  parentFnName: string;
  captures: string[];
  role: ClosureRole;
  callCount: number;
}

type FnLike =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

const ITERATOR_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "reduce",
  "reduceRight",
  "some",
  "every",
  "flatMap",
  "flat",
  "sort",
  "from",
  "of",
  "keys",
  "values",
  "entries",
]);
const LISTENER_CALLEES = new Set([
  "addEventListener",
  "removeEventListener",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
  "Promise",
  "then",
  "catch",
  "finally",
  "on",
  "once",
  "off",
  "subscribe",
  "subscribeBus",
]);
const REFACTOR_CANDIDATE_ROLES: ReadonlySet<ClosureRole> = new Set([
  "named-local-multi",
]);
const ROOT = path.resolve(import.meta.dirname!, "..");
const SRC_DIR = path.join(ROOT, "src");

main();

function main(): void {
  const args = process.argv.slice(2);
  const thresholdIdx = args.indexOf("--threshold");
  const threshold =
    thresholdIdx >= 0 ? Number.parseInt(args[thresholdIdx + 1]!, 10) : 3;

  const files = collectSourceFiles(SRC_DIR);
  if (files.length === 0) {
    console.log("✔ No source files to scan");
    return;
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of files) project.addSourceFileAtPath(file);

  const findings: Finding[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    scanFile(sourceFile, threshold, findings);
  }

  const candidates = findings.filter((f) =>
    REFACTOR_CANDIDATE_ROLES.has(f.role),
  );
  const byRole = new Map<ClosureRole, number>();
  for (const f of findings) byRole.set(f.role, (byRole.get(f.role) ?? 0) + 1);

  candidates.sort(
    (a, b) =>
      b.callCount - a.callCount || b.captures.length - a.captures.length,
  );

  console.log(`Total closures with ${threshold}+ captures: ${findings.length}`);
  for (const [role, count] of [...byRole].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(22)} ${count}`);
  }
  console.log("");

  if (candidates.length === 0) {
    console.log(`✔ No named-local-multi candidates`);
    return;
  }

  console.log(
    `${candidates.length} refactor candidate(s) (named-local closures called 2+ times from parent body):\n`,
  );
  for (const finding of candidates) {
    console.log(
      `  ${finding.file}:${finding.closureLine}  ${finding.parentFnName}() @L${finding.parentFnLine}  — captures ×${finding.captures.length}, calls ×${finding.callCount}: ${finding.captures.join(", ")}`,
    );
  }
  console.log("");
  console.log(
    "Consider lifting these to module scope with an explicit params object.",
  );
}

function scanFile(
  sourceFile: SourceFile,
  threshold: number,
  out: Finding[],
): void {
  const relPath = path.relative(ROOT, sourceFile.getFilePath());

  const closures: Array<ArrowFunction | FunctionExpression> = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];

  for (const closure of closures) {
    const parentFn = enclosingFn(closure);
    if (!parentFn) continue;

    const captures = collectCaptures(closure, parentFn, sourceFile);
    if (captures.size < threshold) continue;

    const { role, callCount } = classifyClosure(closure, parentFn);

    out.push({
      file: relPath,
      closureLine: closure.getStartLineNumber(),
      closureKind: Node.isArrowFunction(closure) ? "arrow" : "function-expr",
      parentFnLine: parentFn.getStartLineNumber(),
      parentFnName: fnDisplayName(parentFn),
      captures: [...captures].sort(),
      role,
      callCount,
    });
  }
}

/** Classify a closure by how it's used in the source. Drives FP filtering:
 *  factory-return / iterator-callback / listener-arg are intentional closure
 *  semantics. named-local-multi (declared as const, called 2+ times from the
 *  parent body) is the high-value refactor candidate. */
function classifyClosure(
  closure: ArrowFunction | FunctionExpression,
  parentFn: FnLike,
): { role: ClosureRole; callCount: number } {
  // Walk up to find the closure's containing statement / expression.
  // Distinguish (a) inside a return value, (b) call argument, (c) bound to
  // a variable declaration.
  let cursor: Node | undefined = closure.getParent();
  while (cursor && cursor !== parentFn) {
    if (Node.isReturnStatement(cursor)) {
      return { role: "factory-return", callCount: 0 };
    }
    if (Node.isVariableDeclaration(cursor)) {
      const nameNode = cursor.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        const name = nameNode.getText();
        const calls = countCallsInFn(name, parentFn, closure);
        return {
          role: calls >= 2 ? "named-local-multi" : "named-local-once",
          callCount: calls,
        };
      }
      return { role: "other", callCount: 0 };
    }
    if (Node.isCallExpression(cursor)) {
      // Only classify if the closure is a direct argument of this call
      // (not nested deeper, which the outer loop will still walk past).
      const isDirectArg = cursor
        .getArguments()
        .some((arg) => containsNode(arg, closure));
      if (isDirectArg) {
        const callee = cursor.getExpression();
        const calleeName = calleeShortName(callee);
        if (calleeName && ITERATOR_METHODS.has(calleeName)) {
          return { role: "iterator-callback", callCount: 0 };
        }
        if (calleeName && LISTENER_CALLEES.has(calleeName)) {
          return { role: "listener-arg", callCount: 0 };
        }
        return { role: "other", callCount: 0 };
      }
    }
    if (
      Node.isPropertyAssignment(cursor) ||
      Node.isShorthandPropertyAssignment(cursor)
    ) {
      // Object-literal property — likely factory output. Defer to
      // walking up for stronger signal (return statement) but mark as
      // factory-return if we hit a return ancestor.
    }
    cursor = cursor.getParent();
  }
  return { role: "other", callCount: 0 };
}

/** Tail name of a call expression's callee. For `a.b.c(x)` returns "c";
 *  for `f(x)` returns "f"; for indexed / computed callees returns null. */
function calleeShortName(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return null;
}

/** Count call expressions of the form `name(...)` whose enclosing fn is
 *  exactly `parentFn` — i.e. direct parent-body calls. Excludes:
 *   - calls inside `excludeSubtree` (the closure itself, e.g. recursion)
 *   - calls inside any other nested closure declared in `parentFn`
 *     (those callers also pay the capture cost, but the maxMarginForSide
 *     "hidden curry" pattern is specifically about calls from the parent
 *     fn's own body, not shared use across sibling closures). */
function countCallsInFn(
  name: string,
  parentFn: FnLike,
  excludeSubtree: Node,
): number {
  const body = parentFn.getBody?.();
  if (!body) return 0;
  let count = 0;
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (containsNode(excludeSubtree, call)) continue;
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== name) continue;
    if (enclosingFn(call) !== parentFn) continue;
    count++;
  }
  return count;
}

function containsNode(outer: Node, inner: Node): boolean {
  let cursor: Node | undefined = inner;
  while (cursor) {
    if (cursor === outer) return true;
    cursor = cursor.getParent();
  }
  return false;
}

/** Walk up from `node` to find the nearest enclosing fn-like ancestor.
 *  Returns null if the node lives at module scope. */
function enclosingFn(node: Node): FnLike | null {
  let cursor: Node | undefined = node.getParent();
  while (cursor) {
    if (isFnLike(cursor)) return cursor;
    cursor = cursor.getParent();
  }
  return null;
}

function isFnLike(node: Node): node is FnLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/** Free identifiers in `closure`'s body that resolve to a declaration
 *  strictly inside `parentFn` (or any fn between closure and parentFn's
 *  outer scope) but NOT inside `closure` itself. Skips type-only refs
 *  and property-name positions in `a.b`. */
function collectCaptures(
  closure: ArrowFunction | FunctionExpression,
  parentFn: FnLike,
  sourceFile: SourceFile,
): Set<string> {
  const captures = new Set<string>();
  const body = closure.getBody();
  if (!body) return captures;

  for (const identifier of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!isValueReference(identifier)) continue;

    const definitions = identifier.getDefinitions();
    if (definitions.length === 0) continue;

    for (const def of definitions) {
      const declNode = def.getDeclarationNode();
      if (!declNode) continue;
      if (declNode.getSourceFile() !== sourceFile) continue;

      // Local to the closure itself → not a capture.
      if (isInsideOrEqual(declNode, closure)) continue;

      // Captured if the declaration sits inside the parent fn (or in any
      // fn between parentFn and module scope). Module-scope declarations
      // are free either way — they don't pin the closure.
      if (isInsideOrEqual(declNode, parentFn)) {
        captures.add(identifier.getText());
        break;
      }
    }
  }

  return captures;
}

function isInsideOrEqual(inner: Node, outer: Node): boolean {
  let cursor: Node | undefined = inner;
  while (cursor) {
    if (cursor === outer) return true;
    cursor = cursor.getParent();
  }
  return false;
}

/** True for identifiers that contribute a runtime closure capture.
 *  Filters out type-position refs and property-name positions in
 *  member access / property assignments. */
function isValueReference(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (!parent) return false;

  // `obj.foo` — `foo` is a property name, not a captured binding.
  if (
    Node.isPropertyAccessExpression(parent) &&
    parent.getName() === identifier.getText() &&
    parent.getNameNode() === identifier
  ) {
    return false;
  }

  // `{ foo: 1 }` — the key isn't a capture.
  if (
    (Node.isPropertyAssignment(parent) ||
      Node.isShorthandPropertyAssignment(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isGetAccessorDeclaration(parent) ||
      Node.isSetAccessorDeclaration(parent)) &&
    parent.getNameNode() === identifier
  ) {
    // Shorthand `{ foo }` IS a capture though — keep it.
    if (Node.isShorthandPropertyAssignment(parent)) return true;
    return false;
  }

  // Type position: `let x: Foo`, `function f(x: Foo)`, `x as Foo`, etc.
  if (isInTypePosition(identifier)) return false;

  // The identifier declaration itself (e.g. `const x = ...`) isn't a
  // reference to a capture — it's a declaration.
  if (
    Node.isVariableDeclaration(parent) &&
    parent.getNameNode() === identifier
  ) {
    return false;
  }
  if (
    Node.isParameterDeclaration(parent) &&
    parent.getNameNode() === identifier
  ) {
    return false;
  }
  if (
    Node.isBindingElement(parent) &&
    (parent.getNameNode() === identifier ||
      parent.getPropertyNameNode() === identifier)
  ) {
    // Destructuring: `const { foo } = obj` — `foo` declares a new binding.
    return false;
  }

  return true;
}

function isInTypePosition(node: Node): boolean {
  let cursor: Node | undefined = node.getParent();
  while (cursor) {
    const kind = cursor.getKind();
    if (
      kind === SyntaxKind.TypeReference ||
      kind === SyntaxKind.TypeQuery ||
      kind === SyntaxKind.TypeAliasDeclaration ||
      kind === SyntaxKind.InterfaceDeclaration ||
      kind === SyntaxKind.TypeLiteral ||
      kind === SyntaxKind.TypeParameter ||
      kind === SyntaxKind.HeritageClause ||
      kind === SyntaxKind.ExpressionWithTypeArguments
    ) {
      return true;
    }
    // Stop at the first statement/expression boundary; types don't cross.
    if (
      Node.isStatement(cursor) ||
      kind === SyntaxKind.PropertyAssignment ||
      kind === SyntaxKind.BinaryExpression
    ) {
      return false;
    }
    cursor = cursor.getParent();
  }
  return false;
}

function fnDisplayName(fn: FnLike): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? "<anonymous>";
  }
  if (Node.isConstructorDeclaration(fn)) return "<constructor>";
  if (Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    return fn.getName();
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return "<arrow>";
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const entryStat = statSync(full, { throwIfNoEntry: false });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entryStat.isFile()) continue;
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}
