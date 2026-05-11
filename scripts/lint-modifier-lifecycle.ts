/**
 * Verify modifier apply/clear symmetry.
 *
 * Every `state.modern.X` field written by `apply` (or its same-file helpers)
 * must also be written by `clear` (or its same-file helpers). Otherwise the
 * field leaks into checkpoints across the modifier's lifecycle boundary.
 *
 * Catches the bug class fixed by `a54d57fc` and `428e50b2`:
 *   - apply assigns `state.modern.precomputedDustStormJitters = jitters`
 *   - no clear hook → ~8KB of stale jitters carried through every checkpoint
 *     for the rest of the round (until the next modifier's apply overwrites)
 *
 * What this checks:
 *   - For each `ModifierImpl` object literal in `src/game/modifiers/*.ts`,
 *     diff the set of `state.modern.X` properties written by `apply` vs the
 *     set written by `clear`. Any apply-only property = lint failure.
 *
 * What this does NOT check:
 *   - Permanent modifiers (state intentionally persists across rounds).
 *   - Non-`state.modern` writes (grunt fields, burningPits, etc — those are
 *     game state, not modifier-owned state).
 *   - Cross-file helpers (only same-file call graph is followed).
 *   - `restore` symmetry with `apply` (different concern: serialization).
 *
 * Usage:
 *   deno run -A scripts/lint-modifier-lifecycle.ts
 *
 * Exits 1 on any apply-only modern field. No baseline — the impl set is
 * small and curated, and any new asymmetry is a real bug.
 */

import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
} from "ts-morph";

type ImplFunction = ArrowFunction | FunctionDeclaration;

type Lifecycle = "instant" | "round-scoped" | "permanent";

interface ModifierImpl {
  name: string;
  file: string;
  line: number;
  lifecycle: Lifecycle;
  apply: ImplFunction | null;
  clear: ImplFunction | null;
}

interface Violation {
  file: string;
  line: number;
  impl: string;
  property: string;
  reason: "missing-clear" | "apply-only";
}

main();

function main(): void {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths("src/game/modifiers/*.ts");

  const impls: ModifierImpl[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    collectImpls(sourceFile, impls);
  }

  const violations: Violation[] = [];
  for (const impl of impls) {
    if (impl.lifecycle === "permanent") continue;
    if (!impl.apply) continue;

    const applyWrites = collectModernWrites(impl.apply);
    if (applyWrites.size === 0) continue;

    if (!impl.clear) {
      for (const property of [...applyWrites].sort()) {
        violations.push({
          file: impl.file,
          line: impl.line,
          impl: impl.name,
          property,
          reason: "missing-clear",
        });
      }
      continue;
    }

    const clearWrites = collectModernWrites(impl.clear);
    for (const property of [...applyWrites].sort()) {
      if (!clearWrites.has(property)) {
        violations.push({
          file: impl.file,
          line: impl.line,
          impl: impl.name,
          property,
          reason: "apply-only",
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `✔ modifier-lifecycle: ${impls.length} impl(s) checked, all apply/clear writes are symmetric`,
    );
    return;
  }

  console.log(`✘ ${violations.length} apply/clear asymmetry(ies):\n`);
  for (const violation of violations) {
    const detail =
      violation.reason === "missing-clear"
        ? `apply writes state.modern.${violation.property} but ${violation.impl} has no clear hook`
        : `apply writes state.modern.${violation.property} but clear does not`;
    console.log(`  ${violation.file}:${violation.line}  ${violation.impl}`);
    console.log(`    ${detail}`);
    console.log();
  }
  process.exit(1);
}

function collectImpls(sourceFile: SourceFile, out: ModifierImpl[]): void {
  sourceFile.forEachDescendant((node) => {
    if (!Node.isObjectLiteralExpression(node)) return;
    if (!hasProperty(node, "lifecycle") || !hasProperty(node, "apply")) return;

    const lifecycle = readStringLiteral(node, "lifecycle");
    if (
      lifecycle !== "instant" &&
      lifecycle !== "round-scoped" &&
      lifecycle !== "permanent"
    ) {
      return;
    }

    out.push({
      name: inferImplName(node),
      file: relPath(sourceFile.getFilePath()),
      line: node.getStartLineNumber(),
      lifecycle,
      apply: resolveHookFunction(node, "apply", sourceFile),
      clear: resolveHookFunction(node, "clear", sourceFile),
    });
  });
}

function hasProperty(obj: ObjectLiteralExpression, name: string): boolean {
  return obj.getProperty(name) !== undefined;
}

function readStringLiteral(
  obj: ObjectLiteralExpression,
  name: string,
): string | null {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init || !Node.isStringLiteral(init)) return null;
  return init.getLiteralValue();
}

function resolveHookFunction(
  obj: ObjectLiteralExpression,
  name: string,
  sourceFile: SourceFile,
): ImplFunction | null {
  const prop = obj.getProperty(name);
  if (!prop) return null;

  let init: Node | undefined;
  if (Node.isPropertyAssignment(prop)) {
    init = prop.getInitializer();
  } else if (Node.isShorthandPropertyAssignment(prop)) {
    init = prop.getNameNode();
  } else if (Node.isMethodDeclaration(prop)) {
    // Method-shorthand `apply(state) { ... }` would land here; cast to fn shape.
    return prop as unknown as ImplFunction;
  }
  if (!init) return null;

  if (Node.isArrowFunction(init)) return init;
  if (Node.isFunctionExpression(init)) {
    return init as unknown as ImplFunction;
  }
  if (Node.isIdentifier(init)) {
    return lookupFunctionInFile(init.getText(), sourceFile);
  }
  return null;
}

function inferImplName(node: ObjectLiteralExpression): string {
  let parent: Node | undefined = node.getParent();
  while (parent) {
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isReturnStatement(parent)) {
      let outer: Node | undefined = parent.getParent();
      while (outer) {
        if (
          Node.isFunctionDeclaration(outer) ||
          Node.isFunctionExpression(outer) ||
          Node.isArrowFunction(outer)
        ) {
          const decl = outer.getParent();
          if (Node.isVariableDeclaration(decl)) return `${decl.getName()}()`;
          if (Node.isFunctionDeclaration(outer)) {
            const fnName = outer.getName();
            if (fnName) return `${fnName}()`;
          }
          return "<factory>";
        }
        outer = outer.getParent();
      }
    }
    parent = parent.getParent();
  }
  return "<unknown>";
}

function collectModernWrites(root: ImplFunction): Set<string> {
  const writes = new Set<string>();
  const visited = new Set<FunctionDeclaration>();
  walk(root, writes, visited);
  return writes;
}

function walk(
  fn: ImplFunction,
  writes: Set<string>,
  visited: Set<FunctionDeclaration>,
): void {
  const body = fn.getBody();
  if (!body) return;

  // Collect local aliases of state.modern declared anywhere in this function.
  const aliases = collectModernAliases(fn);

  fn.forEachDescendant((node) => {
    if (Node.isBinaryExpression(node)) {
      if (node.getOperatorToken().getText() !== "=") return;
      const target = unwrapWriteTarget(node.getLeft());
      if (!target) return;
      if (!Node.isPropertyAccessExpression(target)) return;
      if (isModernPropertyAccess(target, aliases)) {
        writes.add(target.getName());
      }
    }
  });

  // Follow CallExpressions to same-file function declarations.
  const sourceFile = fn.getSourceFile();
  fn.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) return;
    const target = lookupFunctionInFile(callee.getText(), sourceFile);
    if (!target) return;
    if (visited.has(target)) return;
    visited.add(target);
    walk(target, writes, visited);
  });
}

function lookupFunctionInFile(
  name: string,
  sourceFile: SourceFile,
): FunctionDeclaration | null {
  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === name) return fn;
  }
  return null;
}

function collectModernAliases(fn: ImplFunction): Set<string> {
  const aliases = new Set<string>();
  fn.forEachDescendant((node) => {
    if (!Node.isVariableDeclaration(node)) return;
    const init = node.getInitializer();
    if (!init) return;
    if (!isStateModernExpression(init)) return;
    const nameNode = node.getNameNode();
    if (Node.isIdentifier(nameNode)) aliases.add(nameNode.getText());
  });
  return aliases;
}

function isModernPropertyAccess(
  access: Node,
  aliases: ReadonlySet<string>,
): boolean {
  if (!Node.isPropertyAccessExpression(access)) return false;
  const receiver = unwrapWriteTarget(access.getExpression());
  if (Node.isIdentifier(receiver)) {
    return aliases.has(receiver.getText());
  }
  return isStateModernExpression(receiver);
}

function isStateModernExpression(expr: Node): boolean {
  const target = unwrapWriteTarget(expr);
  if (!Node.isPropertyAccessExpression(target)) return false;
  if (target.getName() !== "modern") return false;
  const receiver = unwrapWriteTarget(target.getExpression());
  return Node.isIdentifier(receiver) && receiver.getText() === "state";
}

function unwrapWriteTarget(node: Node): Node {
  let current = node;
  while (
    Node.isNonNullExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function relPath(absPath: string): string {
  return absPath.replace(`${process.cwd()}/`, "");
}
