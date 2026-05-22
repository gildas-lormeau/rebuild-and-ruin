/**
 * Architecture lint — verify runtime sub-system conventions.
 *
 * A sub-system is either a top-level `runtime-*.ts` file (not in EXEMPT) or
 * any `.ts` file under `runtime/subsystems/`.
 *
 * Checks:
 * 1. Every sub-system file must export at least one factory function
 *    (create*) or entry function (update*).
 * 2. That factory/entry must accept a single deps/config parameter
 *    (not loose args).
 * 3. Sub-system files must not import from other sub-system files
 *    (the import is detected by target basename, regardless of location).
 *    Allowed runtime/ imports are the non-subsystem runtime files
 *    listed in ALLOWED_RUNTIME_BASENAMES.
 * 4. Only runtime-composition.ts may import from sub-system files.
 *
 * Usage:
 *   deno run -A scripts/lint-architecture.ts [--check]
 *
 * --check  Exit 1 if violations found (CI mode, default)
 * (no flags) Same as --check
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  message: string;
}

const SRC = join(process.cwd(), "src");
const RUNTIME_DIR = join(SRC, "runtime");
const SUBSYSTEMS_DIR = join(RUNTIME_DIR, "subsystems");
/** Files that are part of the runtime layer but are NOT sub-systems. */
const EXEMPT = new Set([
  "runtime-composition.ts",
  "runtime-types.ts",
  "runtime-state.ts",
  "runtime-banner-state.ts", // BannerState type + null-init constructor, not a factory sub-system
  "runtime-ui-contracts.ts", // UI contracts: overlay/screen factories, hit tests, touch component handles, input-handler registration
  "runtime-tick-context.ts", // shared tick state primitives, not a factory sub-system
  "runtime-tick-consumers.ts", // ONLINE_PHASE_TICKS_CONSUMERS registry, not a factory sub-system

  "runtime-bootstrap.ts",
  "runtime-browser-timing.ts", // entry-level TimingApi factory, not a sub-system
  "runtime-phase-machine.ts", // pure data-driven state machine, not a factory sub-system
  "runtime-battle-anim.ts", // pure battle-event-to-render-anim translation, not a factory sub-system
  "runtime-castle-build.ts", // pure animation primitives, not a factory sub-system
  "runtime-life-lost-core.ts", // pure dialog primitives, not a factory sub-system
  "runtime-upgrade-pick-core.ts", // pure dialog primitives, not a factory sub-system
]);
/** Prefixes for runtime-layer file families that are not sub-systems. */
const EXEMPT_PREFIXES = ["online-runtime-"];
/** Non-subsystem `runtime-*` files that sub-systems may import.
 *  Other imports (`shared/`, `game/`, or non-`runtime-` files inside `runtime/`)
 *  are not gated here — `lint-restricted-imports.ts` handles cross-domain rules. */
const ALLOWED_RUNTIME_BASENAMES = new Set([
  "runtime-types.ts",
  "runtime-state.ts",
  "runtime-ui-contracts.ts", // UI contracts (overlay/screen factories, hit tests, touch handles, input-handler registration)
  "runtime-banner-state.ts", // BannerState type + null-init constructor
  "runtime-tick-context.ts", // shared tick state primitives
  "runtime-bootstrap.ts", // consumed by runtime-selection
  "runtime-phase-machine.ts", // pure data-driven state machine, consumed by runtime-phase-ticks
  "runtime-castle-build.ts", // pure animation primitives, consumed by runtime-selection
  "runtime-battle-anim.ts", // pure battle-event-to-render-anim translation, consumed by runtime-phase-ticks
  "runtime-life-lost-core.ts", // pure dialog primitives, consumed by runtime-life-lost
  "runtime-upgrade-pick-core.ts", // pure dialog primitives, consumed by runtime-upgrade-pick
]);

main();

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

  console.log(`\u2718 ${violations.length} architecture violation(s) found:\n`);
  for (const v of violations) {
    console.log(`  ${v.file}: ${v.message}`);
  }
  process.exit(1);
}

function checkSubSystem(file: string, violations: Violation[]): void {
  const content = readFileSync(join(RUNTIME_DIR, file), "utf-8");
  const fileBase = basename(file);
  const fns = getExportedFunctions(content);
  const subSystemBaseNames = new Set(
    getSubSystemFiles().map((f) => basename(f)),
  );

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

  // Check 3: Must not import from other sub-system files.
  //   Match by basename so the rule works for both root-level sub-systems
  //   (`./runtime-foo.ts`) and `subsystems/` peers (`./bar.ts`, `../runtime-foo.ts`).
  const imports = getImports(content);
  for (const imp of imports) {
    const importBase = basename(imp);
    if (subSystemBaseNames.has(importBase) && importBase !== fileBase) {
      violations.push({
        file,
        message: `Imports from sub-system ${importBase} — sub-systems must not depend on each other`,
      });
      continue;
    }
    if (
      importBase.startsWith("runtime-") &&
      !ALLOWED_RUNTIME_BASENAMES.has(importBase)
    ) {
      violations.push({
        file,
        message: `Imports from runtime/ file ${importBase} — not in the non-subsystem allowlist (ALLOWED_RUNTIME_BASENAMES in lint-architecture.ts)`,
      });
    }
  }
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

function checkConsumers(violations: Violation[]): void {
  const subSystemBaseNames = new Set(
    getSubSystemFiles().map((f) => basename(f)),
  );

  // Check 4: Only runtime-composition.ts may import from sub-system files
  const allTs = collectAllTsFiles(SRC);
  for (const filePath of allTs) {
    const base = basename(filePath);
    // runtime-composition.ts is the composition root — allowed to import everything
    if (base === "runtime-composition.ts") continue;
    // Sub-systems themselves are checked above (allowed to import runtime-types/state)
    if (base.startsWith("runtime-")) continue;
    if (filePath.startsWith(SUBSYSTEMS_DIR)) continue;

    const content = readFileSync(filePath, "utf-8");
    const imports = getImports(content);
    for (const imp of imports) {
      // Check if the import target basename is a sub-system file
      const importBase = basename(imp);
      if (subSystemBaseNames.has(importBase)) {
        const relPath = relative(process.cwd(), filePath);
        violations.push({
          file: relPath,
          message: `Imports from sub-system ${importBase} — only runtime-composition.ts should import sub-systems`,
        });
      }
    }
  }
}

function getSubSystemFiles(): string[] {
  const result: string[] = [];
  if (statSync(RUNTIME_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (
        f.startsWith("runtime-") &&
        f.endsWith(".ts") &&
        !EXEMPT.has(f) &&
        !EXEMPT_PREFIXES.some((p) => f.startsWith(p))
      ) {
        result.push(f);
      }
    }
  }
  if (statSync(SUBSYSTEMS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    for (const f of readdirSync(SUBSYSTEMS_DIR)) {
      if (f.endsWith(".ts")) result.push(`subsystems/${f}`);
    }
  }
  return result.sort();
}

function getImports(content: string): string[] {
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/from\s+"(\.[^"]+)"/);
    if (m) imports.push(m[1]!);
  }
  return imports;
}

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
