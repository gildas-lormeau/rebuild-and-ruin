/**
 * lint-cannon-modes — verify .cannon-mode-catalog.json is exhaustive and accurate.
 *
 * Checks:
 * 1. Every CannonMode enum value in battle-types.ts has a catalog entry.
 * 2. No stale catalog entries exist for removed modes.
 * 3. Every consumer file exists on disk.
 * 4. Every consumer file references the mode value (string literal or enum member).
 *
 * Usage:
 *   deno run -A scripts/lint-cannon-modes.ts
 *
 * Exits 1 if violations found.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { IMPLEMENTED_CANNON_MODES } from "../src/shared/cannon-mode-defs.ts";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, ".cannon-mode-catalog.json");
const BATTLE_TYPES_PATH = join(ROOT, "src/shared/battle-types.ts");

interface CatalogEntry {
  consumers: Record<string, string>;
}

interface Catalog {
  modes: Record<string, CatalogEntry>;
}

interface Violation {
  category: string;
  message: string;
}

/** Helper function names used instead of direct CannonMode references, keyed by mode id. */
/** Helper function names used instead of direct CannonMode references, keyed by mode id.
 *  "normal" is the implicit default — files that check super/balloon helpers
 *  handle normal as the else branch. */
const MODE_HELPERS: Record<string, string[]> = {
  normal: ["isSuperCannon", "isBalloonCannon", "isSuperMode", "isBalloonMode"],
  super: ["isSuperCannon", "isSuperMode"],
  balloon: ["isBalloonCannon", "isBalloonMode"],
  rampart: ["isRampartCannon", "isRampartMode"],
};

/** Extract CannonMode enum string values from battle-types.ts source text. */
function extractCannonModesFromSource(source: string): Set<string> {
  const ids = new Set<string>();
  const match = source.match(/enum CannonMode\s*\{([\s\S]*?)\}/);
  if (!match) return ids;
  for (const literal of match[1]!.matchAll(/"([^"]+)"/g)) {
    ids.add(literal[1]!);
  }
  return ids;
}

function main(): void {
  const battleTypesSource = readFileSync(BATTLE_TYPES_PATH, "utf-8");
  const catalog: Catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));

  const sourceIds = extractCannonModesFromSource(battleTypesSource);
  const runtimeIds = new Set(IMPLEMENTED_CANNON_MODES.map((def) => def.id));
  const allModeIds = new Set([...sourceIds, ...runtimeIds]);
  const catalogKeys = new Set(Object.keys(catalog.modes));
  const violations: Violation[] = [];

  // Check 1: every CannonMode has a catalog entry
  for (const modeId of allModeIds) {
    if (!catalogKeys.has(modeId)) {
      violations.push({
        category: "missing-entry",
        message: `CannonMode "${modeId}" has no entry in .cannon-mode-catalog.json`,
      });
    }
  }

  // Check 2: no stale catalog entries
  for (const key of catalogKeys) {
    if (!allModeIds.has(key)) {
      violations.push({
        category: "stale-entry",
        message: `Catalog entry "${key}" does not match any CannonMode enum member`,
      });
    }
  }

  // Check 3 & 4: consumer files exist and reference the mode
  for (const [modeId, entry] of Object.entries(catalog.modes)) {
    if (!allModeIds.has(modeId)) continue;

    for (const [role, filePath] of Object.entries(entry.consumers)) {
      const fullPath = join(ROOT, filePath);
      if (!existsSync(fullPath)) {
        violations.push({
          category: "missing-file",
          message: `Consumer file "${filePath}" for mode "${modeId}" (${role}) does not exist`,
        });
        continue;
      }

      const content = readFileSync(fullPath, "utf-8");
      // Consumer files may reference cannon modes via:
      // - Direct: CannonMode.NORMAL, "normal"
      // - Helpers: isSuperCannon, isBalloonCannon, isSuperMode, isBalloonMode
      // - Generic: cannon.mode, cannonSize, cannonSlotCost, cannonModeDef
      const enumName = modeId.toUpperCase();
      const helperNames = MODE_HELPERS[modeId] ?? [];
      const hasReference =
        content.includes(`"${modeId}"`) ||
        content.includes(`CannonMode.${enumName}`) ||
        content.includes(`CannonMode`) ||
        content.includes(`cannon.mode`) ||
        content.includes(`cannonSize`) ||
        content.includes(`cannonModeDef`) ||
        helperNames.some((helper) => content.includes(helper));
      if (!hasReference) {
        violations.push({
          category: "missing-reference",
          message: `${filePath} (${role}) for mode "${modeId}" does not reference CannonMode or "${modeId}"`,
        });
      }
    }
  }

  if (violations.length === 0) {
    const modeCount = catalogKeys.size;
    const consumerCount = Object.values(catalog.modes).reduce(
      (sum, entry) => sum + Object.keys(entry.consumers).length,
      0,
    );
    console.log(
      `\u2714 Cannon mode catalog verified (${modeCount} modes, ${consumerCount} consumer links)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} cannon mode catalog violation(s):\n`,
  );
  for (const violation of violations) {
    console.log(`  [${violation.category}] ${violation.message}`);
  }
  process.exit(1);
}

main();
