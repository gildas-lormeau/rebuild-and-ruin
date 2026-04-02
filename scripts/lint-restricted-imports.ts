/**
 * Restricted-imports lint — catch import patterns that LLM agents repeatedly get wrong.
 *
 * Rules:
 * 1. `Tile` enum must only be imported as a value in allowlisted files.
 *    All other files should use `import type { Tile }` or prefer spatial helpers
 *    (isWater, isGrass, waterKeys, etc.) instead.
 * 2. Entry-point files (main.ts, online-client.ts) must not be imported by src/ files.
 * 3. runtime.ts must not be imported by files outside the runtime layer.
 *
 * Usage:
 *   npx tsx scripts/lint-restricted-imports.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import process from "node:process";

const SRC = join(process.cwd(), "src");

interface Violation {
  file: string;
  line: number;
  message: string;
}

/** Parse import declarations from a file, distinguishing type-only imports. */
function parseImports(
  content: string,
): { source: string; names: string[]; typeOnly: boolean; line: number }[] {
  const results: {
    source: string;
    names: string[];
    typeOnly: boolean;
    line: number;
  }[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;

    // Match: import { ... } from "..."  or  import type { ... } from "..."
    const m = ln.match(
      /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/,
    );
    if (!m) continue;

    const isTypeOnlyDecl = !!m[1];
    const namesRaw = m[2]!;
    const source = m[3]!;

    const names: string[] = [];
    for (const part of namesRaw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle `type Foo` inline type specifier
      const cleaned = trimmed.replace(/^type\s+/, "");
      // For our purposes, if the entire import is `type` OR the specifier
      // has the `type` keyword, it's type-only for that name
      const specifierIsType = isTypeOnlyDecl || part.trim().startsWith("type ");
      if (!specifierIsType) {
        names.push(cleaned.split(/\s+as\s+/)[0]!.trim());
      }
    }

    results.push({
      source,
      names,
      typeOnly: isTypeOnlyDecl,
      line: i + 1,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 1: Tile enum value imports restricted to allowlist
// ---------------------------------------------------------------------------

/** Files allowed to import `Tile` as a value (not type-only). */
const TILE_VALUE_ALLOWLIST = new Set(["grid.ts", "spatial.ts", "map-generation.ts"]);

function checkTileImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const base = basename(file);
  if (TILE_VALUE_ALLOWLIST.has(base)) return;

  for (const imp of parseImports(content)) {
    if (!imp.source.endsWith("/grid.ts") && !imp.source.endsWith("/grid"))
      continue;
    if (imp.names.includes("Tile")) {
      violations.push({
        file: base,
        line: imp.line,
        message:
          "Value import of `Tile` enum — use `import type { Tile }` or prefer spatial helpers (isWater, isGrass)",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 2: Entry-point files must not be imported by other src/ files
// ---------------------------------------------------------------------------

const ENTRY_POINTS = new Set(["./main.ts", "./entry.ts"]);

function checkEntryPointImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const base = basename(file);
  // Entry points can import whatever they need
  if (ENTRY_POINTS.has(`./${base}`)) return;

  for (const imp of parseImports(content)) {
    if (ENTRY_POINTS.has(imp.source)) {
      violations.push({
        file: base,
        line: imp.line,
        message: `Imports from entry-point ${imp.source} — entry points must not be imported by other files`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 3: runtime.ts must only be imported from entry-point / online-client files
// ---------------------------------------------------------------------------

const RUNTIME_IMPORT_ALLOWLIST = new Set([
  "main.ts",
  "entry.ts",
  "online-client.ts",
  "online-client-runtime.ts",
  "online-client-deps.ts",
  "online-client-promote.ts",
  "runtime-headless.ts",
]);

function checkRuntimeImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const base = basename(file);
  if (RUNTIME_IMPORT_ALLOWLIST.has(base)) return;
  // runtime sub-systems are already checked by lint-architecture.ts
  if (base.startsWith("runtime-")) return;

  for (const imp of parseImports(content)) {
    if (imp.source === "./runtime.ts") {
      violations.push({
        file: base,
        line: imp.line,
        message:
          "Imports from runtime.ts — only entry points and online-client files should import runtime",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function collectFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(dir, f));
}

function main(): void {
  const srcFiles = collectFiles(SRC);
  const violations: Violation[] = [];

  for (const filePath of srcFiles) {
    const content = readFileSync(filePath, "utf-8");
    checkTileImports(filePath, content, violations);
    checkEntryPointImports(filePath, content, violations);
    checkRuntimeImports(filePath, content, violations);
  }

  if (violations.length === 0) {
    console.log(
      `\u2714 No restricted-import violations (${srcFiles.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} restricted-import violation(s) found:\n`,
  );
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}: ${v.message}`);
  }
  process.exit(1);
}

main();
