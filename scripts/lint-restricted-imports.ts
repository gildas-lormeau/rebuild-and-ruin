/**
 * Restricted-imports lint — catch import patterns that LLM agents repeatedly get wrong.
 *
 * Rules:
 * 1. `Tile` enum must only be imported as a value in allowlisted files.
 *    All other files should use `import type { Tile }` or prefer spatial helpers
 *    (isWater, isGrass, waterKeys, etc.) instead.
 *
 * Usage:
 *   deno run -A scripts/lint-restricted-imports.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
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
        file: relative(process.cwd(), file),
        line: imp.line,
        message:
          "Value import of `Tile` enum — use `import type { Tile }` or prefer spatial helpers (isWater, isGrass)",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 2: Runtime subsystems must only import from shared/ and runtime/
// ---------------------------------------------------------------------------

/** Runtime subsystem files (architecture-linter list). */
const RUNTIME_SUBSYSTEMS = new Set([
  "runtime-banner.ts",
  "runtime-camera.ts",
  "runtime-game-lifecycle.ts",
  "runtime-human.ts",
  "runtime-input.ts",
  "runtime-life-lost.ts",
  "runtime-lobby.ts",
  "runtime-options.ts",
  "runtime-phase-ticks.ts",
  "runtime-render.ts",
  "runtime-score-deltas.ts",
  "runtime-selection.ts",
  "runtime-upgrade-pick.ts",
]);

/** Domains that runtime subsystems (L8) are allowed to import from. */
const ALLOWED_SUBSYSTEM_DOMAINS = new Set(["shared", "runtime"]);

/** game/ facade files that runtime subsystems (L8) may import. */
const ALLOWED_GAME_FACADES = new Set([
  "dialog-facade.ts",
  "selection-facade.ts",
  "phase-tick-facade.ts",
]);

function checkRuntimeSubsystemImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const base = basename(file);
  if (!RUNTIME_SUBSYSTEMS.has(base)) return;

  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx]!;
    const sourceMatch = ln.match(/from\s+"(\.\.\/(\w+)\/[^"]+)"/);
    if (!sourceMatch) continue;
    const importPath = sourceMatch[1]!;
    const domain = sourceMatch[2]!;
    if (domain === "game") {
      const importFile = basename(importPath);
      if (!ALLOWED_GAME_FACADES.has(importFile)) {
        violations.push({
          file: relative(process.cwd(), file),
          line: idx + 1,
          message: `Runtime subsystem imports directly from game/${importFile} — use a facade (${[...ALLOWED_GAME_FACADES].join(", ")}) instead.`,
        });
      }
    } else if (!ALLOWED_SUBSYSTEM_DOMAINS.has(domain)) {
      violations.push({
        file: relative(process.cwd(), file),
        line: idx + 1,
        message: `Runtime subsystem imports from ${domain}/ — only shared/ and runtime/ allowed. Move the type to shared/ui-contracts.ts or inject the value from the composition root.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const srcFiles = collectFiles(SRC);
  const violations: Violation[] = [];

  for (const filePath of srcFiles) {
    const content = readFileSync(filePath, "utf-8");
    checkTileImports(filePath, content, violations);
    checkRuntimeSubsystemImports(filePath, content, violations);
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
