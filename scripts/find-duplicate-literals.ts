/**
 * Find duplicate string and numeric literals across the codebase.
 *
 * Uses the TypeScript compiler API to parse ASTs and collect literals
 * that appear in runtime expressions (comparisons, assignments, function args).
 * Skips: const/enum definitions, imports, type annotations, exports, object keys.
 *
 * Usage: npx tsx scripts/find-duplicate-literals.ts [--threshold N]
 */

import ts from "typescript";
import { globSync } from "node:fs";
import path from "node:path";

const threshold = (() => {
  const idx = process.argv.indexOf("--threshold");
  return idx >= 0 ? parseInt(process.argv[idx + 1]!, 10) || 3 : 3;
})();

// Files to exclude from numeric analysis (sprite data tables, test fixtures)
const NUMERIC_EXCLUDED_FILES = new Set(["sprites.ts", "headless-test.ts"]);

const root = path.resolve(import.meta.dirname!, "..");
const files = [
  ...globSync("src/**/*.ts", { cwd: root }),
  ...globSync("server/**/*.ts", { cwd: root }),
].map((f) => path.join(root, f));

const stringCounts = new Map<string, { count: number; locations: string[] }>();
const numberCounts = new Map<number, { count: number; locations: string[] }>();

// ---------------------------------------------------------------------------
// Shared skip logic (applies to both strings and numbers)
// ---------------------------------------------------------------------------

function isDefinitionContext(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const parent = node.parent;
  if (!parent) return true;

  // Skip imports
  if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent) ||
      ts.isExportDeclaration(parent)) return true;
  if (parent.kind === ts.SyntaxKind.ImportDeclaration ||
      parent.kind === ts.SyntaxKind.ExportDeclaration) return true;

  // Skip: import("...")
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;

  // Skip: `as const` initializers
  if (ts.isAsExpression(parent)) {
    const typeNode = parent.type;
    if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText(sourceFile) === "const") return true;
  }

  // Skip: const X = <literal> (top-level constant definitions)
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    const declList = parent.parent;
    if (ts.isVariableDeclarationList(declList) &&
        (declList.flags & ts.NodeFlags.Const) !== 0) {
      return true;
    }
  }

  // Skip: enum member values
  if (ts.isEnumMember(parent)) return true;

  // Skip: property assignments in const object literals
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

  return false;
}

// ---------------------------------------------------------------------------
// String-specific skips
// ---------------------------------------------------------------------------

function isSkippedString(node: ts.StringLiteral, sourceFile: ts.SourceFile): boolean {
  const text = node.text;

  // Skip very short strings (1-2 chars)
  if (text.length < 3) return true;

  if (isDefinitionContext(node, sourceFile)) return true;

  const parent = node.parent!;

  // Skip: template literal parts
  if (ts.isTemplateSpan(parent) || ts.isNoSubstitutionTemplateLiteral(node as ts.Node as ts.NoSubstitutionTemplateLiteral)) return true;

  // Skip: addEventListener/removeEventListener first arg (DOM event names)
  if (ts.isCallExpression(parent)) {
    const expr = parent.expression;
    if (ts.isPropertyAccessExpression(expr)) {
      const method = expr.name.text;
      if ((method === "addEventListener" || method === "removeEventListener") &&
          parent.arguments[0] === node) return true;
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

  // Skip: hex color strings
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

  // Skip strings with uppercase, spaces, dots, slashes (UI text, paths, etc.)
  if (/[A-Z /.]/.test(text)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Number-specific skips
// ---------------------------------------------------------------------------

function isSkippedNumber(node: ts.NumericLiteral, sourceFile: ts.SourceFile): boolean {
  const value = Number(node.text);

  // Skip small integers (0-15) and -1 — too common to be meaningful
  if (Number.isInteger(value) && value >= -1 && value <= 15) return true;

  // Skip small decimals (0–2) — alpha, lerp factors, scale ratios
  if (!Number.isInteger(value) && value >= 0 && value <= 2) return true;

  if (isDefinitionContext(node, sourceFile)) return true;

  const parent = node.parent!;

  // Skip: array index access (arr[3] is not a magic number worth extracting)
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;

  // Skip: negative prefix expressions — we'll catch the inner literal
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.MinusToken) return true;

  // Skip: bit shift / bitwise operations (commonly use small constants)
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.LessThanLessThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.AmpersandToken ||
        op === ts.SyntaxKind.BarToken ||
        op === ts.SyntaxKind.CaretToken) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Walk all files
// ---------------------------------------------------------------------------

for (const filePath of files) {
  const sourceFile = ts.createSourceFile(
    filePath,
    ts.sys.readFile(filePath) ?? "",
    ts.ScriptTarget.Latest,
    true,
  );

  function record(map: Map<string | number, { count: number; locations: string[] }>, key: string | number, node: ts.Node) {
    const rel = path.relative(root, filePath);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const loc = `${rel}:${line}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { count: 0, locations: [] };
      map.set(key, entry);
    }
    entry.count++;
    entry.locations.push(loc);
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && !isSkippedString(node, sourceFile)) {
      record(stringCounts as Map<string | number, { count: number; locations: string[] }>, node.text, node);
    } else if (ts.isNumericLiteral(node) && !NUMERIC_EXCLUDED_FILES.has(path.basename(filePath)) && !isSkippedNumber(node, sourceFile)) {
      record(numberCounts as Map<string | number, { count: number; locations: string[] }>, Number(node.text), node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const stringResults = [...stringCounts.entries()]
  .filter(([, v]) => v.count >= threshold)
  .sort((a, b) => b[1].count - a[1].count);

const numberResults = [...numberCounts.entries()]
  .filter(([, v]) => v.count >= threshold)
  .sort((a, b) => b[1].count - a[1].count);

const total = stringResults.length + numberResults.length;

if (total === 0) {
  console.log(`No duplicate literals found with ${threshold}+ occurrences.`);
  process.exit(0);
}

if (stringResults.length > 0) {
  console.log(`String literals appearing ${threshold}+ times:\n`);
  for (const [text, { count, locations }] of stringResults) {
    console.log(`  "${text}" × ${count}`);
    for (const loc of locations) {
      console.log(`    ${loc}`);
    }
    console.log();
  }
}

if (numberResults.length > 0) {
  console.log(`Numeric literals appearing ${threshold}+ times:\n`);
  for (const [num, { count, locations }] of numberResults) {
    console.log(`  ${num} × ${count}`);
    for (const loc of locations) {
      console.log(`    ${loc}`);
    }
    console.log();
  }
}

process.exit(total > 0 ? 1 : 0);
