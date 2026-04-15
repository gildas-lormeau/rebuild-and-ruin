/**
 * Restricted-imports lint — catch import patterns that LLM agents repeatedly get wrong.
 *
 * Rules:
 * 1. `Tile` enum must only be imported as a value in allowlisted files.
 *    All other files should use `import type { Tile }` or prefer spatial helpers
 *    (isWater, isGrass, waterKeys, etc.) instead.
 *
 * 2. Non-game files must go through `src/game/index.ts` (the barrel) rather than
 *    deep-importing from specific `src/game/*.ts` files. A narrow allowlist exists
 *    for network-replay primitives in `online-server-events.ts` — symbols that
 *    apply authoritative server events to watcher state and are intentionally
 *    kept out of the public game surface.
 *
 * 3. `UID` must only be imported as a value in `src/game/upgrades/**` (the per-
 *    upgrade files) and `src/ai/ai-upgrade-pick.ts` (the AI pick strategy). All
 *    upgrade-specific behavior lives in per-upgrade files behind the
 *    `src/game/upgrade-system.ts` dispatcher; runtime/battle/build/cannon code
 *    must call the dispatcher instead of branching on UID values directly. This
 *    is an LLM-safety constraint: concentrating upgrade scatter into one
 *    directory makes it much harder for generated code to "hack" the game.
 *
 * Usage:
 *   deno run -A scripts/lint-restricted-imports.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  message: string;
}

const SRC = join(process.cwd(), "src");
/** Files allowed to import `Tile` as a value (not type-only). */
const TILE_VALUE_ALLOWLIST = new Set([
  "grid.ts",
  "spatial.ts",
  "map-generation.ts",
]);
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
const ALLOWED_SUBSYSTEM_DOMAINS = new Set(["shared", "runtime", "game"]);
/** Narrow allowlist of (importer → source → symbols) tuples that may bypass
 *  the game barrel. These are network-state-conformance primitives: they
 *  apply authoritative server events / checkpoints to watcher state during
 *  host→watcher sync, and are deliberately kept out of `game/index.ts` so no
 *  other code path can accidentally couple to them. */
const GAME_DEEP_IMPORT_ALLOWLIST: Record<
  string,
  Record<string, Set<string>>
> = {
  "src/online/online-server-events.ts": {
    "../game/battle-system.ts": new Set([
      "applyImpactEvent",
      "applyTowerKilled",
      "spawnCannonballFromMessage",
    ]),
    "../game/build-system.ts": new Set(["applyPiecePlacement"]),
    "../game/cannon-system.ts": new Set(["applyCannonPlacement"]),
  },
  "src/online/online-phase-transitions.ts": {
    "../game/phase-setup.ts": new Set(["setPhase"]),
  },
  "src/online/online-serialize.ts": {
    "../game/phase-setup.ts": new Set(["setPhase"]),
  },
  "src/runtime/runtime-phase-machine.ts": {
    // Machine transitions call setPhase directly inside watcher mutate fns
    // (post-checkpoint phase flip) — the symbol belongs to the
    // network-state-conformance primitive set, same rationale as the
    // online-phase-transitions.ts / online-serialize.ts exemptions.
    "../game/phase-setup.ts": new Set(["setPhase"]),
  },
};

main();

function main(): void {
  const srcFiles = collectFiles(SRC);
  const violations: Violation[] = [];

  for (const filePath of srcFiles) {
    const content = readFileSync(filePath, "utf-8");
    checkTileImports(filePath, content, violations);
    checkRuntimeSubsystemImports(filePath, content, violations);
    checkGameDeepImports(filePath, content, violations);
    checkUidImports(filePath, content, violations);
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
    const domain = sourceMatch[2]!;
    if (!ALLOWED_SUBSYSTEM_DOMAINS.has(domain)) {
      violations.push({
        file: relative(process.cwd(), file),
        line: idx + 1,
        message: `Runtime subsystem imports from ${domain}/ — only shared/, runtime/, and game/ allowed. Move the type to shared/ui-contracts.ts or inject the value from the composition root.`,
      });
    }
  }
}

function checkGameDeepImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  // game/ files may import from their own siblings freely
  if (rel.startsWith("src/game/")) return;

  const allowlist = GAME_DEEP_IMPORT_ALLOWLIST[rel] ?? {};

  for (const imp of parseImports(content)) {
    // Match any import from ../game/<file>.ts that's NOT the barrel
    const gameMatch = imp.source.match(/^(\.\.?\/)+game\/([\w-]+)\.ts$/);
    if (!gameMatch) continue;
    if (gameMatch[2] === "index") continue;

    const allowedForSource = allowlist[imp.source];
    const disallowed = allowedForSource
      ? imp.names.filter((name) => !allowedForSource.has(name))
      : imp.names;

    if (disallowed.length > 0) {
      violations.push({
        file: rel,
        line: imp.line,
        message: `Deep import from "${imp.source}" — non-game files must import from "../game/index.ts". Disallowed: ${disallowed.join(", ")}`,
      });
    }
  }
}

function checkUidImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  if (isUidValueAllowed(rel)) return;

  for (const imp of parseImports(content)) {
    if (
      !imp.source.endsWith("/upgrade-defs.ts") &&
      !imp.source.endsWith("/upgrade-defs")
    )
      continue;
    if (imp.names.includes("UID")) {
      violations.push({
        file: rel,
        line: imp.line,
        message:
          "Value import of `UID` — upgrade-specific branching belongs in src/game/upgrades/. Call a semantic function on src/game/upgrade-system.ts instead.",
      });
    }
  }
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
    const m = ln.match(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/);
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

/** Files allowed to import `UID` as a value. Every other file must call
 *  the `src/game/upgrade-system.ts` dispatcher (or go through the game
 *  barrel) instead of branching on UID values directly. */
function isUidValueAllowed(rel: string): boolean {
  if (rel.startsWith("src/game/upgrades/")) return true;
  if (rel === "src/ai/ai-upgrade-pick.ts") return true;
  return false;
}

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
