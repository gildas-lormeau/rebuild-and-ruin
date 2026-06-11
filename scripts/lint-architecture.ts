/**
 * Architecture lint — verify runtime sub-system conventions.
 *
 * A sub-system is any `.ts` file under `runtime/subsystems/`. Directory is
 * the contract: if it lives in `subsystems/`, it's a sub-system; if it lives
 * at `runtime/` root, it's a primitive. No EXEMPT list, no basename rules.
 *
 * Checks:
 * 1. Every sub-system file must export at least one factory function
 *    (create*) or entry function (update*).
 * 2. That factory/entry must accept a single deps/config parameter
 *    (not loose args).
 * 3. Sub-system files must not import from other sub-system files. They may
 *    import from runtime/ root primitives listed in `ALLOWED_RUNTIME_BASENAMES`,
 *    or from approved sub-folders (`browser/`, `dialogs/`, `modifier-effects/`,
 *    `audio/`) — those are primitive/effect clusters, not sub-systems.
 * 4. Only composition.ts may import from sub-system files.
 * 5. Inverse rule — no file at `runtime/` root may export a
 *    `create*System|Subsystem|Orchestrator|Animator|Lookup` factory: those
 *    are sub-systems and must live in `subsystems/`. This is the
 *    drift-prevention check that keeps the partition mechanical.
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
/** Runtime-root primitive files (direct children of `runtime/`) that
 *  sub-systems may import. Sub-folders (`browser/`, `dialogs/`,
 *  `modifier-effects/`, `audio/`) are blanket-allowed via path check below.
 *  Cross-domain rules live in `lint-restricted-imports.ts`. */
const ALLOWED_RUNTIME_BASENAMES = new Set([
  "types.ts",
  "handle.ts", // GameRuntime interface (pure type file)
  "state.ts",
  "ui-contracts.ts", // UI contracts (overlay/screen factories, hit tests, touch handles, input-handler registration)
  "banner-state.ts", // BannerState type + null-init constructor
  "tick-context.ts", // shared tick state primitives
  "bootstrap.ts", // consumed by subsystems/selection
  "phase-machine.ts", // pure data-driven state machine, consumed by subsystems/phase-ticks
  "castle-build.ts", // pure animation primitives, consumed by subsystems/selection
  "battle-anim.ts", // pure battle-event-to-render-anim translation, consumed by subsystems/phase-ticks
  "banner-messages.ts", // phase transition banner string constants
  "camera-projection.ts", // pure camera-projection math, consumed by subsystems/camera
  "camera-pitch.ts", // pitch (battle-tilt) state machine primitives, consumed by subsystems/camera
  "timer-accums.ts", // pure phase-timer accumulator helpers, consumed by subsystems/phase-ticks + selection
]);
/** Sub-folders inside `runtime/` containing primitives/clusters that
 *  sub-systems may import freely. Listed as path segments (no trailing
 *  slash) and matched by resolved import path. */
const ALLOWED_RUNTIME_SUBDIRS = new Set([
  "browser",
  "dialogs",
  "modifier-effects",
  "audio",
]);
/** Regex matching factory-export names that mark a file as a sub-system.
 *  Used by Check 5 (the inverse-drift rule). */
const SUBSYSTEM_FACTORY_RE =
  /^export function (create\w+(?:System|Subsystem|Orchestrator|Animator|Lookup))\(/m;

main();

function main(): void {
  const subSystems = getSubSystemFiles();
  const violations: Violation[] = [];

  console.log(`Checking ${subSystems.length} runtime sub-system files...\n`);

  for (const file of subSystems) {
    checkSubSystem(file, violations);
  }
  checkConsumers(violations);
  checkNoFactoriesAtRoot(violations);

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
  const filePath = join(RUNTIME_DIR, file);
  const content = readFileSync(filePath, "utf-8");
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

  // Check 3: Must not import from other sub-system files. Resolve each
  // import relative to this file's directory and check membership in
  // SUBSYSTEMS_DIR — basename matching is unsafe now that sub-system files
  // collide with same-named files in other domains (e.g. `input.ts`).
  const imports = getImports(content);
  const fileDir = join(filePath, "..");
  for (const imp of imports) {
    const resolved = join(fileDir, imp);
    if (resolved.startsWith(SUBSYSTEMS_DIR + "/") && resolved !== filePath) {
      violations.push({
        file,
        message:
          `Imports from sub-system ${basename(imp)} — ` +
          `sub-systems must not depend on each other`,
      });
      continue;
    }
    // Only audit imports that resolve inside RUNTIME_DIR. Cross-domain
    // imports are handled by lint-domain-boundaries.ts.
    if (!resolved.startsWith(RUNTIME_DIR + "/")) continue;
    // Sub-folder primitive clusters (browser/, dialogs/, modifier-effects/,
    // audio/) are blanket-allowed; explicit allowlist is for direct children.
    const rel = resolved.slice(RUNTIME_DIR.length + 1);
    const firstSegment = rel.split("/")[0]!;
    if (rel.includes("/") && ALLOWED_RUNTIME_SUBDIRS.has(firstSegment)) {
      continue;
    }
    const importBase = basename(imp);
    if (!rel.includes("/") && !ALLOWED_RUNTIME_BASENAMES.has(importBase)) {
      violations.push({
        file,
        message:
          `Imports from runtime/ file ${importBase} — not in the ` +
          `non-subsystem allowlist (ALLOWED_RUNTIME_BASENAMES in ` +
          `lint-architecture.ts)`,
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
  // Check 4: Only composition.ts may import from sub-system files.
  // Resolve each import to an absolute path and check directory membership
  // — basename matching would false-positive on same-named files in other
  // domains (e.g. src/input/input.ts, src/render/3d/camera.ts).
  const allTs = collectAllTsFiles(SRC);
  for (const filePath of allTs) {
    const base = basename(filePath);
    if (base === "composition.ts") continue;
    if (filePath.startsWith(SUBSYSTEMS_DIR)) continue;

    const content = readFileSync(filePath, "utf-8");
    const imports = getImports(content);
    const fileDir = join(filePath, "..");
    for (const imp of imports) {
      const resolved = join(fileDir, imp);
      if (resolved.startsWith(SUBSYSTEMS_DIR + "/")) {
        const relPath = relative(process.cwd(), filePath);
        violations.push({
          file: relPath,
          message:
            `Imports from sub-system ${basename(imp)} — only ` +
            `composition.ts should import sub-systems`,
        });
      }
    }
  }
}

function getSubSystemFiles(): string[] {
  const result: string[] = [];
  if (statSync(SUBSYSTEMS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    for (const f of readdirSync(SUBSYSTEMS_DIR)) {
      if (f.endsWith(".ts")) result.push(`subsystems/${f}`);
    }
  }
  return result.sort();
}

/** Check 5: nothing at `runtime/` root may export a sub-system factory.
 *  Sub-systems live in `subsystems/` — that's the partition the lint
 *  enforces. If you add a `createXSystem(deps)` at root by accident, this
 *  fires and points you at the right directory. */
function checkNoFactoriesAtRoot(violations: Violation[]): void {
  if (!statSync(RUNTIME_DIR, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const f of readdirSync(RUNTIME_DIR)) {
    if (!f.endsWith(".ts")) continue;
    if (f === "composition.ts") continue;
    const content = readFileSync(join(RUNTIME_DIR, f), "utf-8");
    const m = content.match(SUBSYSTEM_FACTORY_RE);
    if (m) {
      violations.push({
        file: f,
        message:
          `Exports sub-system factory ${m[1]}() at runtime/ root — ` +
          `sub-systems must live in src/runtime/subsystems/.`,
      });
    }
  }
}

function getImports(content: string): string[] {
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    // Skip type-only imports — they're erased at compile time and create
    // no runtime coupling between sub-systems. Sub-systems are free to
    // reference each other's public interface contracts (the `RuntimeXxx`
    // types co-located with each subsystem file).
    if (line.match(/^\s*import\s+type\b/)) continue;
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
