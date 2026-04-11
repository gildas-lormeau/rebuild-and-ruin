/**
 * lint-modifiers — verify .modifier-catalog.json is exhaustive and accurate.
 *
 * Checks:
 * 1. Every ModifierId in game-constants.ts has a catalog entry.
 * 2. No stale catalog entries exist for removed modifiers.
 * 3. Every modifier with needsCheckpoint: true in the pool has
 *    checkpoint, serialize, and stateField declared in the catalog.
 * 4. Every consumer file exists and references the modifier's
 *    stateField (for checkpoint/serialize/zoneReset/reapply roles).
 * 5. Every dispatch consumer references the modifier's MODIFIER_ID constant.
 *
 * Usage:
 *   deno run -A scripts/lint-modifiers.ts
 *
 * Exits 1 if violations found.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  IMPLEMENTED_MODIFIERS,
  modifierDef,
} from "../src/shared/core/modifier-defs.ts";
import type { ModifierId } from "../src/shared/core/game-constants.ts";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, ".modifier-catalog.json");
const CONSTANTS_PATH = join(ROOT, "src/shared/core/game-constants.ts");

interface CatalogEntry {
  stateField?: string;
  consumers: Record<string, string>;
}

interface Catalog {
  modifiers: Record<string, CatalogEntry>;
}

interface Violation {
  category: string;
  message: string;
}

/** Extract ModifierId union members from game-constants.ts source text. */
function extractModifierIdsFromSource(source: string): Set<string> {
  const ids = new Set<string>();
  const match = source.match(/export type ModifierId\s*=\s*([\s\S]*?);/);
  if (!match) return ids;
  for (const literal of match[1]!.matchAll(/"([^"]+)"/g)) {
    ids.add(literal[1]!);
  }
  return ids;
}

/** Roles that require stateField to be present in the consumer file. */
const STATE_FIELD_ROLES = new Set([
  "serialize",
  "checkpoint",
  "zoneReset",
  "reapply",
]);

/** Required consumer roles for needsCheckpoint modifiers. */
const CHECKPOINT_REQUIRED_ROLES = ["checkpoint", "serialize"];

function main(): void {
  const constantsSource = readFileSync(CONSTANTS_PATH, "utf-8");
  const catalog: Catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));

  const sourceIds = extractModifierIdsFromSource(constantsSource);
  const runtimeIds = new Set(IMPLEMENTED_MODIFIERS.map((def) => def.id));
  const allModifierIds = new Set([...sourceIds, ...runtimeIds]);
  const catalogKeys = new Set(Object.keys(catalog.modifiers));
  const violations: Violation[] = [];

  // Check 1: every ModifierId has a catalog entry
  for (const modId of allModifierIds) {
    if (!catalogKeys.has(modId)) {
      violations.push({
        category: "missing-entry",
        message: `ModifierId "${modId}" has no entry in .modifier-catalog.json`,
      });
    }
  }

  // Check 2: no stale catalog entries
  for (const key of catalogKeys) {
    if (!allModifierIds.has(key)) {
      violations.push({
        category: "stale-entry",
        message: `Catalog entry "${key}" does not match any ModifierId union member`,
      });
    }
  }

  // Check 3: needsCheckpoint modifiers must declare required roles + stateField
  for (const modId of allModifierIds) {
    if (!catalogKeys.has(modId)) continue;
    const def = modifierDef(modId as ModifierId);
    if (!def?.needsCheckpoint) continue;

    const entry = catalog.modifiers[modId]!;
    if (!entry.stateField) {
      violations.push({
        category: "missing-stateField",
        message: `Modifier "${modId}" has needsCheckpoint but no stateField in catalog`,
      });
    }
    for (const role of CHECKPOINT_REQUIRED_ROLES) {
      if (!entry.consumers[role]) {
        violations.push({
          category: "missing-checkpoint-role",
          message: `Modifier "${modId}" has needsCheckpoint but no "${role}" consumer in catalog`,
        });
      }
    }
  }

  // Check 4: consumer files exist and reference the correct identifiers
  for (const [modId, entry] of Object.entries(catalog.modifiers)) {
    if (!allModifierIds.has(modId)) continue;

    for (const [role, filePath] of Object.entries(entry.consumers)) {
      const fullPath = join(ROOT, filePath);
      if (!existsSync(fullPath)) {
        violations.push({
          category: "missing-file",
          message: `Consumer file "${filePath}" for modifier "${modId}" (${role}) does not exist`,
        });
        continue;
      }

      const content = readFileSync(fullPath, "utf-8");

      // For state-field roles, verify the file references the state field
      if (STATE_FIELD_ROLES.has(role) && entry.stateField) {
        if (!content.includes(entry.stateField)) {
          violations.push({
            category: "missing-reference",
            message: `${filePath} (${role}) for modifier "${modId}" does not reference "${entry.stateField}"`,
          });
        }
      }

      // For dispatch role, verify MODIFIER_ID.XXX reference
      if (role === "dispatch") {
        const constName = modId.toUpperCase();
        if (
          !content.includes(`MODIFIER_ID.${constName}`) &&
          !content.includes(`"${modId}"`)
        ) {
          violations.push({
            category: "missing-reference",
            message: `${filePath} (dispatch) for modifier "${modId}" does not reference MODIFIER_ID.${constName}`,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    const modCount = catalogKeys.size;
    const consumerCount = Object.values(catalog.modifiers).reduce(
      (sum, entry) => sum + Object.keys(entry.consumers).length,
      0,
    );
    console.log(
      `\u2714 Modifier catalog verified (${modCount} modifiers, ${consumerCount} consumer links)`,
    );
    process.exit(0);
  }

  console.log(`\u2718 ${violations.length} modifier catalog violation(s):\n`);
  for (const violation of violations) {
    console.log(`  [${violation.category}] ${violation.message}`);
  }
  process.exit(1);
}

main();
