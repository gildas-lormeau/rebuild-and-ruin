/**
 * Adds `readonly` to all array-typed function parameters across src/*.ts.
 * Run with: npx tsx scripts/add-readonly-params.ts
 *
 * Parameters listed in .readonly-params-baseline.json are skipped because
 * they genuinely mutate their array argument. Add new entries there when tsc
 * reports mutations after running this script.
 */
import { readFileSync } from "node:fs";
import { Project, SyntaxKind } from "ts-morph";

const baseline: { mutableArrayParams: string[] } = JSON.parse(
  readFileSync(".readonly-params-baseline.json", "utf8"),
);
const skip = new Set(baseline.mutableArrayParams);

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
let changed = 0;

for (const file of project.getSourceFiles()) {
  if (!file.getFilePath().includes("/src/")) continue;

  const relPath = file.getFilePath().replace(/^.*\/src\//, "src/");
  let fileChanged = false;

  for (const node of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const typeNode = node.getTypeNode();
    if (!typeNode) continue;

    // Already readonly? Skip.
    const fullText = node.getText();
    if (fullText.includes(": readonly ") || fullText.startsWith("readonly ")) continue;

    // In baseline (known mutable)? Skip.
    const paramName = node.getName();
    if (skip.has(`${relPath}:${paramName}`)) continue;

    const kind = typeNode.getKind();

    // T[] — array type
    if (kind === SyntaxKind.ArrayType) {
      node.setType(`readonly ${typeNode.getText()}`);
      fileChanged = true;
      changed++;
      continue;
    }

    // Array<T> — generic array type
    if (kind === SyntaxKind.TypeReference) {
      const name = typeNode.getText();
      if (name.startsWith("Array<")) {
        node.setType(`ReadonlyArray<${name.slice("Array<".length, -1)}>`);
        fileChanged = true;
        changed++;
      }
    }
  }

  if (fileChanged) {
    await file.save();
    console.log(`  updated: ${file.getBaseName()}`);
  }
}

console.log(`\nTotal parameters made readonly: ${changed}`);
console.log("Now run: npx tsc --noEmit 2>&1 | grep error to find genuine mutations.");
