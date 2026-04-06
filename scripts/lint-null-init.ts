/**
 * lint-null-init — flag `| null = null` declarations.
 *
 * Convention: use `| undefined` (no initializer needed) for "not yet set"
 * variables and class fields. `null` is reserved for data model values
 * (serialized state, dialog choices, etc.).
 *
 * Catches:
 *   let x: Foo | null = null;
 *   field: Foo | null = null;
 *
 * Does NOT flag:
 *   - Interface/type fields with `| null` (data model)
 *   - Function parameters with `| null` defaults
 *   - `= null` assignments (only declarations)
 *
 * Usage:
 *   deno run -A scripts/lint-null-init.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const SCAN_DIRS = [
  join(process.cwd(), "src"),
  join(process.cwd(), "server"),
];

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

// Match: `| null = null` in let/const/field declarations
const NULL_INIT_PATTERN = /\|\s*null\s*=\s*null\s*[;,]/;

const violations: Violation[] = [];

function scanDir(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      scanDir(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      scanFile(full);
    }
  }
}

function scanFile(filePath: string) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (NULL_INIT_PATTERN.test(line)) {
      violations.push({
        file: relative(process.cwd(), filePath),
        line: li + 1,
        snippet: line.trim(),
      });
    }
  }
}

for (const dir of SCAN_DIRS) scanDir(dir);

if (violations.length === 0) {
  console.log("✔ No | null = null declarations found");
  process.exit(0);
} else {
  console.log(
    `✘ ${violations.length} | null = null declaration(s) — use | undefined instead:\n`,
  );
  for (const vi of violations) {
    console.log(`  ${vi.file}:${vi.line}  ${vi.snippet}`);
  }
  process.exit(1);
}
