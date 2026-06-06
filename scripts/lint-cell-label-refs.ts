/**
 * Lint: cell role labels must not name a module that isn't in the cell.
 *
 * `.import-cells.json` role labels are hand-curated docs keyed by mechanical
 * `layer::domain`. A global layer renumber (triggered by ANY change to a low
 * file's import depth) silently shifts files between cells, leaving labels
 * authored for their previous occupants — see commit 450a9625, which rotted
 * ~16 cells this way. `regen-cells --check` only catches MISSING labels, not
 * label↔content mismatch.
 *
 * This guard catches the mechanically-checkable slice of that drift: a role
 * that NAMES a module (a hyphenated basename token like `castle-build`,
 * `tick-consumers`, `wall-impact`, `phase-ticks`) must contain that module.
 * Matching is EXACT basename equality on hyphenated tokens only — zero false
 * positives (`wall-mutating`, `modifier-reveal` don't match real basenames, so
 * they're ignored), at the cost of not checking single-word or purely
 * conceptual labels (e.g. "grunt system"), which no referential check can
 * verify. Prefer non-enumerating labels to stay clear of this entirely.
 *
 * Exit 1 on drift. Wired into pre-commit + lint-all as `cell-label-refs`.
 */

import fs from "node:fs";
import process from "node:process";

interface Cell {
  layer: number;
  domain: string;
  subdomain?: string;
  role: string;
  files: string[];
}

const CELLS_FILE = ".import-cells.json";
/** Hyphenated kebab tokens — the only label fragments that unambiguously
 *  name a module (multi-part basenames never collide with English words). */
const KEBAB_TOKEN = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

main();

function main(): void {
  const cells = JSON.parse(fs.readFileSync(CELLS_FILE, "utf-8")) as Cell[];

  // basename → every file with that basename (across all cells).
  const basenameToFiles = new Map<string, string[]>();
  for (const cell of cells) {
    for (const file of cell.files) {
      const base = basename(file);
      const list = basenameToFiles.get(base);
      if (list) list.push(file);
      else basenameToFiles.set(base, [file]);
    }
  }

  const violations: string[] = [];
  for (const cell of cells) {
    const here = new Set(cell.files);
    const tokens = new Set(cell.role.match(KEBAB_TOKEN) ?? []);
    for (const token of tokens) {
      const matches = basenameToFiles.get(token);
      if (!matches) continue; // token isn't a real module name — ignore
      if (matches.some((file) => here.has(file))) continue; // present — ok
      violations.push(
        `  [${cellKey(cell)}] role "${cell.role}"\n` +
          `    names "${token}" but that module lives at: ${matches.join(", ")}`,
      );
    }
  }

  if (violations.length > 0) {
    console.log(
      `✘ ${violations.length} cell label(s) name a module not in the cell ` +
        `(stale after a layer renumber — re-confirm the role in scripts/cells/regen-cells.ts):\n`,
    );
    console.log(violations.join("\n\n"));
    process.exit(1);
  }

  console.log(`✔ No cell-label drift (${cells.length} cells checked)`);
}

function basename(file: string): string {
  return file.replace(/^.*\//, "").replace(/\.ts$/, "");
}

function cellKey(cell: Cell): string {
  return `${cell.layer}::${cell.domain}${cell.subdomain ? "/" + cell.subdomain : ""}`;
}
