/**
 * lint-registries — verify consumer files referenced by every content
 * registry actually exist on disk.
 *
 * Replaces lint-features.ts, lint-modifiers.ts, lint-cannon-modes.ts,
 * lint-battle-events.ts. The 4 separate scripts had ~80% duplicated logic
 * (load pool → load catalog JSON → exhaustiveness → file existence →
 * string-presence checks). After moving the catalog data into typed
 * `*_CONSUMERS` const objects in src/shared/core/*-defs.ts (and
 * battle-events.ts), exhaustiveness is enforced at compile time by
 * `satisfies Record<Id, ...>` clauses, so this script only has to do
 * one thing: confirm every listed file path exists.
 *
 * Role-based string-presence checks (e.g. "the gate consumer must contain
 * a hasFeature() call") were intentionally dropped — TypeScript +
 * scenario/determinism tests catch the same class of bug, and the
 * string-match heuristics produced false positives whenever consumer
 * files were renamed.
 *
 * Usage:
 *   deno run -A scripts/lint-registries.ts
 *
 * Exits 1 if any consumer file path is missing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ONLINE_PHASE_TICKS_CONSUMERS } from "../src/runtime/runtime-types.ts";
import { BATTLE_EVENT_CONSUMERS } from "../src/shared/core/battle-events.ts";
import { CANNON_MODE_CONSUMERS } from "../src/shared/core/cannon-mode-defs.ts";
import { FEATURE_CONSUMERS } from "../src/shared/core/feature-defs.ts";
import { MODIFIER_CONSUMERS } from "../src/shared/core/modifier-defs.ts";

interface RegistryInput {
  readonly name: string;
  readonly consumers: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

interface Violation {
  readonly registry: string;
  readonly entryId: string;
  readonly role: string;
  readonly path: string;
}

const ROOT = process.cwd();
const REGISTRIES: readonly RegistryInput[] = [
  { name: "feature", consumers: FEATURE_CONSUMERS },
  { name: "modifier", consumers: MODIFIER_CONSUMERS },
  { name: "cannon-mode", consumers: CANNON_MODE_CONSUMERS },
  { name: "battle-event", consumers: BATTLE_EVENT_CONSUMERS },
  { name: "online-phase-ticks", consumers: ONLINE_PHASE_TICKS_CONSUMERS },
];

main();

function main(): void {
  const violations: Violation[] = [];
  let totalEntries = 0;
  let totalConsumers = 0;

  for (const registry of REGISTRIES) {
    for (const [entryId, roles] of Object.entries(registry.consumers)) {
      totalEntries++;
      for (const [role, filePath] of Object.entries(roles)) {
        totalConsumers++;
        if (!existsSync(join(ROOT, filePath))) {
          violations.push({
            registry: registry.name,
            entryId,
            role,
            path: filePath,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `✔ Registry consumers verified (${REGISTRIES.length} registries, ${totalEntries} entries, ${totalConsumers} consumer links)`,
    );
    process.exit(0);
  }

  console.log(`✘ ${violations.length} registry consumer violation(s):\n`);
  for (const v of violations) {
    console.log(
      `  [${v.registry}] ${v.entryId} (${v.role}) → "${v.path}" does not exist`,
    );
  }
  process.exit(1);
}
