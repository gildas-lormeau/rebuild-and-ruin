/**
 * Detect monotone state — fields/variables that are always assigned the
 * same value and never reset. Suggests the storage carries no dynamic
 * information and can be replaced with a derived check.
 *
 * Catches PURE monotone storage: ≥ MIN_WRITES reassignments, every RHS the
 * same recognized constant (literal, all-uppercase identifier, enum-shaped
 * access, empty `new Set()`/`new Map()`), and no non-constant write to the
 * same storage anywhere. Synthetic example: a closure `let armed = false;`
 * with three `armed = true;` reassignments and nothing else → flagged.
 *
 * Inspired by `f6da5f45` (zoomActivated), but does NOT catch that specific
 * commit's pattern: zoomActivated had one `zoomActivated = mobileZoomEnabled`
 * write alongside the `= true` ones, and the non-constant write trips this
 * lint's "any dynamic write disqualifies the location" filter. That case
 * sits in the mirror-state class (see proposal B), not pure monotone.
 *
 * Two trackable storage kinds:
 *   1. Object property writes — `state.X.Y = RHS` (with simple alias
 *      tracking for `const X = state.Y`).
 *   2. Closure `let` reassignments — `let X = init;` declared at the top
 *      of a function/arrow/module, then reassigned `X = ...` later. The
 *      initializer is NOT counted (every default-init field would
 *      otherwise look monotone).
 *
 * Algorithm:
 *   1. Walk all assignments and collect the RHS canonical text per storage
 *      location, scoped by file + declaration site (so two unrelated lets
 *      named `foo` in different files don't collide).
 *   2. For each location with ≥ MIN_WRITES reassignments, if every RHS
 *      canonical text is identical, flag as monotone.
 *
 * What this does NOT count:
 *   - Initialization in object literals or `let X = INIT`.
 *   - Compound assignments (`+=`, `-=`) and unary ops (`x++`).
 *   - Cross-object replacements (`state.modern = createModernState()`)
 *     that effectively reset sub-fields — those sub-fields will look
 *     monotone here when in fact they're reset elsewhere.
 *   - Fields mutated through methods (`.push`, `.add`, `.delete`,
 *     `.clear`, `.set`, `.pop`, `.shift`) — assignment to `[]` is then
 *     a reset, not a monotone write.
 *
 * To suppress walker-pattern false positives (`cursor = nextCursor`
 * iterated with different runtime values per write), only RHS forms
 * whose value is recognizably constant at write time are counted:
 *   - literals (`true`, `null`, `42`, `""`, `[]`, `{}`)
 *   - all-uppercase identifiers (`MY_CONST`)
 *   - property access ending in an all-uppercase segment (`Phase.BATTLE`)
 *   - empty `new Set()` / `new Map()`
 * Bare mixed-case identifiers and compound expressions are skipped.
 *
 * Usage:
 *   deno run -A scripts/lint-monotone-state.ts [--update-baseline]
 *
 * Baseline: .monotone-state-baseline.json — entries "key:value".
 */

import fs from "node:fs";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
} from "ts-morph";

interface RhsRecord {
  text: string;
  file: string;
  line: number;
}

interface Location {
  key: string;
  display: string;
  file: string;
  line: number;
  rhsValues: RhsRecord[];
  hasNonConstantWrite: boolean;
}

const BASELINE_FILE = ".monotone-state-baseline.json";
const MIN_WRITES = 3;
/** Methods whose presence on a path means the field has mutation-driven
 *  population (so assignment-to-empty is reset, not monotone state). */
const MUTATION_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "sort",
  "reverse",
  "copyWithin",
  "add",
  "delete",
  "clear",
  "set",
]);

main();

function main(): void {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(["src/**/*.ts", "dev/**/*.ts"]);

  const locations = new Map<string, Location>();
  for (const sourceFile of project.getSourceFiles()) {
    collectStatePropertyWrites(sourceFile, locations);
    collectLetReassignments(sourceFile, locations);
  }

  const mutatedNames = collectMutatedNames(project.getSourceFiles());

  const violations: { loc: Location; value: string }[] = [];
  for (const loc of locations.values()) {
    if (loc.hasNonConstantWrite) continue;
    if (loc.rhsValues.length < MIN_WRITES) continue;
    if (hasMutationMethodCall(loc, mutatedNames)) continue;
    const first = loc.rhsValues[0]!.text;
    if (loc.rhsValues.every((r) => r.text === first)) {
      violations.push({ loc, value: first });
    }
  }

  violations.sort(
    (a, b) =>
      a.loc.file.localeCompare(b.loc.file) ||
      a.loc.line - b.loc.line ||
      a.loc.display.localeCompare(b.loc.display),
  );

  const keyOf = (entry: { loc: Location; value: string }) =>
    `${entry.loc.key}::=${entry.value}`;
  const currentKeys = new Set(violations.map(keyOf));

  if (updateBaseline) {
    const baseline = violations.map(keyOf).sort();
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote ${baseline.length} entries to ${BASELINE_FILE}`);
    return;
  }

  const baseline = loadBaseline();
  const newViolations = violations.filter((v) => !baseline.has(keyOf(v)));
  const staleKeys = [...baseline].filter((key) => !currentKeys.has(key));

  if (newViolations.length === 0 && staleKeys.length === 0) {
    console.log(
      `✔ monotone-state: ${violations.length} match(es), all in baseline (locations: ${locations.size})`,
    );
    return;
  }

  if (newViolations.length > 0) {
    console.log(
      `✘ ${newViolations.length} new monotone storage location(s):\n`,
    );
    for (const { loc, value } of newViolations) {
      console.log(`  ${loc.file}:${loc.line}  ${loc.display}`);
      console.log(
        `    always = ${truncate(value, 60)}   (${loc.rhsValues.length} writes, no reset)`,
      );
      const sample = loc.rhsValues.slice(0, 3);
      for (const sampleRhs of sample) {
        console.log(`      ${sampleRhs.file}:${sampleRhs.line}`);
      }
      if (loc.rhsValues.length > 3) {
        console.log(`      … +${loc.rhsValues.length - 3} more`);
      }
      console.log();
    }
  }

  if (staleKeys.length > 0) {
    console.log(`✘ ${staleKeys.length} stale baseline entry/entries:`);
    for (const key of staleKeys) console.log(`  ${key}`);
    console.log(`\n  Remove from ${BASELINE_FILE} or run --update-baseline.`);
  }

  process.exit(1);
}

function collectStatePropertyWrites(
  sourceFile: SourceFile,
  out: Map<string, Location>,
): void {
  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;
    if (node.getOperatorToken().getText() !== "=") return;

    const lhs = unwrap(node.getLeft());
    if (!Node.isPropertyAccessExpression(lhs)) return;
    const path = canonicalStatePath(lhs);
    if (!path) return;

    const rhs = unwrap(node.getRight());
    const key = `prop:${path}`;
    const record = out.get(key) ?? {
      key,
      display: path,
      file: relPath(sourceFile.getFilePath()),
      line: node.getStartLineNumber(),
      rhsValues: [],
      hasNonConstantWrite: false,
    };
    if (!isConstantRhs(rhs)) {
      record.hasNonConstantWrite = true;
    } else {
      record.rhsValues.push({
        text: canonical(rhs),
        file: relPath(sourceFile.getFilePath()),
        line: node.getStartLineNumber(),
      });
    }
    out.set(key, record);
  });
}

/** Resolve a PropertyAccess chain rooted at `state` (possibly through a
 *  same-function `const X = state.Y` alias) to a canonical dotted path.
 *  Returns null when the root is not state-aliased. */
function canonicalStatePath(access: Node): string | null {
  const segments: string[] = [];
  let current: Node = access;
  while (Node.isPropertyAccessExpression(current)) {
    segments.unshift(current.getName());
    current = unwrap(current.getExpression());
  }
  if (!Node.isIdentifier(current)) return null;
  const rootText = current.getText();
  if (rootText === "state") return ["state", ...segments].join(".");

  const aliasTarget = resolveAlias(current, rootText);
  if (!aliasTarget) return null;
  return [aliasTarget, ...segments].join(".");
}

/** If `ident` resolves (via a same-function `const` declaration) to
 *  `state.X` or `state.X!`, return the dotted alias target. Otherwise null. */
function resolveAlias(ident: Node, name: string): string | null {
  const fn = enclosingFunction(ident);
  if (!fn) return null;

  let found: string | null = null;
  fn.forEachDescendant((node) => {
    if (found) return;
    if (!Node.isVariableDeclaration(node)) return;
    const nameNode = node.getNameNode();
    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== name) return;
    const init = node.getInitializer();
    if (!init) return;
    const unwrapped = unwrap(init);
    if (!Node.isPropertyAccessExpression(unwrapped)) return;
    const path: string[] = [];
    let walker: Node = unwrapped;
    while (Node.isPropertyAccessExpression(walker)) {
      path.unshift(walker.getName());
      walker = unwrap(walker.getExpression());
    }
    if (Node.isIdentifier(walker) && walker.getText() === "state") {
      found = ["state", ...path].join(".");
    }
  });
  return found;
}

function collectLetReassignments(
  sourceFile: SourceFile,
  out: Map<string, Location>,
): void {
  for (const stmt of sourceFile.getVariableStatements()) {
    if (stmt.getDeclarationKind() !== "let") continue;
    if (!isTopLevelStatement(stmt)) continue;
    for (const decl of stmt.getDeclarations()) {
      recordLet(decl, sourceFile, out, /* scope */ sourceFile);
    }
  }

  for (const fn of allFunctionLikes(sourceFile)) {
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) continue;
    for (const stmt of body.getStatements()) {
      if (!Node.isVariableStatement(stmt)) continue;
      if (stmt.getDeclarationKind() !== "let") continue;
      for (const decl of stmt.getDeclarations()) {
        recordLet(decl, sourceFile, out, /* scope */ fn);
      }
    }
  }
}

function recordLet(
  decl: import("ts-morph").VariableDeclaration,
  sourceFile: SourceFile,
  out: Map<string, Location>,
  scope: Node,
): void {
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return;
  const name = nameNode.getText();
  const declLine = decl.getStartLineNumber();
  const filePath = relPath(sourceFile.getFilePath());
  const key = `let:${filePath}:${declLine}:${name}`;

  // Skip if the name is shadowed by a nested let/const/parameter with the
  // same name — too noisy to disambiguate reliably.
  if (isShadowed(scope, name, decl)) return;

  const record: Location = {
    key,
    display: `let ${name}`,
    file: filePath,
    line: declLine,
    rhsValues: [],
    hasNonConstantWrite: false,
  };

  scope.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;
    if (node.getOperatorToken().getText() !== "=") return;
    const lhs = unwrap(node.getLeft());
    if (!Node.isIdentifier(lhs)) return;
    if (lhs.getText() !== name) return;
    const rhs = unwrap(node.getRight());
    if (!isConstantRhs(rhs)) {
      record.hasNonConstantWrite = true;
      return;
    }
    record.rhsValues.push({
      text: canonical(rhs),
      file: filePath,
      line: node.getStartLineNumber(),
    });
  });

  if (record.rhsValues.length > 0 || record.hasNonConstantWrite) {
    out.set(key, record);
  }
}

function isShadowed(scope: Node, name: string, original: Node): boolean {
  let shadowed = false;
  scope.forEachDescendant((node) => {
    if (shadowed) return;
    if (node === original) return;
    if (Node.isVariableDeclaration(node)) {
      const otherName = node.getNameNode();
      if (Node.isIdentifier(otherName) && otherName.getText() === name) {
        shadowed = true;
      }
      return;
    }
    if (isParameterNamed(node, name)) shadowed = true;
  });
  return shadowed;
}

function isParameterNamed(node: Node, name: string): boolean {
  if (!isParameter(node)) return false;
  const param = node as ParameterDeclaration;
  const nameNode = param.getNameNode();
  return Node.isIdentifier(nameNode) && nameNode.getText() === name;
}

function isParameter(node: Node): boolean {
  return node.getKindName() === "Parameter";
}

function canonical(node: Node): string {
  return unwrap(node).getText().replace(/\s+/g, " ").trim();
}

/** True when the RHS expression's value is recognizably constant at write
 *  time — literal, all-uppercase identifier, property access ending in an
 *  all-uppercase segment, or empty `new Set()` / `new Map()`. Filters out
 *  walker patterns (`cursor = nextCursor`) and value-derived assignments. */
function isConstantRhs(node: Node): boolean {
  const expr = unwrap(node);
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
  if (expr.getKindName() === "UndefinedKeyword") return true;
  if (Node.isIdentifier(expr) && expr.getText() === "undefined") return true;
  if (Node.isArrayLiteralExpression(expr))
    return expr.getElements().length === 0;
  if (Node.isObjectLiteralExpression(expr))
    return expr.getProperties().length === 0;
  if (Node.isIdentifier(expr)) return isUpperConst(expr.getText());
  if (Node.isPropertyAccessExpression(expr))
    return isUpperConst(expr.getName());
  if (Node.isNewExpression(expr)) {
    const ctor = expr.getExpression();
    if (!Node.isIdentifier(ctor)) return false;
    if (ctor.getText() !== "Set" && ctor.getText() !== "Map") return false;
    return (expr.getArguments() ?? []).length === 0;
  }
  return false;
}

function isUpperConst(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

/** Set of all (path-suffix) names that ever appear as the receiver of a
 *  mutation method call anywhere in the codebase. Conservative: indexed by
 *  the final segment of the receiver chain, so `state.modern.frozenTiles.add`
 *  and `frozenTiles.add` both contribute `frozenTiles`. A location whose
 *  display ends in that name is then skipped. */
function collectMutatedNames(files: readonly SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const sourceFile of files) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      if (!MUTATION_METHODS.has(callee.getName())) return;
      const receiver = unwrap(callee.getExpression());
      if (Node.isPropertyAccessExpression(receiver)) {
        names.add(receiver.getName());
        return;
      }
      if (Node.isIdentifier(receiver)) {
        names.add(receiver.getText());
      }
    });
  }
  return names;
}

function hasMutationMethodCall(
  loc: Location,
  mutatedNames: ReadonlySet<string>,
): boolean {
  // For property writes, the display is the dotted path; final segment is
  // the field name. For let writes, the display is `let <name>`.
  const last = loc.display.includes(".")
    ? loc.display.split(".").pop()!
    : loc.display.replace(/^let /, "");
  return mutatedNames.has(last);
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function enclosingFunction(
  node: Node,
): FunctionDeclaration | ArrowFunction | FunctionExpression | null {
  let parent: Node | undefined = node.getParent();
  while (parent) {
    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent)
    ) {
      return parent;
    }
    parent = parent.getParent();
  }
  return null;
}

function isTopLevelStatement(stmt: Node): boolean {
  return stmt.getParent()?.getKindName() === "SourceFile";
}

function allFunctionLikes(
  sourceFile: SourceFile,
): (FunctionDeclaration | ArrowFunction | FunctionExpression)[] {
  const fns: (FunctionDeclaration | ArrowFunction | FunctionExpression)[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      fns.push(node);
    }
  });
  return fns;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  try {
    const raw = fs.readFileSync(BASELINE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry) => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function relPath(absPath: string): string {
  return absPath.replace(`${process.cwd()}/`, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
