/**
 * Restricted-imports lint — catch import patterns that LLM agents repeatedly get wrong.
 *
 * Rules:
 * 1. `Tile` enum must only be imported as a value in allowlisted files.
 *    All other files should use `import type { Tile }` or prefer spatial helpers
 *    (isWater, isGrass, etc.) instead.
 *
 * 2. Non-game files must go through `src/game/index.ts` (the barrel) rather than
 *    deep-importing from specific `src/game/*.ts` files. A narrow allowlist exists
 *    for network-state-conformance primitives in three online/ files
 *    (`online-server-events.ts`, `online-phase-transitions.ts`, `online-serialize.ts`)
 *    — symbols that apply authoritative server events / checkpoints to watcher
 *    state and are intentionally kept out of the public game surface.
 *
 * 3. `UID` must only be imported as a value in `src/game/upgrades/**` (the per-
 *    upgrade files) and `src/ai/ai-upgrade-pick.ts` (the AI pick strategy). All
 *    upgrade-specific behavior lives in per-upgrade files behind the
 *    `src/game/upgrade-system.ts` dispatcher; runtime/battle/build/cannon code
 *    must call the dispatcher instead of branching on UID values directly. This
 *    is an LLM-safety constraint: concentrating upgrade scatter into one
 *    directory makes it much harder for generated code to "hack" the game.
 *
 * 4. `src/runtime/*.ts` files must not import game-state mutation helpers from
 *    `src/shared/core/*`. Runtime is an observer/driver — it owns animation,
 *    lifecycle, and I/O, and must ask the game layer to mutate state via the
 *    game/ barrel (phase-setup, battle-system, build-system, cannon-system) or
 *    intent objects. Read-only predicates (isPlayerAlive, isPlayerEliminated,
 *    assertInteriorFresh, getInterior, getBattleInterior, isTileOwnedByPlayer,
 *    hasWallAt, …) and snapshotters (snapshotAllWalls, buildOccupancyCache,
 *    collectOccupiedTiles, …) remain allowed. A single allowlist entry —
 *    `runtime/castle-build.ts` importing `addPlayerWall` — is documented:
 *    the castle-build animation IS the wall placement, so the runtime drives
 *    it tile-by-tile. All other mutators are zero-hit today and this rule is
 *    a tripwire against future leaks.
 *
 * 5. `src/runtime/*.ts` files must not call `hasFeature(` directly. Feature
 *    gating belongs to the game layer — runtime should ask the game layer
 *    whether to run a given path (e.g. a phase/system function returning a
 *    no-op when the feature is inactive) rather than branching on capability
 *    flags. Zero-hit today; tripwire for future leaks.
 *
 * 6. Files in `src/controllers/` may only be imported by an explicit
 *    composition-root allowlist (`runtime/bootstrap.ts`) plus other files
 *    inside `src/controllers/` itself. All other code — including online
 *    promotion + rehydrate — routes through `runtime/bootstrap.ts`'s
 *    re-exports of the controller-factory surface, so online never
 *    crosses the `online → controllers` boundary directly.
 *
 * 7. `modifier-reveal-time.ts` (which resolves the banner-aware
 *    `revealTimeMs` scalar) must only be imported by `subsystems/render.ts`.
 *    Modifier-effect code receives `revealTimeMs` already-resolved; it must
 *    never call `revealTimeFor` / `tickModifierRevealClock` itself, nor
 *    inspect `runtimeState.banner` to derive reveal timing. New 2D overlay
 *    effects register in `modifier-reveal-overlay-registry.ts`; new 3D
 *    burst effects read `overlay.ui.modifierReveal.revealTimeMs` from the
 *    `MODIFIER_EFFECT_FACTORIES` registry.
 *
 * 8. `src/shared/sim/*.ts` is the simulation-internals tier (occupancy
 *    queries, interior freshness epochs, wall mutators). Only the simulation
 *    domains — game/ai/controllers/online/runtime — plus shared/ itself may
 *    import it. render/input/protocol and the entry roots are fenced out:
 *    they read game state through overlays + contracts (shared/ui,
 *    system-interfaces), never the sim mesh directly. Zero-hit today; the
 *    physical shared/sim/ subfolder makes the tier visible, this rule keeps
 *    presentation/wire code from reaching into it.
 *
 * 9. The `src/shared/` subfolders form a strict dependency DAG:
 *    `platform <- core <- {sim, ui}`. platform is zero-dep; core imports
 *    only platform; sim and ui each import core + platform but NOT each
 *    other (disjoint siblings). A lower tier importing a higher one is an
 *    inversion — it means either a shared symbol is parked too high (extract
 *    it down) or the file itself is misclassified (relocate it). This is the
 *    generalization of the wall-destroy-anim split: a core file that needs a
 *    ui/sim symbol is the tell. `SHARED_TIER_BASELINE` is currently empty —
 *    the historical core->ui edges were all resolved by extracting the
 *    misclassified symbol down (input vocabulary, FrameContext, the dialog
 *    decision-state cluster). Any new inversion fails; if one is ever
 *    genuinely unavoidable, grandfather it here with a comment. See
 *    src/shared/README.md's decision tree.
 *
 * 10. `getBattleInterior` (board-occupancy.ts) is the freshness-assert BYPASS:
 *    it returns `player.interior` WITHOUT `assertInteriorFresh`, so it hands
 *    back a knowingly-stale snapshot (walls destroyed frame-by-frame during
 *    BATTLE aren't reflected until the next build). That is correct ONLY for
 *    battle-time AI planning; peacetime code must use `getInterior()` (which
 *    asserts). The type system can't catch the misuse — the stale set is
 *    deliberately widened to `ReadonlySet<TileKey>` so it flows into shared
 *    graph helpers (findEnclosureComponents), which defeats any brand guard —
 *    so this is enforced structurally: only the battle-planner allowlist may
 *    import it. A stray peacetime import fails here. (Tests are out of scope:
 *    this lint scans src/ only.)
 *
 * Usage:
 *   deno run -A scripts/lint-restricted-imports.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, normalize, relative } from "node:path";
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
/** Runtime subsystem files. All sub-systems live in `runtime/subsystems/`
 *  (see `lint-architecture.ts`). Membership is checked by full path so
 *  basenames that also exist elsewhere (`input.ts`, `camera.ts`, …) don't
 *  collide. */
const RUNTIME_SUBSYSTEMS_DIR = "src/runtime/subsystems/";
/** Domains that runtime subsystems (L8) are allowed to import from. */
const ALLOWED_SUBSYSTEM_DOMAINS = new Set(["shared", "runtime", "game"]);
/** Mutation helpers from `src/shared/` (the sim write-surfaces) that runtime
 *  must not import. Keyed by module basename. Read-only predicates (is*, has*,
 *  get*, find*, filter*, collect*, snapshot*, assert*) are NOT listed — they
 *  stay allowed. Update this list when a new mutator is added to one of the
 *  listed files; the matching `PURITY_SOURCE_ALLOWED_IMPORTERS` map below
 *  documents the (source → importer → symbols) exemptions. */
const RUNTIME_FORBIDDEN_MUTATORS: Record<string, Set<string>> = {
  "player-bag.ts": new Set(["initPlayerBag", "advancePlayerBag"]),
  "player-rules.ts": new Set(["eliminatePlayer", "selectPlayerTower"]),
  "board-occupancy.ts": new Set([
    "addPlayerWall",
    "addPlayerWalls",
    "clearPlayerWalls",
    "sweepIsolatedWalls",
  ]),
  "player-walls.ts": new Set([
    "deletePlayerWallsBatch",
    "removeWallFromAllPlayers",
    "deletePlayerWallBattle",
  ]),
  "player-interior.ts": new Set(["markWallsDirty", "markInteriorFresh"]),
};
/** Runtime files allowed to import specific mutators. Keyed by source basename,
 *  then by importer path (relative to repo root). Intrinsic animation↔game
 *  entanglements only — the castle-build animation IS the wall placement, so
 *  the runtime drives it tile-by-tile via `addPlayerWall`. */
const RUNTIME_MUTATOR_ALLOWLIST: Record<string, Record<string, Set<string>>> = {
  "board-occupancy.ts": {
    "src/runtime/castle-build.ts": new Set(["addPlayerWall"]),
  },
};
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
      "applyCannonFired",
      "applyImpactEvent",
      "applyTowerKilled",
    ]),
    "../game/build-system.ts": new Set(["applyPiecePlacement"]),
    "../game/cannon-system.ts": new Set(["applyCannonAtDrain"]),
  },
  "src/online/online-serialize.ts": {
    "../game/phase-setup.ts": new Set(["setPhase"]),
  },
};
/** Sole importer of `modifier-reveal-time.ts` — the banner-aware reveal-
 *  timing resolver. Modifier-effect code receives `revealTimeMs` already
 *  resolved (via the 2D registry or the path-A `overlay.ui.modifierReveal`
 *  publication) and must never read banner state itself. */
const MODIFIER_REVEAL_TIME_IMPORTER = "src/runtime/subsystems/render.ts";
/** Composition-root files allowed to import from `src/controllers/`. Other
 *  files that need controller construction must accept a deps bag from
 *  their caller (see online-host-promotion.ts:AiPromotionDeps for the
 *  pattern). New roots must be justified in the import allowlist comment. */
const CONTROLLER_IMPORT_ALLOWLIST = new Set(["src/runtime/bootstrap.ts"]);
/** Domain path-prefixes permitted to import the `src/shared/sim/` tier (the
 *  simulation internals: occupancy queries, interior epochs, wall mutators).
 *  Everything else under src/ — render, input, protocol, and the entry roots —
 *  is fenced out: those layers read game state through overlays + contracts,
 *  not sim internals. */
const SIM_TIER_ALLOWED_PREFIXES = [
  "src/shared/",
  "src/game/",
  "src/ai/",
  "src/controllers/",
  "src/online/",
  "src/runtime/",
];
/** The shared/ subfolder dependency DAG: `platform <- core <- {sim, ui}`.
 *  Each tier may import itself plus everything below it. sim and ui are
 *  disjoint siblings (neither imports the other). A lower tier importing a
 *  higher one is an inversion (rule 9). */
const SHARED_TIER_ALLOWED: Record<string, ReadonlySet<string>> = {
  platform: new Set(["platform"]),
  core: new Set(["platform", "core"]),
  sim: new Set(["platform", "core", "sim"]),
  ui: new Set(["platform", "core", "ui"]),
};
/** Grandfathered core->ui inversions that predate rule 9 — documented debt,
 *  keyed by importer path → the exact cross-tier sources it may import. These
 *  are architectural contracts (FrameContext carries the ui Mode; the
 *  controller interfaces reference input Action / KeyBindings / dialog state),
 *  not quick extractions. The baseline only suppresses these exact edges;
 *  any other shared-tier inversion — including a NEW import added to these
 *  same files — fails. */
// Empty: every historical core->ui edge was resolved by extracting the
// misclassified symbol DOWN to core rather than grandfathering it —
// input vocabulary (Action, KeyBindings) -> core/input-action.ts,
// FrameContext -> runtime/state.ts, and the dialog decision-state cluster
// (LifeLostEntry / UpgradePickEntry / choices) -> core/dialog-state.ts.
// Add an entry here only if a future inversion is genuinely unavoidable.
const SHARED_TIER_BASELINE: Record<string, ReadonlySet<string>> = {};
/** Files allowed to import `getBattleInterior` — the freshness-assert bypass
 *  (rule 10). Only battle-time AI planners may read the intentionally-stale
 *  build-time interior snapshot; the defining file (board-occupancy.ts) is
 *  skipped as self. Everything else must call `getInterior()` (asserts fresh).
 *  Keyed by repo-relative path. */
const BATTLE_INTERIOR_ALLOWED_IMPORTERS = new Set([
  "src/ai/ai-strategy-battle.ts",
  "src/ai/ai-plan-grunt-breach.ts",
  "src/ai/ai-plan-wall-demolition.ts",
  "src/ai/ai-plan-max-repair-cost.ts",
]);

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
    checkRuntimeMutatorImports(filePath, content, violations);
    checkRuntimeHasFeatureCalls(filePath, content, violations);
    checkControllerImports(filePath, content, violations);
    checkModifierRevealTimeImports(filePath, content, violations);
    checkSimTierImports(filePath, content, violations);
    checkSharedTierImports(filePath, content, violations);
    checkBattleInteriorImports(filePath, content, violations);
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
  const rel = relative(process.cwd(), file);
  if (!rel.startsWith(RUNTIME_SUBSYSTEMS_DIR)) return;

  const fileDir = relative(process.cwd(), join(file, ".."));
  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx]!;
    const sourceMatch = ln.match(/from\s+"((?:\.\.\/)+[^"]+)"/);
    if (!sourceMatch) continue;
    // Resolve to top-level src/<domain>/ rather than reading the first
    // path segment after `..` — intra-runtime imports like `../audio/x.ts`
    // would otherwise be misread as cross-domain (audio is a runtime
    // sub-cluster, not a domain).
    const resolved = normalize(join(fileDir, sourceMatch[1]!));
    const domainMatch = resolved.match(/^src\/([^/]+)\//);
    if (!domainMatch) continue;
    const domain = domainMatch[1]!;
    if (!ALLOWED_SUBSYSTEM_DOMAINS.has(domain)) {
      violations.push({
        file: rel,
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

function checkRuntimeMutatorImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  if (!rel.startsWith("src/runtime/")) return;

  for (const imp of parseImports(content)) {
    const sourceMatch = imp.source.match(
      /^(?:\.\.?\/)+shared\/core\/([\w-]+)\.ts$/,
    );
    if (!sourceMatch) continue;
    const sourceBase = `${sourceMatch[1]!}.ts`;
    const forbidden = RUNTIME_FORBIDDEN_MUTATORS[sourceBase];
    if (!forbidden) continue;

    const allowedForImporter =
      RUNTIME_MUTATOR_ALLOWLIST[sourceBase]?.[rel] ?? new Set<string>();
    const offenders = imp.names.filter(
      (name) => forbidden.has(name) && !allowedForImporter.has(name),
    );
    if (offenders.length === 0) continue;

    violations.push({
      file: rel,
      line: imp.line,
      message: `Runtime imports game-state mutator(s) from "${imp.source}": ${offenders.join(
        ", ",
      )}. Runtime must go through the game/ barrel (intent + execute) instead of mutating shared/core directly.`,
    });
  }
}

function checkRuntimeHasFeatureCalls(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  if (!rel.startsWith("src/runtime/")) return;

  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx]!;
    // Skip comments — tolerate doc mentions of hasFeature.
    const trimmed = ln.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!/\bhasFeature\s*\(/.test(ln)) continue;
    violations.push({
      file: rel,
      line: idx + 1,
      message:
        "Runtime must not call `hasFeature(` directly — feature gating belongs in the game layer. Ask the game layer to run the gated path (or expose a semantic function) instead.",
    });
  }
}

function checkControllerImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  // Files inside src/controllers/ can freely import each other.
  if (rel.startsWith("src/controllers/")) return;
  if (CONTROLLER_IMPORT_ALLOWLIST.has(rel)) return;

  for (const imp of parseImports(content)) {
    if (!imp.source.includes("/controllers/")) continue;
    violations.push({
      file: rel,
      line: imp.line,
      message: `Import from "${imp.source}" — only composition-root files (${[...CONTROLLER_IMPORT_ALLOWLIST].join(", ")}) may import from src/controllers/. Helpers must receive controller construction via an injected deps bag (see online-host-promotion.ts for the pattern).`,
    });
  }
}

function checkSimTierImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  if (SIM_TIER_ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix)))
    return;

  for (const imp of parseImports(content)) {
    if (!imp.source.includes("/shared/sim/")) continue;
    violations.push({
      file: rel,
      line: imp.line,
      message: `Import from "${imp.source}" — src/shared/sim/ is the simulation-internals tier; only game/ai/controllers/online/runtime (and shared/ itself) may import it. render/input/protocol/entry consume game state through overlays + contracts (shared/ui, system-interfaces), never sim internals.`,
    });
  }
}

function checkSharedTierImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  const tierMatch = rel.match(/^src\/shared\/(core|sim|ui|platform)\//);
  if (!tierMatch) return;
  const tier = tierMatch[1]!;
  const allowed = SHARED_TIER_ALLOWED[tier]!;
  const grandfathered = SHARED_TIER_BASELINE[rel];

  for (const imp of parseImports(content)) {
    // Sibling imports inside shared/ look like `../<tier>/...` (same-tier
    // imports use `./...` and never match). Capture the imported tier.
    const importedMatch = imp.source.match(
      /(?:\.\.\/)+(core|sim|ui|platform)\//,
    );
    if (!importedMatch) continue;
    const importedTier = importedMatch[1]!;
    if (allowed.has(importedTier)) continue;
    if (grandfathered?.has(imp.source)) continue;
    violations.push({
      file: rel,
      line: imp.line,
      message: `Shared-tier inversion: shared/${tier}/ imports shared/${importedTier}/ ("${imp.source}"). The shared/ DAG is platform <- core <- {sim, ui} (sim and ui are disjoint siblings); a lower tier must not depend on a higher one. Fix: extract the shared symbol DOWN to the lower tier (as WALL_DESTROY_ANIM_DURATION moved to game-constants), or relocate the file. See src/shared/README.md's decision tree.`,
    });
  }
}

function checkModifierRevealTimeImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  if (rel === MODIFIER_REVEAL_TIME_IMPORTER) return;

  for (const imp of parseImports(content)) {
    if (
      !imp.source.endsWith("/modifier-reveal-time.ts") &&
      !imp.source.endsWith("/modifier-reveal-time")
    ) {
      continue;
    }
    violations.push({
      file: rel,
      line: imp.line,
      message: `Import from "${imp.source}" — only ${MODIFIER_REVEAL_TIME_IMPORTER} may resolve modifier-reveal timing. Effect code consumes \`revealTimeMs\` already-resolved via the 2D overlay registry or \`overlay.ui.modifierReveal\`.`,
    });
  }
}

function checkBattleInteriorImports(
  file: string,
  content: string,
  violations: Violation[],
): void {
  const rel = relative(process.cwd(), file);
  // The defining file reads player.interior to build the bypass — skip self.
  if (rel === "src/shared/sim/board-occupancy.ts") return;
  if (BATTLE_INTERIOR_ALLOWED_IMPORTERS.has(rel)) return;

  for (const imp of parseImports(content)) {
    if (
      !imp.source.endsWith("/board-occupancy.ts") &&
      !imp.source.endsWith("/board-occupancy")
    ) {
      continue;
    }
    if (imp.names.includes("getBattleInterior")) {
      violations.push({
        file: rel,
        line: imp.line,
        message:
          "Import of `getBattleInterior` — the freshness-assert BYPASS is battle-planner-only (it returns a knowingly-stale interior). Use `getInterior()` (asserts fresh) everywhere else. Add a justified entry to BATTLE_INTERIOR_ALLOWED_IMPORTERS only for new battle-time AI planning.",
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
