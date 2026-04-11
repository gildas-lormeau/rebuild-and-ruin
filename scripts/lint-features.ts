/**
 * lint-features — verify .feature-catalog.json is exhaustive and accurate.
 *
 * Checks:
 * 1. Every member of the FeatureId union in src/shared/feature-defs.ts
 *    has an entry in the catalog.
 * 2. Every catalog entry's feature id has a matching FeatureDef in the pool
 *    (via featureDef() lookup — compile-time exhaustiveness covers the pool,
 *    this check covers the catalog).
 * 3. Every "gate:*" consumer file actually contains a hasFeature() call
 *    with the correct feature id string.
 * 4. Every consumer file in the catalog exists on disk.
 * 5. No catalog entries reference features that don't exist in feature-defs.ts.
 *
 * Usage:
 *   deno run -A scripts/lint-features.ts
 *
 * Exits 1 if violations found.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  featureDef,
  type FeatureId,
  IMPLEMENTED_FEATURES,
} from "../src/shared/core/feature-defs.ts";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, ".feature-catalog.json");
const FEATURE_DEFS_PATH = join(ROOT, "src/shared/core/feature-defs.ts");

interface CatalogFeature {
  consumers: Record<string, string>;
}

interface Catalog {
  features: Record<string, CatalogFeature>;
}

interface Violation {
  category: string;
  message: string;
}

/** Extract FeatureId union members from feature-defs.ts source text.
 *  Belt-and-suspenders: the runtime IMPLEMENTED_FEATURES array is authoritative,
 *  but we also parse the type union to catch unimplemented ids that only exist
 *  in the type system. */
function extractFeatureIdsFromSource(source: string): Set<string> {
  const ids = new Set<string>();
  const match = source.match(/export type FeatureId\s*=\s*([\s\S]*?);/);
  if (!match) return ids;
  for (const literal of match[1]!.matchAll(/"([^"]+)"/g)) {
    ids.add(literal[1]!);
  }
  return ids;
}

function main(): void {
  const featureDefsSource = readFileSync(FEATURE_DEFS_PATH, "utf-8");
  const catalog: Catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));

  // Combine type-level ids (from source parsing) with runtime ids (from pool)
  const sourceIds = extractFeatureIdsFromSource(featureDefsSource);
  const runtimeIds = new Set(IMPLEMENTED_FEATURES.map((def) => def.id));
  const allFeatureIds = new Set([...sourceIds, ...runtimeIds]);
  const catalogKeys = new Set(Object.keys(catalog.features));
  const violations: Violation[] = [];

  // Check 1: every FeatureId has a catalog entry
  for (const featureId of allFeatureIds) {
    if (!catalogKeys.has(featureId)) {
      violations.push({
        category: "missing-entry",
        message: `FeatureId "${featureId}" has no entry in .feature-catalog.json`,
      });
    }
  }

  // Check 2: no catalog entries for non-existent features
  for (const key of catalogKeys) {
    if (!allFeatureIds.has(key)) {
      violations.push({
        category: "stale-entry",
        message: `Catalog entry "${key}" does not match any FeatureId union member`,
      });
    }
  }

  // Check 3: validate catalog entries against pool definitions
  for (const featureId of catalogKeys) {
    if (!allFeatureIds.has(featureId)) continue;
    // featureDef() lookup verifies the catalog id resolves to a real pool entry
    const def = featureDef(featureId as FeatureId);
    if (!def) {
      violations.push({
        category: "pool-mismatch",
        message: `Catalog feature "${featureId}" has no matching FeatureDef in FEATURE_POOL`,
      });
    }
  }

  // Check 4: consumer files exist and gate consumers reference hasFeature
  for (const [featureId, entry] of Object.entries(catalog.features)) {
    for (const [role, filePath] of Object.entries(entry.consumers)) {
      const fullPath = join(ROOT, filePath);

      // Verify file exists
      if (!existsSync(fullPath)) {
        violations.push({
          category: "missing-file",
          message: `Consumer file "${filePath}" for feature "${featureId}" (${role}) does not exist`,
        });
        continue;
      }

      // For gate roles, verify hasFeature() call with correct feature id.
      // Matches both string literals (hasFeature(state, "modifiers")) and
      // named constants (hasFeature(state, FID.MODIFIERS)).
      if (role.startsWith("gate:")) {
        const content = readFileSync(fullPath, "utf-8");
        const fidKey = featureId.toUpperCase();
        const hasCall =
          content.includes(`hasFeature(state, "${featureId}")`) ||
          content.includes(`hasFeature(deps.state, "${featureId}")`) ||
          content.includes(`hasFeature(state, FID.${fidKey})`) ||
          content.includes(`hasFeature(deps.state, FID.${fidKey})`);
        if (!hasCall) {
          violations.push({
            category: "missing-guard",
            message: `${filePath} is declared as "${role}" for feature "${featureId}" but has no hasFeature(*, "${featureId}") or hasFeature(*, FID.${fidKey}) call`,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    const featureCount = catalogKeys.size;
    const consumerCount = Object.values(catalog.features).reduce(
      (sum, feat) => sum + Object.keys(feat.consumers).length,
      0,
    );
    console.log(
      `✔ Feature catalog verified (${featureCount} features, ${consumerCount} consumer links)`,
    );
    process.exit(0);
  }

  console.log(
    `✘ ${violations.length} feature catalog violation(s):\n`,
  );
  for (const violation of violations) {
    console.log(`  [${violation.category}] ${violation.message}`);
  }
  process.exit(1);
}

main();
