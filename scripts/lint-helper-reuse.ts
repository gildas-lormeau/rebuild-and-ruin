/**
 * Detect inlined copies of existing exported helpers.
 *
 * jscpd catches verbatim duplicate blocks; lint-passthrough-wrappers catches
 * one-line delegations. This script catches the in-between case: a short
 * helper exists (e.g. `filterOffTiles(coll, tiles)`) and a call-site has
 * inlined its body shape instead of importing the helper.
 *
 * Algorithm:
 *   1. Collect every exported function/arrow with a single-return body and
 *      enough structural complexity — these are "templates".
 *   2. For each expression in every src/ file, try to match it against every
 *      template. Helper parameters become positional wildcards; nested arrow
 *      parameters alpha-rename; free identifiers and literals must match
 *      exactly.
 *   3. If an expression matches a template AND its containing file does not
 *      already import the helper, report it.
 *
 * What this catches:
 *   - `coll.filter(x => !tiles.has(packTile(x.row, x.col)))` when
 *     `filterOffTiles(coll, tiles)` exists.
 *   - Repeated big object/array literals when a constructor helper exists.
 *
 * What this does NOT catch (semantic-equivalence, not AST-shape):
 *   - `for (let i = 0; i < arr.length; i++) ...` vs `arr.indexOf(...)`.
 *   - `arr.some(x => x.foo)` vs `arr.find(x => x.foo) !== undefined`.
 *
 * Usage:
 *   deno run -A scripts/lint-helper-reuse.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --update-baseline   Refresh baseline with current detections
 *   --helper <name>     Only report matches for the named helper (debugging)
 *
 * Baseline: .helper-reuse-baseline.json — entries keyed by "file:line:helper".
 * Exits 1 if non-baselined violations or stale baseline entries are found.
 */

import fs from "node:fs";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

interface Template {
  name: string;
  file: string;
  line: number;
  params: readonly string[];
  body: Node;
  anchors: number;
}

interface Hit {
  helper: string;
  helperFile: string;
  helperLine: number;
  file: string;
  line: number;
  snippet: string;
  bindings: string;
}

interface BodyStats {
  nodes: number;
  anchors: number;
}

const BASELINE_FILE = ".helper-reuse-baseline.json";
const MIN_NODE_COUNT = 10;
const MIN_ANCHORS = 3;
const SNIPPET_LEN = 90;

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const updateBaseline = args.includes("--update-baseline");
  const helperIdx = args.indexOf("--helper");
  const helperFilter = helperIdx >= 0 ? args[helperIdx + 1] : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  for (const glob of globs) project.addSourceFilesAtPaths(glob);

  const templates: Template[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    collectTemplates(sourceFile, templates);
  }

  const byKind = new Map<SyntaxKind, Template[]>();
  for (const tpl of templates) {
    if (helperFilter && tpl.name !== helperFilter) continue;
    const list = byKind.get(tpl.body.getKind()) ?? [];
    list.push(tpl);
    byKind.set(tpl.body.getKind(), list);
  }

  const hits: Hit[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const importedHelpers = collectImports(sourceFile);
    const filePath = relPath(sourceFile.getFilePath());

    sourceFile.forEachDescendant((node) => {
      const candidates = byKind.get(node.getKind());
      if (!candidates) return;

      for (const tpl of candidates) {
        if (tpl.file === filePath && isWithin(node, tpl.body)) continue;
        if (importedHelpers.has(tpl.name)) continue;
        if (isInsideOwnDeclaration(node, tpl.name)) continue;

        const bindings = new Map<number, string>();
        if (!tryMatch(tpl.body, node, tpl.params, bindings, new Map()))
          continue;

        // Skip matches that are themselves the body of a same-named export
        // (re-declared helpers — covered by find-shape-duplicates).
        if (isExportedBody(node, tpl.name)) continue;

        const bindingDescs: string[] = [];
        for (let i = 0; i < tpl.params.length; i++) {
          bindingDescs.push(`${tpl.params[i]}=${bindings.get(i) ?? "?"}`);
        }
        hits.push({
          helper: tpl.name,
          helperFile: tpl.file,
          helperLine: tpl.line,
          file: filePath,
          line: node.getStartLineNumber(),
          snippet: truncate(node.getText().replace(/\s+/g, " "), SNIPPET_LEN),
          bindings: bindingDescs.join(", "),
        });
        return; // one match per node is enough
      }
    });
  }

  const sorted = hits.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.helper.localeCompare(b.helper),
  );

  const keyOf = (hit: Hit) => `${hit.file}:${hit.line}:${hit.helper}`;
  const currentKeys = new Set(sorted.map(keyOf));

  if (updateBaseline) {
    const baseline = sorted.map(keyOf).sort();
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote ${baseline.length} entries to ${BASELINE_FILE}`);
    return;
  }

  const baseline = loadBaseline();
  const newHits = sorted.filter((hit) => !baseline.has(keyOf(hit)));
  const staleKeys = [...baseline].filter((key) => !currentKeys.has(key));

  if (newHits.length === 0 && staleKeys.length === 0) {
    console.log(
      `✔ helper-reuse: ${sorted.length} matches, all in baseline (templates: ${templates.length})`,
    );
    return;
  }

  if (newHits.length > 0) {
    console.log(`✘ ${newHits.length} new helper-reuse candidate(s):\n`);
    for (const hit of newHits) {
      console.log(`  ${hit.file}:${hit.line}`);
      console.log(`    inlined: ${hit.snippet}`);
      console.log(
        `    helper:  ${hit.helper} (${hit.helperFile}:${hit.helperLine})`,
      );
      console.log(`    binding: ${hit.bindings}`);
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

function collectTemplates(sourceFile: SourceFile, out: Template[]): void {
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    addTemplate(out, fn, fn.getName() ?? "", sourceFile);
  }
  for (const vd of sourceFile.getVariableDeclarations()) {
    if (!vd.isExported()) continue;
    const init = vd.getInitializer();
    if (!init || !Node.isArrowFunction(init)) continue;
    addTemplate(out, init, vd.getName(), sourceFile);
  }
}

function addTemplate(
  out: Template[],
  fn: FunctionDeclaration | ArrowFunction,
  name: string,
  sourceFile: SourceFile,
): void {
  if (!name) return;
  const params = fn.getParameters();
  if (params.length === 0) return;

  const paramNames: string[] = [];
  for (const param of params) {
    if (param.getDotDotDotToken()) return;
    if (param.hasInitializer()) return;
    const nameNode = param.getNameNode();
    if (!Node.isIdentifier(nameNode)) return;
    paramNames.push(nameNode.getText());
  }

  const body = extractBodyExpr(fn);
  if (!body) return;

  const stats = bodyStats(body, paramNames);
  if (stats.nodes < MIN_NODE_COUNT) return;
  if (stats.anchors < MIN_ANCHORS) return;

  out.push({
    name,
    file: relPath(sourceFile.getFilePath()),
    line: fn.getStartLineNumber(),
    params: paramNames,
    body,
    anchors: stats.anchors,
  });
}

function extractBodyExpr(fn: FunctionDeclaration | ArrowFunction): Node | null {
  const body = fn.getBody();
  if (!body) return null;

  if (Node.isArrowFunction(fn) && !Node.isBlock(body)) {
    return unwrap(body);
  }
  if (!Node.isBlock(body)) return null;
  const stmts = body.getStatements();
  if (stmts.length !== 1) return null;
  const stmt = stmts[0];
  if (!Node.isReturnStatement(stmt)) return null;
  const expr = stmt.getExpression();
  if (!expr) return null;
  return unwrap(expr);
}

function bodyStats(node: Node, params: readonly string[]): BodyStats {
  let nodes = 0;
  let anchors = 0;
  const visit = (current: Node, scope: ReadonlySet<string>) => {
    nodes++;
    if (Node.isIdentifier(current)) {
      const text = current.getText();
      if (!params.includes(text) && !scope.has(text)) anchors++;
      return;
    }
    if (isLiteral(current)) {
      anchors++;
      return;
    }
    if (Node.isArrowFunction(current)) {
      const localNames = collectArrowParamNames(current);
      if (!localNames) return;
      const merged = new Set(scope);
      for (const localName of localNames) merged.add(localName);
      const arrowBody = current.getBody();
      visit(arrowBody, merged);
      return;
    }
    current.forEachChild((child) => visit(child, scope));
  };
  visit(node, new Set());
  return { nodes, anchors };
}

function tryMatch(
  tpl: Node,
  cand: Node,
  params: readonly string[],
  bindings: Map<number, string>,
  scopeMap: Map<string, string>,
): boolean {
  const t = unwrap(tpl);
  const c = unwrap(cand);

  if (Node.isArrowFunction(t)) {
    if (!Node.isArrowFunction(c)) return false;
    const tplParams = collectArrowParamNames(t);
    const candParams = collectArrowParamNames(c);
    if (!tplParams || !candParams) return false;
    if (tplParams.length !== candParams.length) return false;
    const nextScope = new Map(scopeMap);
    for (let i = 0; i < tplParams.length; i++) {
      nextScope.set(tplParams[i]!, candParams[i]!);
    }
    return tryMatch(t.getBody(), c.getBody(), params, bindings, nextScope);
  }

  if (Node.isIdentifier(t)) {
    const text = t.getText();
    const paramIdx = params.indexOf(text);
    if (paramIdx >= 0) {
      const candText = canonical(c);
      const prior = bindings.get(paramIdx);
      if (prior !== undefined) return prior === candText;
      bindings.set(paramIdx, candText);
      return true;
    }
    if (scopeMap.has(text)) {
      if (!Node.isIdentifier(c)) return false;
      return scopeMap.get(text) === c.getText();
    }
    if (!Node.isIdentifier(c)) return false;
    // Free identifier in template — must match same name and not be a local
    // alpha-rename in the candidate (otherwise we'd accept e.g. an arrow
    // parameter as a free identifier).
    if (scopeMapHasValue(scopeMap, c.getText())) return false;
    return text === c.getText();
  }

  if (t.getKind() !== c.getKind()) return false;

  if (isLiteral(t)) return t.getText() === c.getText();

  const tChildren = childNodes(t);
  const cChildren = childNodes(c);
  if (tChildren.length !== cChildren.length) return false;
  // Atomic nodes (template head/middle/tail, modifiers, keywords) have no
  // AST children but carry meaningful text — compare directly.
  if (tChildren.length === 0) return t.getText() === c.getText();
  for (let i = 0; i < tChildren.length; i++) {
    if (!tryMatch(tChildren[i]!, cChildren[i]!, params, bindings, scopeMap)) {
      return false;
    }
  }
  return true;
}

function collectArrowParamNames(arrow: ArrowFunction): string[] | null {
  const names: string[] = [];
  for (const param of arrow.getParameters()) {
    if (param.getDotDotDotToken()) return null;
    const nameNode = param.getNameNode();
    if (!Node.isIdentifier(nameNode)) return null;
    names.push(nameNode.getText());
  }
  return names;
}

function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  node.forEachChild((child) => {
    out.push(child);
  });
  return out;
}

function isLiteral(node: Node): boolean {
  return (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isRegularExpressionLiteral(node)
  );
}

function canonical(node: Node): string {
  return unwrap(node).getText().replace(/\s+/g, " ").trim();
}

function unwrap(node: Node): Node {
  let current = node;
  while (true) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isAsExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isTypeAssertion(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

function scopeMapHasValue(
  scopeMap: Map<string, string>,
  value: string,
): boolean {
  for (const v of scopeMap.values()) if (v === value) return true;
  return false;
}

function collectImports(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const imp of sourceFile.getImportDeclarations()) {
    for (const named of imp.getNamedImports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getName());
    }
    const ns = imp.getNamespaceImport();
    if (ns) names.add(ns.getText());
    const def = imp.getDefaultImport();
    if (def) names.add(def.getText());
  }
  // Locally-declared names in this file shadow any same-named helper — the
  // file isn't "missing" the helper, it's using its own.
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name) names.add(name);
  }
  for (const vd of sourceFile.getVariableDeclarations()) {
    names.add(vd.getName());
  }
  return names;
}

function isWithin(node: Node, container: Node): boolean {
  const ns = node.getStart();
  const ne = node.getEnd();
  const cs = container.getStart();
  const ce = container.getEnd();
  if (node.getSourceFile() !== container.getSourceFile()) return false;
  return ns >= cs && ne <= ce;
}

function isInsideOwnDeclaration(node: Node, helperName: string): boolean {
  let parent: Node | undefined = node.getParent();
  while (parent) {
    if (Node.isFunctionDeclaration(parent) && parent.getName() === helperName) {
      return true;
    }
    if (Node.isVariableDeclaration(parent) && parent.getName() === helperName) {
      return true;
    }
    parent = parent.getParent();
  }
  return false;
}

function isExportedBody(node: Node, helperName: string): boolean {
  let parent: Node | undefined = node.getParent();
  while (parent) {
    if (Node.isFunctionDeclaration(parent)) {
      return parent.isExported() && parent.getName() === helperName;
    }
    if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent)) {
      const vd = parent.getParent();
      if (Node.isVariableDeclaration(vd) && vd.getName() === helperName) {
        return vd.isExported();
      }
      return false;
    }
    parent = parent.getParent();
  }
  return false;
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
