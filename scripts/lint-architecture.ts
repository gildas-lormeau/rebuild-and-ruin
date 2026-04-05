/**
 * Architecture lint — verify runtime sub-system conventions.
 *
 * Checks:
 * 1. Every runtime-*.ts sub-system file (excluding exempt files) must export
 *    exactly one factory function (create*) or entry function (update*).
 * 2. That factory/entry must accept a single deps/config parameter (not loose args).
 * 3. Sub-system files must not import from other sub-system files
 *    (only from runtime-types.ts and runtime-state.ts).
 * 4. Only runtime.ts may import from sub-system files.
 *
 * Usage:
 *   npx tsx scripts/lint-architecture.ts [--check]
 *
 * --check  Exit 1 if violations found (CI mode, default)
 * (no flags) Same as --check
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename, relative } from "path";
import process from "node:process";

const SRC = join(process.cwd(), "src");
const RUNTIME_DIR = join(SRC, "runtime");

/** Files that are part of the runtime layer but are NOT sub-systems. */
const EXEMPT = new Set([
  "runtime.ts",
  "runtime-types.ts",
  "runtime-state.ts",
  "runtime-headless.ts",
  "runtime-bootstrap.ts",
  "runtime-host-phase-ticks.ts", // pure tick functions, not a factory sub-system
  "runtime-host-battle-ticks.ts", // pure tick functions, not a factory sub-system
  "runtime-e2e-bridge.ts", // e2e test bridge, not a factory sub-system
  "runtime-touch-ui.ts", // pure function, not a factory sub-system
]);

/** Prefixes for runtime-layer file families that are not sub-systems. */
const EXEMPT_PREFIXES = ["runtime-online-"];

/** Sub-system files may import from these runtime-layer files. */
const ALLOWED_RUNTIME_IMPORTS = new Set([
  "./runtime-types.ts",
  "./runtime-state.ts",
  "./runtime-host-phase-ticks.ts", // consumed by runtime-phase-ticks
  "./runtime-host-battle-ticks.ts", // consumed by runtime-phase-ticks
  "./runtime-bootstrap.ts", // consumed by runtime-selection
  "./runtime-touch-ui.ts", // consumed by runtime-render
]);

interface Violation {
  file: string;
  message: string;
}

function getSubSystemFiles(): string[] {
  if (!statSync(RUNTIME_DIR, { throwIfNoEntry: false })?.isDirectory())
    return [];
  return readdirSync(RUNTIME_DIR)
    .filter(
      (f) =>
        f.startsWith("runtime-") &&
        f.endsWith(".ts") &&
        !EXEMPT.has(f) &&
        !EXEMPT_PREFIXES.some((p) => f.startsWith(p)),
    )
    .sort();
}

function getImports(content: string): string[] {
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/from\s+"(\.[^"]+)"/);
    if (m) imports.push(m[1]!);
  }
  return imports;
}

function getExportedFunctions(
  content: string,
): { name: string; params: string }[] {
  const fns: { name: string; params: string }[] = [];
  // Match multiline: find "export function name(" then collect until balanced ")"
  const re = /^export function (\w+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < content.length && depth > 0) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
      i++;
    }
    const params = content.slice(start, i - 1).trim();
    fns.push({ name: m[1]!, params });
  }
  return fns;
}

function checkSubSystem(file: string, violations: Violation[]): void {
  const content = readFileSync(join(RUNTIME_DIR, file), "utf-8");
  const fns = getExportedFunctions(content);

  // Check 1: Must export at least one factory/entry function
  const factories = fns.filter((f) => /^(create|update)\w+/.test(f.name));
  if (factories.length === 0) {
    violations.push({
      file,
      message: `No exported create*/update* factory function found`,
    });
    return;
  }

  // Check 2: Factory must accept a single deps parameter (not loose args).
  // Two-phase factories (zero-param constructor, deps passed to register())
  // are allowed for files that need early creation before deps are available.
  const TWO_PHASE_FACTORIES = new Set(["createInputSystem"]);

  for (const fn of factories) {
    const params = fn.params.trim();
    if (!params) {
      if (TWO_PHASE_FACTORIES.has(fn.name)) continue;
      violations.push({
        file,
        message: `${fn.name}() has no parameters — expected a deps object`,
      });
      continue;
    }
    // Count top-level params: split by commas outside generics/braces, ignore trailing comma
    let depth = 0;
    let commaCount = 0;
    for (const ch of params) {
      if (ch === "<" || ch === "{" || ch === "(") depth++;
      else if (ch === ">" || ch === "}" || ch === ")") depth--;
      else if (ch === "," && depth === 0) commaCount++;
    }
    // Trailing comma after last param doesn't mean another param
    const trimmed = params.replace(/\s+/g, " ").trim();
    const hasTrailingComma = trimmed.endsWith(",");
    const paramCount = commaCount + 1 - (hasTrailingComma ? 1 : 0);
    if (paramCount > 1) {
      violations.push({
        file,
        message: `${fn.name}() has ${paramCount} parameters — expected a single deps object`,
      });
    }
  }

  // Check 3: Must not import from other sub-system files
  const imports = getImports(content);
  for (const imp of imports) {
    if (imp.startsWith("./runtime-") && !ALLOWED_RUNTIME_IMPORTS.has(imp)) {
      const target = imp.replace("./", "");
      violations.push({
        file,
        message: `Imports from sub-system ${target} — sub-systems must not depend on each other`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

function collectAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectAllTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function checkConsumers(violations: Violation[]): void {
  const subSystemBaseNames = new Set(getSubSystemFiles());

  // Check 4: Only runtime.ts may import from sub-system files
  const allTs = collectAllTsFiles(SRC);
  for (const filePath of allTs) {
    const base = basename(filePath);
    // runtime.ts is the composition root — it's allowed to import everything
    if (base === "runtime.ts") continue;
    // Sub-systems themselves are checked above (allowed to import runtime-types/state)
    if (base.startsWith("runtime-")) continue;

    const content = readFileSync(filePath, "utf-8");
    const imports = getImports(content);
    for (const imp of imports) {
      // Check if the import target basename is a sub-system file
      const importBase = basename(imp);
      if (subSystemBaseNames.has(importBase)) {
        const relPath = relative(process.cwd(), filePath);
        violations.push({
          file: relPath,
          message: `Imports from sub-system ${importBase} — only runtime.ts should import sub-systems`,
        });
      }
    }
  }
}

function main(): void {
  const subSystems = getSubSystemFiles();
  const violations: Violation[] = [];

  console.log(`Checking ${subSystems.length} runtime sub-system files...\n`);

  for (const file of subSystems) {
    checkSubSystem(file, violations);
  }
  checkConsumers(violations);

  if (violations.length === 0) {
    console.log(
      `\u2714 No architecture violations (${subSystems.length} sub-systems checked)\n`,
    );
    console.log("Sub-systems:");
    for (const f of subSystems) {
      const content = readFileSync(join(RUNTIME_DIR, f), "utf-8");
      const fns = getExportedFunctions(content)
        .filter((fn) => /^(create|update)\w+/.test(fn.name))
        .map((fn) => fn.name);
      console.log(`  ${f} → ${fns.join(", ")}`);
    }
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} architecture violation(s) found:\n`,
  );
  for (const v of violations) {
    console.log(`  ${v.file}: ${v.message}`);
  }
  process.exit(1);
}

main();
