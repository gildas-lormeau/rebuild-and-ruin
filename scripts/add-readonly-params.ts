/**
 * Adds `readonly` to all array-typed function parameters across src/*.ts.
 * Run with: npx tsx scripts/add-readonly-params.ts
 *
 * Parameters listed in .readonly-params-baseline.json are skipped because
 * they genuinely mutate their array argument. Add new entries there when tsc
 * reports mutations after running this script.
 *
 * Exits 1 if new parameters were made readonly (add to baseline or fix them)
 * or if baseline entries are stale (parameter no longer exists or is already
 * readonly — remove them from the baseline).
 */
import { readFileSync } from "node:fs";
import { Project, SyntaxKind } from "ts-morph";

const baseline: { mutableArrayParams: string[] } = JSON.parse(
  readFileSync(".readonly-params-baseline.json", "utf8"),
);
const skip = new Set(baseline.mutableArrayParams);
const hit = new Set<string>();

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

    const paramName = node.getName();
    const key = `${relPath}:${paramName}`;

    // In baseline (known mutable)? Skip and record the hit.
    if (skip.has(key)) {
      hit.add(key);
      continue;
    }

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

const stale = baseline.mutableArrayParams.filter((e) => !hit.has(e));

console.log(`\nTotal parameters made readonly: ${changed}`);
let failed = false;

if (changed > 0) {
  console.error(
    "New array parameters were made readonly. Run `tsc --noEmit` to find genuine mutations,\n" +
    "then add them to .readonly-params-baseline.json and re-stage.",
  );
  failed = true;
}

if (stale.length > 0) {
  console.error(
    `\nStale baseline entries (parameter no longer mutable or no longer exists):\n` +
    stale.map((e) => `  ${e}`).join("\n") + "\n" +
    "Remove them from .readonly-params-baseline.json.",
  );
  failed = true;
}

if (failed) process.exit(1);
