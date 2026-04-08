/**
 * lint-battle-events — verify .battle-event-catalog.json is exhaustive and accurate.
 *
 * Checks:
 * 1. Every member of the BattleEvent / ImpactEvent union in src/shared/battle-events.ts
 *    has an entry in the catalog.
 * 2. Every consumer file declared in the catalog actually references the
 *    BATTLE_MESSAGE constant for that event (grep for BATTLE_MESSAGE.KEY_NAME or MESSAGE.KEY_NAME).
 * 3. No catalog entries reference events that don't exist in battle-events.ts.
 *
 * Usage:
 *   deno run -A scripts/lint-battle-events.ts
 *
 * Exits 1 if violations found.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, ".battle-event-catalog.json");
const PROTOCOL_PATH = join(ROOT, "src/shared/battle-events.ts");

interface CatalogEvent {
  messageKey: string;
  union: string;
  consumers: Record<string, string>;
}

interface Catalog {
  events: Record<string, CatalogEvent>;
}

interface Violation {
  category: string;
  message: string;
}

// ── Parse protocol.ts for union members ──────────────────────────

/** Extract message keys from the BattleEvent and ImpactEvent union types. */
function extractUnionMembers(source: string): {
  battleKeys: Set<string>;
  impactKeys: Set<string>;
} {
  const battleKeys = new Set<string>();
  const impactKeys = new Set<string>();

  // Find MESSAGE constant keys by matching the MESSAGE object definition.
  // Map: lowercase type string → MESSAGE key name
  const messageMap = new Map<string, string>();
  const messageObjMatch = source.match(
    /export const MESSAGE\s*=\s*\{([\s\S]*?)\}\s*as\s*const/,
  );
  if (messageObjMatch) {
    const body = messageObjMatch[1]!;
    for (const match of body.matchAll(
      /(\w+)\s*:\s*"(\w+)"/g,
    )) {
      messageMap.set(match[2]!, match[1]!);
    }
  }

  // Extract ImpactEvent union members (type names ending in Message)
  const impactMatch = source.match(
    /export type ImpactEvent\s*=[\s\S]*?;/,
  );
  if (impactMatch) {
    for (const match of impactMatch[0].matchAll(/(\w+)Message/g)) {
      const typeName = match[1]!;
      // Convert PascalCase to camelCase for the event key
      const camelKey = typeName[0]!.toLowerCase() + typeName.slice(1);
      impactKeys.add(camelKey);
      battleKeys.add(camelKey); // ImpactEvent is a subset of BattleEvent
    }
  }

  // Extract BattleEvent union members (adds fire, tower, aim on top of impact)
  const battleMatch = source.match(
    /export type BattleEvent\s*=[\s\S]*?;/,
  );
  if (battleMatch) {
    for (const match of battleMatch[0].matchAll(/(\w+)Message/g)) {
      const typeName = match[1]!;
      const camelKey = typeName[0]!.toLowerCase() + typeName.slice(1);
      battleKeys.add(camelKey);
    }
  }

  return { battleKeys, impactKeys };
}

// ── Verify consumers reference MESSAGE constants ─────────────────

function consumerReferencesEvent(
  consumerPath: string,
  messageKey: string,
): boolean {
  const fullPath = join(ROOT, consumerPath);
  try {
    const content = readFileSync(fullPath, "utf-8");
    // Check for BATTLE_MESSAGE.KEY_NAME, MESSAGE.KEY_NAME, or the string literal "eventType"
    return (
      content.includes(`BATTLE_MESSAGE.${messageKey}`) ||
      content.includes(`MESSAGE.${messageKey}`) ||
      content.includes(`"${messageKey}"`)
    );
  } catch {
    return false; // File doesn't exist
  }
}

// ── Main ─────────────────────────────────────────────────────────

function main(): void {
  const protocolSource = readFileSync(PROTOCOL_PATH, "utf-8");
  const catalog: Catalog = JSON.parse(
    readFileSync(CATALOG_PATH, "utf-8"),
  );

  const { battleKeys } = extractUnionMembers(protocolSource);
  const catalogKeys = new Set(Object.keys(catalog.events));
  const violations: Violation[] = [];

  // Check 1: every union member has a catalog entry
  for (const key of battleKeys) {
    if (!catalogKeys.has(key)) {
      violations.push({
        category: "missing-entry",
        message: `BattleEvent member "${key}" has no entry in .battle-event-catalog.json`,
      });
    }
  }

  // Check 2: no catalog entries for non-existent events
  for (const key of catalogKeys) {
    if (!battleKeys.has(key)) {
      violations.push({
        category: "stale-entry",
        message: `Catalog entry "${key}" does not match any BattleEvent/ImpactEvent union member`,
      });
    }
  }

  // Check 3: every consumer file references the MESSAGE constant
  for (const [eventKey, eventDef] of Object.entries(catalog.events)) {
    for (const [role, filePath] of Object.entries(eventDef.consumers)) {
      // combo role consumers are called indirectly through stateApply — skip grep check
      if (role === "combo") continue;

      if (!consumerReferencesEvent(filePath, eventDef.messageKey)) {
        violations.push({
          category: "missing-reference",
          message: `${filePath} is declared as "${role}" consumer of "${eventKey}" but does not reference MESSAGE.${eventDef.messageKey}`,
        });
      }
    }
  }

  if (violations.length === 0) {
    const eventCount = catalogKeys.size;
    const consumerCount = Object.values(catalog.events).reduce(
      (sum, ev) => sum + Object.keys(ev.consumers).length,
      0,
    );
    console.log(
      `\u2714 Battle event catalog verified (${eventCount} events, ${consumerCount} consumer links)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} battle event catalog violation(s):\n`,
  );
  for (const violation of violations) {
    console.log(`  [${violation.category}] ${violation.message}`);
  }
  process.exit(1);
}

main();
