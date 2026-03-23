/**
 * Find duplicate string literals across the codebase.
 *
 * Uses the TypeScript compiler API to parse ASTs and collect string literals
 * that appear in runtime expressions (comparisons, assignments, function args).
 * Skips: const/enum definitions, imports, type annotations, exports, object keys.
 *
 * Usage: npx tsx scripts/find-duplicate-strings.ts [--threshold N]
 */

import ts from "typescript";
import { globSync } from "node:fs";
import path from "node:path";

const threshold = (() => {
  const idx = process.argv.indexOf("--threshold");
  return idx >= 0 ? parseInt(process.argv[idx + 1]!, 10) || 3 : 3;
})();

const root = path.resolve(import.meta.dirname!, "..");
const files = [
  ...globSync("src/**/*.ts", { cwd: root }),
  ...globSync("server/**/*.ts", { cwd: root }),
].map((f) => path.join(root, f));

const counts = new Map<string, { count: number; locations: string[] }>();

function isSkipped(node: ts.StringLiteral, sourceFile: ts.SourceFile): boolean {
  const text = node.text;

  // Skip very short strings (1-2 chars) — not worth extracting
  if (text.length < 3) return true;

  const parent = node.parent;
  if (!parent) return true;

  // Skip imports
  if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent) ||
      ts.isExportDeclaration(parent)) return true;
  if (parent.kind === ts.SyntaxKind.ImportDeclaration ||
      parent.kind === ts.SyntaxKind.ExportDeclaration) return true;

  // Skip: import("...")
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;

  // Skip: `as const` initializers (these ARE the constant definitions)
  if (ts.isAsExpression(parent)) {
    const typeNode = parent.type;
    if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText(sourceFile) === "const") return true;
  }

  // Skip: const X = "..." (top-level constant definitions)
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    const declList = parent.parent;
    if (ts.isVariableDeclarationList(declList) &&
        (declList.flags & ts.NodeFlags.Const) !== 0) {
      return true;
    }
  }

  // Skip: enum member values
  if (ts.isEnumMember(parent)) return true;

  // Skip: property assignments in object literals that are const definitions
  // e.g., const MSG = { FOO: "foo" } — the "foo" is a definition
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const objLit = parent.parent;
    if (ts.isObjectLiteralExpression(objLit)) {
      const objParent = objLit.parent;
      if (ts.isVariableDeclaration(objParent) && objParent.initializer === objLit) {
        const declList = objParent.parent;
        if (ts.isVariableDeclarationList(declList) &&
            (declList.flags & ts.NodeFlags.Const) !== 0) {
          return true;
        }
      }
    }
  }

  // Skip: object literal keys (property names)
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;

  // Skip: type annotations and interface members
  if (ts.isLiteralTypeNode(parent)) return true;

  // Skip: template literal parts
  if (ts.isTemplateSpan(parent) || ts.isNoSubstitutionTemplateLiteral(node as ts.Node as ts.NoSubstitutionTemplateLiteral)) return true;

  // Skip: addEventListener/removeEventListener first arg (DOM event names)
  if (ts.isCallExpression(parent)) {
    const expr = parent.expression;
    if (ts.isPropertyAccessExpression(expr)) {
      const method = expr.name.text;
      if ((method === "addEventListener" || method === "removeEventListener") &&
          parent.arguments[0] === node) return true;
      // Skip: createElement("div"), getElementById("x"), querySelector("x")
      if (method === "createElement" || method === "getElementById" ||
          method === "querySelector" || method === "querySelectorAll") return true;
    }
  }

  // Skip: property assignments to known DOM/Canvas properties
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node && ts.isPropertyAccessExpression(parent.left)) {
    const prop = parent.left.name.text;
    const domProps = new Set([
      "display", "position", "textAlign", "textBaseline", "fillStyle",
      "strokeStyle", "font", "cursor", "overflow", "visibility",
      "pointerEvents", "touchAction", "userSelect", "className",
      "textContent", "innerHTML", "id", "type", "textDecoration",
    ]);
    if (domProps.has(prop)) return true;
  }

  // Skip: hex color strings (#xxx, #xxxxxx)
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;

  // Skip: well-known CSS/DOM values and HTML tag/attribute names
  const CSS_DOM_STRINGS = new Set([
    "none", "block", "flex", "grid", "inline", "inline-block",
    "absolute", "relative", "fixed", "sticky",
    "hidden", "visible", "scroll", "auto",
    "center", "left", "right", "top", "bottom", "middle",
    "bold", "normal", "italic", "underline",
    "pointer", "default", "grab", "crosshair",
    "solid", "dashed", "dotted",
    "transparent", "inherit", "initial", "unset",
    "div", "span", "button", "input", "canvas", "img", "label",
    "click", "touchstart", "touchmove", "touchend", "touchcancel",
    "keydown", "keyup", "mousedown", "mouseup", "mousemove",
    "resize", "wheel", "contextmenu", "pointerdown", "pointerup",
    "active", "disabled", "checked", "focus", "hover",
    "row", "col", "column",
  ]);
  if (CSS_DOM_STRINGS.has(text)) return true;

  // Skip: typeof comparisons
  if (ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
       parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (ts.isTypeOfExpression(other)) return true;
  }

  return false;
}

for (const filePath of files) {
  const sourceFile = ts.createSourceFile(
    filePath,
    ts.sys.readFile(filePath) ?? "",
    ts.ScriptTarget.Latest,
    true,
  );

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && !isSkipped(node, sourceFile)) {
      const text = node.text;
      // Skip strings that look like DOM/CSS (contain spaces, uppercase, dots, slashes)
      if (/[A-Z /.]/.test(text)) {
        ts.forEachChild(node, visit);
        return;
      }
      const rel = path.relative(root, filePath);
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const loc = `${rel}:${line}`;
      let entry = counts.get(text);
      if (!entry) {
        entry = { count: 0, locations: [] };
        counts.set(text, entry);
      }
      entry.count++;
      entry.locations.push(loc);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// Sort by count descending, filter by threshold
const results = [...counts.entries()]
  .filter(([, v]) => v.count >= threshold)
  .sort((a, b) => b[1].count - a[1].count);

if (results.length === 0) {
  console.log(`No string literals found with ${threshold}+ occurrences.`);
  process.exit(0);
}

console.log(`String literals appearing ${threshold}+ times:\n`);
for (const [text, { count, locations }] of results) {
  console.log(`  "${text}" × ${count}`);
  for (const loc of locations) {
    console.log(`    ${loc}`);
  }
  console.log();
}

process.exit(results.length > 0 ? 1 : 0);
