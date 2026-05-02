/**
 * Checkpoint-field completeness lint — catches GameState/ModernState fields
 * that were added to the type but never wired into network serialization.
 *
 * The failure mode this exists to prevent: an LLM (or a human) adds a new
 * field to `GameState` and uses it in a system, but forgets to serialize
 * it. `test:sync` passes because the seed fixture doesn't happen to
 * exercise the new code path; then in prod the watcher silently defaults
 * the field and diverges from the host over time.
 *
 * The check is deliberately narrow: for every top-level field in
 * `GameState` and `ModernState` (parsed from `src/shared/core/types.ts`), the
 * field name must appear textually at least once in
 * `src/online/online-serialize.ts`. If it doesn't, the author has to
 * either serialize the field or add it to the exclusion allowlist below
 * with a one-line reason.
 *
 * Usage:
 *   deno run -A scripts/lint-checkpoint-fields.ts
 *
 * Exits 1 if violations found.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

interface Violation {
  field: string;
  container: string;
  message: string;
}

const TYPES_FILE = join(process.cwd(), "src/shared/core/types.ts");
const SERIALIZE_FILE = join(process.cwd(), "src/online/online-serialize.ts");
/** Fields intentionally NOT synced over the network. Every entry must carry
 *  a one-line reason — this is the decision log for "why does it not need
 *  to be serialized". When adding a new field to GameState, either:
 *    (a) wire it into online-serialize.ts, or
 *    (b) add it here with a reason. */
const GAME_STATE_EXCLUSIONS: Record<string, string> = {
  debugTag:
    "test-only diagnostic label set by test scenarios (HOST/WATCHER/LOCAL) so capture-point traces can attribute interleaved frames to the runtime that produced them — production never sets or reads it",
  bus: "transient — created by createGameEventBus() at game start, not observable state",
  map: "immutable after init (tiles/zones/towers) — sub-fields that mutate (houses, tile overrides) are serialized individually; tile modifier effects go through applyCheckpointModifierTiles",
  activeFeatures:
    "derived from gameMode via setGameMode() — restored automatically when gameMode is applied",
  buildTimer:
    "difficulty-scaled constant set at game start, never mutated — recovered from settings",
  cannonPlaceTimer:
    "difficulty-scaled constant set at game start, never mutated — recovered from settings",
  firstRoundCannons:
    "difficulty-scaled constant set at game start, never mutated — recovered from settings",
  cannonMaxHp:
    "configurable constant set at game start, never mutated — recovered from settings",
  reselectedPlayers:
    "transient flag cleared at cannon-phase setup; reselects are already reflected in the serialized phase + castle state",
  pendingCannonFires:
    "per-peer transient set tracking scheduled-but-not-yet-drained fires for `canFireOwnCannon`; differs across peers during the wire-delay window (only the local peer's own scheduled fires are observed) — never synced",
  pendingCannonSlotCost:
    "per-peer transient counter tracking scheduled-but-not-yet-drained cannon-place slot cost for `isCannonPlacementLegal`; same shape and rationale as `pendingCannonFires` — never synced",
  pendingCannonPlaceDone:
    "per-peer transient marker tracking scheduled-but-not-yet-drained `cannonPlaceDone.add` so the originator's detect loop doesn't re-broadcast `OPPONENT_CANNON_PHASE_DONE` in the SAFETY window; same shape and rationale as `pendingCannonFires` — never synced",
};
/** Modern-state fields that are intentionally not synced over the wire. */
const MODERN_STATE_EXCLUSIONS: Record<string, string> = {
  comboTracker:
    "transient — created at battle start, cleared at battle end; scoring is already reflected in player.score",
  rubbleClearingHeld:
    "purely presentational — captured deterministically by `rubbleClearingImpl.apply` on every peer (same input state → same snapshot), drives the renderer's fade-out via `overlay.battle.rubbleClearingFade` for ~1.1s post-banner-sweep, then cleared at next prepareBattleState. Late-joining watchers may miss the fade animation but gameplay state is unaffected (the entities are already removed)",
};

main();

function main(): void {
  const typesContent = readFileSync(TYPES_FILE, "utf-8");
  const serializeContent = readFileSync(SERIALIZE_FILE, "utf-8");

  const gameStateFields = parseInterfaceFields(typesContent, "GameState");
  const modernStateFields = parseInterfaceFields(typesContent, "ModernState");

  const violations: Violation[] = [
    ...checkContainer(
      serializeContent,
      "GameState",
      gameStateFields,
      GAME_STATE_EXCLUSIONS,
    ),
    ...checkContainer(
      serializeContent,
      "ModernState",
      modernStateFields,
      MODERN_STATE_EXCLUSIONS,
    ),
  ];

  // Sanity check: flag exclusion entries for fields that no longer exist
  // (caught at refactor time so the allowlist doesn't rot).
  const gameStateSet = new Set(gameStateFields);
  const modernStateSet = new Set(modernStateFields);
  for (const field of Object.keys(GAME_STATE_EXCLUSIONS)) {
    if (!gameStateSet.has(field)) {
      violations.push({
        field,
        container: "GameState (exclusion)",
        message: `GAME_STATE_EXCLUSIONS lists "${field}" but the field no longer exists on GameState. Remove the exclusion entry.`,
      });
    }
  }
  for (const field of Object.keys(MODERN_STATE_EXCLUSIONS)) {
    if (!modernStateSet.has(field)) {
      violations.push({
        field,
        container: "ModernState (exclusion)",
        message: `MODERN_STATE_EXCLUSIONS lists "${field}" but the field no longer exists on ModernState. Remove the exclusion entry.`,
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `\u2714 Checkpoint-field completeness OK (${gameStateFields.length} GameState fields, ${modernStateFields.length} ModernState fields)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} checkpoint-field violation(s) found:\n`,
  );
  for (const v of violations) {
    console.log(`  ${v.container}.${v.field}: ${v.message}`);
  }
  process.exit(1);
}

/** Parse an `interface Name { ... }` block and return its top-level field
 *  names. Handles multi-line field definitions and nested braces (e.g. the
 *  ComboTracker anonymous object type inside ModernState). */
function parseInterfaceFields(content: string, name: string): string[] {
  const startRegex = new RegExp(`export interface ${name}\\s*\\{`);
  const startMatch = startRegex.exec(content);
  if (!startMatch) {
    throw new Error(`interface ${name} not found`);
  }

  let depth = 1;
  let idx = startMatch.index + startMatch[0].length;
  const start = idx;
  while (idx < content.length && depth > 0) {
    const char = content[idx]!;
    if (char === "{") depth++;
    else if (char === "}") depth--;
    if (depth === 0) break;
    idx++;
  }
  const body = content.slice(start, idx);

  const fields: string[] = [];
  let nest = 0;
  let buffer = "";
  for (const char of body) {
    if (char === "{") nest++;
    else if (char === "}") nest--;
    if (nest === 0 && (char === ";" || char === "\n")) {
      // Field declarations at top level look like "name: Type" or "readonly name: Type"
      const line = buffer.trim();
      buffer = "";
      if (!line || line.startsWith("//") || line.startsWith("/*")) continue;
      // Strip `readonly` and leading `*` (from JSDoc continuation)
      const cleaned = line.replace(/^\*.*$/, "").replace(/^readonly\s+/, "");
      const colonIdx = cleaned.indexOf(":");
      if (colonIdx <= 0) continue;
      const fieldName = cleaned.slice(0, colonIdx).trim();
      // Skip JSDoc comment lines that slipped through
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*\??$/.test(fieldName)) continue;
      const normalized = fieldName.replace(/\?$/, "");
      fields.push(normalized);
    } else {
      buffer += char;
    }
  }

  return fields;
}

function checkContainer(
  serializeContent: string,
  containerLabel: string,
  fieldList: readonly string[],
  exclusions: Record<string, string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const field of fieldList) {
    if (exclusions[field] !== undefined) continue;
    // Match `.field` after whitespace or `?.` or `.` — catches `state.field`,
    // `state.modern.field`, `state.modern?.field`, destructuring via the
    // helper functions' `state.field` references.
    const pattern = new RegExp(`\\b${field}\\b`);
    if (!pattern.test(serializeContent)) {
      violations.push({
        field,
        container: containerLabel,
        message: `${containerLabel}.${field} is not referenced in online-serialize.ts. Either serialize it in createFullStateMessage/restoreFullStateSnapshot or add it to the exclusion allowlist in lint-checkpoint-fields.ts with a reason.`,
      });
    }
  }
  return violations;
}
