/**
 * lint-callback-inversion — flag closure / function-reference arguments
 * whose body references symbols declared at a layer ABOVE the callee.
 *
 * Catches the pattern where high-layer code passes a closure that closes
 * over high-layer symbols into a lower-layer function, effectively
 * letting that lower-layer function invoke higher-layer code at runtime
 * without an import edge to point at. The import-graph layer linter
 * can't see this because the source-level imports respect layers; the
 * inversion lives in the closure's lexical captures.
 *
 * Observed instance (commit 69c555eb): AI brain in `src/ai/ai-phase-cannon.ts`
 * (L8) accepted `executePlaceCannon: (intent) => boolean` from `controller-ai.ts`
 * (L9). The closure body referenced `executePlaceCannon` (declared in
 * `src/game/game-actions.ts` at L13). At runtime, L8 code invoked L13
 * code via the callback. Source imports in L8 only reached L≤7, so the
 * layer linter saw nothing.
 *
 * Rule: for every call expression, find any function-typed argument and
 * resolve every project symbol its body references. If any of those
 * symbols are declared in a file whose layer is strictly greater than
 * the callee's layer, flag it.
 *
 * False-negative-friendly: we only resolve symbols ts-morph can pin to
 * a project source file. Dynamic dispatch and runtime-bound references
 * aren't tracked. The blunt structural ban (option B — outright banning
 * function-typed parameters in low-layer exports) was rejected in
 * favour of this precision check, so HOF utilities like `memoize`,
 * `forEachCannonTile` etc. produce zero noise.
 *
 * Allow-marker (`// lint:allow-callback-inversion -- <reason>`) on the
 * call line, the preceding line, or the parameter's declaration in the
 * receiving function. Use sparingly — every allow is a documented
 * cross-layer coupling.
 *
 * Usage:
 *   deno run -A scripts/lint-callback-inversion.ts
 *
 * Exits 1 on violations.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { Node, Project, SyntaxKind, type Type } from "ts-morph";

interface Violation {
  callFile: string;
  callLine: number;
  callee: string;
  calleeFile: string;
  calleeLayer: number;
  refName: string;
  refFile: string;
  refLayer: number;
}

interface RefHit {
  symbol: import("ts-morph").Symbol;
  name: string;
}

interface DeclInfo {
  file: string;
  layer: number;
}

interface LayerGroup {
  name: string;
  files: string[];
}

const ALLOW_MARKER = "lint:allow-callback-inversion";

main();

function main(): void {
  const fileToLayer = loadLayerMap();
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(["src/**/*.ts"]);

  const violations: Violation[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.getFilePath().endsWith(".d.ts")) continue;
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      analyzeCall(node, fileToLayer, violations);
    });
  }

  if (violations.length === 0) {
    console.log("lint-callback-inversion: clean");
    return;
  }

  for (const v of violations) {
    const rel = relPath(v.callFile);
    const refRel = relPath(v.refFile);
    const calleeRel = relPath(v.calleeFile);
    console.error(
      `${rel}:${v.callLine}: ${v.callee}(...) at L${v.calleeLayer} (${calleeRel}) ` +
        `receives a closure referencing \`${v.refName}\` declared at L${v.refLayer} (${refRel})`,
    );
  }
  console.error(
    `\n${violations.length} violation(s). See scripts/lint-callback-inversion.ts header for the rule.`,
  );
  process.exit(1);
}

function analyzeCall(
  call: import("ts-morph").CallExpression,
  fileToLayer: Map<string, number>,
  out: Violation[],
): void {
  const callee = call.getExpression();
  const calleeInfo = resolveDeclaringFile(callee, fileToLayer);
  if (!calleeInfo) return;
  const calleeLayer = calleeInfo.layer;

  const calleeType = callee.getType();
  const callSignatures = calleeType.getCallSignatures();
  if (callSignatures.length === 0) return;
  // Pick the signature whose arity best matches the call. For overloaded
  // declarations TS picks one canonically; we approximate by preferring
  // the first signature with parameter count >= argument count.
  const args = call.getArguments();
  const signature =
    callSignatures.find((s) => s.getParameters().length >= args.length) ??
    callSignatures[0]!;
  const sigParams = signature.getParameters();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const paramSym = sigParams[i] ?? sigParams[sigParams.length - 1];
    if (!paramSym) continue;
    const paramType = paramSym.getTypeAtLocation(callee);
    if (!isFunctionType(paramType)) continue;

    const unwrapped = unwrapParenthesized(arg);
    if (hasAllowMarker(call, unwrapped, paramSym)) continue;

    for (const ref of collectExternalSymbolRefs(unwrapped)) {
      const refInfo = resolveDeclaringFileFromSymbol(ref.symbol, fileToLayer);
      if (!refInfo) continue;
      if (refInfo.layer <= calleeLayer) continue;
      out.push({
        callFile: call.getSourceFile().getFilePath(),
        callLine: call.getStartLineNumber(),
        callee: shortText(callee),
        calleeFile: calleeInfo.file,
        calleeLayer,
        refName: ref.name,
        refFile: refInfo.file,
        refLayer: refInfo.layer,
      });
    }
  }
}

/** Walk identifiers and property-access name nodes inside a function-shaped
 *  argument. For closures, skip declarations local to the closure itself.
 *  For a bare identifier or property access argument (named function ref),
 *  treat the whole node as a single reference. */
function collectExternalSymbolRefs(arg: Node): RefHit[] {
  const hits: RefHit[] = [];
  const seen = new Set<string>();

  function record(node: Node, callableOnly: boolean): void {
    const sym = node.getSymbol();
    if (!sym) return;
    // Filter to callable references only — capturing a vector, constant,
    // or plain data object is fine; only invoking a higher-layer function
    // or method from inside the closure is the inversion we hunt.
    if (callableOnly) {
      const t = sym.getTypeAtLocation(node);
      if (t.getCallSignatures().length === 0) return;
    }
    const name = sym.getName();
    const declFile =
      sym.getDeclarations()?.[0]?.getSourceFile().getFilePath() ?? "";
    const key = `${declFile}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ symbol: sym, name });
  }

  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    const body = arg.getBody();
    if (!body) return hits;
    // Look at what the closure actually CALLS — identifier callees and
    // property-access callees (`obj.method`). Captured non-callable state
    // (scratch buffers, vectors, ids) is not flagged.
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (Node.isIdentifier(callee)) {
        if (isDeclaredInside(callee, arg)) continue;
        record(callee, false);
      } else if (Node.isPropertyAccessExpression(callee)) {
        // Skip if the receiver is a local closure binding (e.g. `tile.set`
        // where `tile` is a closure param — the call target is on a value
        // the closure received, not a captured higher-layer function).
        if (isReceiverLocalToClosure(callee, arg)) continue;
        record(callee.getNameNode(), false);
      }
    }
    for (const newExpr of body.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const callee = newExpr.getExpression();
      if (Node.isIdentifier(callee)) {
        if (isDeclaredInside(callee, arg)) continue;
        record(callee, false);
      }
    }
    return hits;
  }

  // Bare identifier or property access passed as the function argument
  // (named-function reference, e.g. `bus.on(EVENT, handler)`).
  if (Node.isIdentifier(arg)) {
    // Named-fn-ref args: the arg itself IS the callable, so it's trivially
    // callable — no extra filter needed beyond the layer comparison upstream.
    record(arg, false);
  } else if (Node.isPropertyAccessExpression(arg)) {
    record(arg.getNameNode(), false);
  }
  return hits;
}

/** When a property-access callee inside the closure starts from a binding
 *  declared inside the closure itself (param / local), the call target is
 *  on a value the closure received — not a captured higher-layer function.
 *  Walk to the leftmost identifier and check its declaration site. */
function isReceiverLocalToClosure(
  pa: import("ts-morph").PropertyAccessExpression,
  closure: Node,
): boolean {
  let cur: Node = pa.getExpression();
  while (Node.isPropertyAccessExpression(cur) || Node.isCallExpression(cur)) {
    cur = Node.isCallExpression(cur)
      ? cur.getExpression()
      : cur.getExpression();
  }
  if (!Node.isIdentifier(cur)) return false;
  return isDeclaredInside(cur, closure);
}

function isDeclaredInside(id: Node, container: Node): boolean {
  const sym = id.getSymbol();
  if (!sym) return false;
  for (const decl of sym.getDeclarations() ?? []) {
    let cur: Node | undefined = decl;
    while (cur) {
      if (cur === container) return true;
      cur = cur.getParent();
    }
  }
  return false;
}

function unwrapParenthesized(node: Node): Node {
  let cur = node;
  while (Node.isParenthesizedExpression(cur)) {
    cur = cur.getExpression();
  }
  return cur;
}

function isFunctionType(t: Type): boolean {
  if (t.getCallSignatures().length > 0) return true;
  if (t.isUnion()) {
    return t.getUnionTypes().some((u) => u.getCallSignatures().length > 0);
  }
  return false;
}

function resolveDeclaringFile(
  node: Node,
  fileToLayer: Map<string, number>,
): DeclInfo | null {
  const sym = node.getSymbol();
  if (!sym) return null;
  return resolveDeclaringFileFromSymbol(sym, fileToLayer);
}

function resolveDeclaringFileFromSymbol(
  symbol: import("ts-morph").Symbol,
  fileToLayer: Map<string, number>,
): DeclInfo | null {
  // Follow re-export aliases to the original declaration.
  let target = symbol;
  try {
    const aliased = target.getAliasedSymbol();
    if (aliased) target = aliased;
  } catch {
    // not aliased
  }
  const decls = target.getDeclarations() ?? [];
  for (const decl of decls) {
    const k = decl.getKind();
    if (
      k === SyntaxKind.ImportSpecifier ||
      k === SyntaxKind.ImportClause ||
      k === SyntaxKind.NamespaceImport ||
      k === SyntaxKind.NamedImports
    ) {
      continue;
    }
    const file = decl.getSourceFile().getFilePath();
    const layer = fileToLayer.get(relPath(file));
    if (layer === undefined) return null;
    return { file, layer };
  }
  return null;
}

function hasAllowMarker(
  call: Node,
  arg: Node,
  paramSym: import("ts-morph").Symbol,
): boolean {
  // Same line or preceding line on the call site.
  const sourceFile = call.getSourceFile();
  const fullText = sourceFile.getFullText();
  const lineStart = (line: number): number => {
    const offset = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      line - 1,
      0,
    );
    return offset;
  };
  const callLine = call.getStartLineNumber();
  const checkLineRange = (fromLine: number, toLine: number): boolean => {
    const from = lineStart(fromLine);
    const to =
      toLine >= sourceFile.getEndLineNumber()
        ? fullText.length
        : lineStart(toLine + 1);
    return fullText.slice(from, to).includes(ALLOW_MARKER);
  };
  if (checkLineRange(Math.max(1, callLine - 1), callLine)) return true;
  // Also check the argument's full span — long inline closures wrap.
  const argStart = arg.getStartLineNumber();
  const argEnd = arg.getEndLineNumber();
  if (checkLineRange(argStart, argEnd)) return true;
  // Receiving-side: the containing function-like declaration (including
  // leading JSDoc / line comments). A single marker on the bus.on /
  // setTimeout / etc. signature suppresses every caller — that's the
  // sustainable surface for documenting "this callback shape is
  // intentional observer / scheduler API."
  for (const paramDecl of paramSym.getDeclarations() ?? []) {
    if (containerHasMarker(paramDecl)) return true;
  }
  return false;
}

function containerHasMarker(paramDecl: Node): boolean {
  // Walk up checking the immediate function-like container AND its
  // surrounding interface / type alias. A marker on the interface header
  // documents the whole API as observer/scheduler in one place (e.g.
  // TimingApi, GameEventBus, NetworkApi).
  let cur: Node | undefined = paramDecl;
  let crossedFn = false;
  while (cur) {
    const k = cur.getKind();
    const isFnLike =
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.MethodSignature ||
      k === SyntaxKind.FunctionType ||
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.FunctionExpression ||
      k === SyntaxKind.PropertySignature ||
      k === SyntaxKind.PropertyDeclaration ||
      k === SyntaxKind.VariableStatement ||
      k === SyntaxKind.TypeAliasDeclaration;
    const isOuter =
      k === SyntaxKind.InterfaceDeclaration ||
      k === SyntaxKind.TypeAliasDeclaration;
    if (isFnLike || (crossedFn && isOuter)) {
      if (cur.getFullText().includes(ALLOW_MARKER)) return true;
      if (isFnLike) crossedFn = true;
      if (isOuter) return false; // stop after one outer container
    }
    cur = cur.getParent();
  }
  return false;
}

function shortText(node: Node): string {
  const t = node.getText();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

function relPath(absPath: string): string {
  return absPath.replace(`${process.cwd()}/`, "");
}

function loadLayerMap(): Map<string, number> {
  const raw = readFileSync(".import-layers.json", "utf-8");
  const groups: LayerGroup[] = JSON.parse(raw);
  const map = new Map<string, number>();
  for (const group of groups) {
    const match = /^L(\d+)$/.exec(group.name);
    if (!match) continue;
    const layer = parseInt(match[1]!, 10);
    for (const file of group.files) {
      map.set(file, layer);
    }
  }
  return map;
}
