/**
 * Role → cell lookup. Search `.import-cells.json` by keyword and show
 * matching cells with their files, so an agent placing new code can
 * find the right (layer, domain) without grepping.
 *
 * Matching: case-insensitive token search over `role` labels. Score =
 * count of query tokens found in the label + a small bonus for whole-
 * phrase matches. Top N results are printed.
 *
 * Usage:
 *   deno run -A scripts/cells/cell-lookup.ts "modifier effect"
 *   deno run -A scripts/cells/cell-lookup.ts "wire payload"
 *   deno run -A scripts/cells/cell-lookup.ts "ai strategy" --max 3
 *   deno run -A scripts/cells/cell-lookup.ts "renderer" --json
 *
 * Flags:
 *   --max N    Limit results (default 5)
 *   --json     Emit JSON instead of human-readable output
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { tierOfLayer } from "./tier-of-layer.ts";

interface Cell {
  layer: number;
  domain: string;
  /** Optional subpath partition — see `SUBPATH_PARTITIONS` in
   *  `scripts/cells/regen-cells.ts`. */
  subdomain?: string;
  role: string;
  files: string[];
}

interface ScoredCell {
  cell: Cell;
  score: number;
  matchedTokens: string[];
}

const ROOT = path.resolve(import.meta.dirname!, "..", "..");
const CELLS_PATH = path.join(ROOT, ".import-cells.json");
const DEFAULT_MAX = 5;
const PHRASE_BONUS = 3;
const SHOW_FILES_LIMIT = 5;

main();

function main(): void {
  const { query, max, json } = parseArgs(Deno.args);
  if (!query) {
    console.error(
      'Usage: deno run -A scripts/cells/cell-lookup.ts "<role keywords>" [--max N] [--json]',
    );
    Deno.exit(2);
  }

  const cells: Cell[] = JSON.parse(readFileSync(CELLS_PATH, "utf-8"));
  const ranked = rank(cells, query).slice(0, max);

  if (json) {
    console.log(JSON.stringify(ranked, null, 2));
    return;
  }

  if (ranked.length === 0) {
    console.log(`No cells matched "${query}".`);
    console.log(`\nClosest by tier — try one of these and refine:`);
    for (const tier of ["types", "logic", "systems", "assembly", "roots"]) {
      const sample = cells.find((cell) => tierOfLayer(cell.layer) === tier);
      if (sample)
        console.log(
          `  [${tier}] e.g. L${sample.layer} · ${formatDisplayDomain(sample)}`,
        );
    }
    return;
  }

  console.log(`Matches for "${query}":\n`);
  for (const scored of ranked) {
    const { cell, matchedTokens } = scored;
    const fileCount = cell.files.length;
    console.log(
      `→ L${cell.layer} · ${formatDisplayDomain(cell)} [${tierOfLayer(cell.layer)}] — ${cell.role}  (${fileCount} file${fileCount === 1 ? "" : "s"}, matched: ${matchedTokens.join(", ")})`,
    );
    const shown = cell.files.slice(0, SHOW_FILES_LIMIT);
    for (const file of shown) console.log(`    ${file}`);
    if (fileCount > SHOW_FILES_LIMIT) {
      console.log(`    ... ${fileCount - SHOW_FILES_LIMIT} more`);
    }
    console.log();
  }

  console.log(
    `Extension hint: read 1–2 existing files in the top cell to learn the pattern, then either extend an existing file or create a new one in the same directory.`,
  );
}

function formatDisplayDomain(cell: Pick<Cell, "domain" | "subdomain">): string {
  return cell.subdomain !== undefined
    ? `${cell.domain}/${cell.subdomain}`
    : cell.domain;
}

function parseArgs(argv: string[]): {
  query: string;
  max: number;
  json: boolean;
} {
  const positional: string[] = [];
  let max = DEFAULT_MAX;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--max") {
      max = Number(argv[++i] ?? DEFAULT_MAX);
    } else if (arg.startsWith("--max=")) {
      max = Number(arg.slice("--max=".length));
    } else {
      positional.push(arg);
    }
  }
  return { query: positional.join(" ").trim(), max, json };
}

function rank(cells: Cell[], query: string): ScoredCell[] {
  const lowerQuery = query.toLowerCase();
  const tokens = lowerQuery.split(/\s+/).filter((tok) => tok.length > 0);
  const scored: ScoredCell[] = [];
  for (const cell of cells) {
    const lowerRole = cell.role.toLowerCase();
    const matched: string[] = [];
    let score = 0;
    for (const token of tokens) {
      if (lowerRole.includes(token)) {
        score += 1;
        matched.push(token);
      }
    }
    if (lowerRole.includes(lowerQuery) && tokens.length > 1)
      score += PHRASE_BONUS;
    if (score > 0) scored.push({ cell, score, matchedTokens: matched });
  }
  scored.sort((leftCell, rightCell) => {
    if (rightCell.score !== leftCell.score)
      return rightCell.score - leftCell.score;
    return rightCell.cell.files.length - leftCell.cell.files.length;
  });
  return scored;
}
