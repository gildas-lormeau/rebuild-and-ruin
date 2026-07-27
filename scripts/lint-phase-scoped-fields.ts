/**
 * lint-phase-scoped-fields — three checks guarding the phase-view mechanism.
 * See "Phase views" in CLAUDE.md and the docstrings in
 * `src/shared/core/phase-views.ts` for the why; each check below states what
 * it enforces at its own definition.
 *
 * Usage: deno run -A scripts/lint-phase-scoped-fields.ts   (exit 1 on failure)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface PhaseScopedField {
  /** Field name on GameState / ModernState. */
  readonly field: string;
  /** The phase in which the field carries a meaningful value. */
  readonly phase: string;
  /** Repo-relative paths allowed to name it, each with a stated role. */
  readonly owners: ReadonlyMap<string, string>;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "dev"];
/** Dirs scanned for the speculative-bypass single-caller rule (check 3). Wider
 *  than SCAN_DIRS because the one sanctioned caller lives in `scripts/`. */
const BYPASS_SCAN_DIRS = ["src", "dev", "scripts", "test"];
/** The module that owns the witness and is allowed to cast to a view type. */
const PHASE_VIEWS = "src/shared/core/phase-views.ts";
/** View type names whose casts are confined to PHASE_VIEWS. */
const VIEW_TYPES = ["BuildViewState", "CannonViewState", "BattleViewState"];
/** The assert-free projection bundle, and its one permitted consumer. See the
 *  export's docstring: a second consumer means the underlying planner
 *  over-declares its parameter, not that this list should grow. */
const BYPASS_EXPORT = "SPECULATIVE_VIEWS";
const BYPASS_CALLERS = new Set([
  "scripts/mcp-play/harness.ts",
  PHASE_VIEWS,
  // This script names the export to check for it.
  "scripts/lint-phase-scoped-fields.ts",
]);
const PHASE_SCOPED_FIELDS: readonly PhaseScopedField[] = [
  {
    field: "cannonLimits",
    phase: "CANNON_PLACE",
    owners: new Map([
      ["src/shared/core/types.ts", "declares the field + `cannonSlotsFor`"],
      ["src/shared/core/system-interfaces.ts", "CannonViewState slice"],
      ["src/game/cannon-system.ts", "the writer (computes the limits)"],
      ["src/game/game-init.ts", "initial value"],
      ["src/online/online-serialize.ts", "FULL_STATE (de)serialization"],
      ["src/protocol/protocol.ts", "wire shape"],
    ]),
  },
  {
    field: "battleCountdown",
    phase: "BATTLE",
    owners: new Map([
      ["src/shared/core/types.ts", "declares the field"],
      ["src/shared/core/system-interfaces.ts", "BattleViewState slice"],
      [
        "src/game/battle-system.ts",
        "the writer + announcement-step derivation",
      ],
      [
        "src/game/modifiers/supply-ship.ts",
        "receives it as a parameter, never reads the field",
      ],
      ["src/game/game-init.ts", "initial value"],
      ["src/ai/ai-phase-battle.ts", "battle-only AI gate"],
      ["src/ai/ai-strategy-battle.ts", "battle-only AI gate"],
      ["src/controllers/controller-base.ts", "battle-only fire gate"],
      ["src/runtime/subsystems/phase-ticks.ts", "the BATTLE tick dispatcher"],
      ["src/online/online-serialize.ts", "FULL_STATE (de)serialization"],
      ["src/protocol/protocol.ts", "wire shape"],
    ]),
  },
  {
    field: "salvageSlots",
    phase: "CANNON_PLACE",
    owners: new Map([
      ["src/shared/core/types.ts", "declares the field"],
      ["src/shared/core/system-interfaces.ts", "BattleViewState slice"],
      ["src/game/cannon-system.ts", "consumes + zeroes at cannon-phase start"],
      ["src/game/upgrades/salvage.ts", "the writer (banks a kill)"],
      ["src/game/game-init.ts", "initial value"],
      ["src/ai/ai-strategy-battle.ts", "reads the cap for target scoring"],
      ["src/online/online-serialize.ts", "FULL_STATE (de)serialization"],
      ["src/protocol/protocol.ts", "wire shape"],
    ]),
  },
];
const violations: Violation[] = [];

for (const dir of SCAN_DIRS) {
  scanDir(join(ROOT, dir), checkFile);
}

for (const dir of BYPASS_SCAN_DIRS) {
  scanDir(join(ROOT, dir), checkBypassCaller);
}

report();

function scanDir(dir: string, check: (full: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scanDir(full, check);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    check(full);
  }
}

/** CHECK 3 — the assert-free projection bundle has exactly one consumer. */
function checkBypassCaller(full: string): void {
  const rel = relative(ROOT, full).replaceAll("\\", "/");
  if (BYPASS_CALLERS.has(rel)) return;
  const lines = stripComments(readFileSync(full, "utf-8")).split("\n");
  for (const [idx, line] of lines.entries()) {
    if (!new RegExp(`\\b${BYPASS_EXPORT}\\b`).test(line)) continue;
    violations.push({
      file: rel,
      line: idx + 1,
      reason:
        `uses \`${BYPASS_EXPORT}\`, the assert-free projection bypass. Its one ` +
        `sanctioned caller is scripts/mcp-play/harness.ts, whose observe() has ` +
        `no phase to assert. Needing it a second time means the planner you are ` +
        `calling over-declares its parameter (it only reads geometry) — re-type ` +
        `that parameter instead of widening this allowlist.`,
    });
  }
}

/** CHECK 1 — field-owner allowlist. A few `GameState` fields are only
 *  meaningful during one phase; reading one outside that phase silently yields
 *  the previous round's value. The views make the *slice* unobtainable outside
 *  its phase, but cannot stop a file that already holds the full `GameState`
 *  from reading the field directly — including the owning system itself, in a
 *  code path that runs outside the phase. So each field declares the exact set
 *  of files allowed to name it. A file allowlist, not a heuristic: no
 *  false-positive class to tune, and adding a reader is a deliberate edit here.
 *
 *  CHECK 2 — witness containment. The phantom `__phase` witness only means
 *  something while phase-views.ts is the sole module that can mint one, so
 *  casts to a view type live there and nowhere else. */
function checkFile(full: string): void {
  const rel = relative(ROOT, full).replaceAll("\\", "/");
  const lines = stripComments(readFileSync(full, "utf-8")).split("\n");

  for (const [idx, line] of lines.entries()) {
    for (const scoped of PHASE_SCOPED_FIELDS) {
      if (scoped.owners.has(rel)) continue;
      if (!new RegExp(`\\b${scoped.field}\\b`).test(line)) continue;
      violations.push({
        file: rel,
        line: idx + 1,
        reason:
          `reads \`${scoped.field}\`, which is only meaningful during ` +
          `${scoped.phase}. Take the phase view (\`${viewFor(scoped.phase)}\` ` +
          `from shared/core/phase-views.ts) so the phase is checked, or add ` +
          `this file to the field's owner list in this script with a stated role.`,
      });
    }

    if (rel === PHASE_VIEWS) continue;
    const cast = VIEW_TYPES.find((view) =>
      new RegExp(`\\bas\\s+(unknown\\s+as\\s+)?${view}\\b`).test(line),
    );
    if (cast) {
      violations.push({
        file: rel,
        line: idx + 1,
        reason:
          `casts to \`${cast}\`. Only ${PHASE_VIEWS} may mint the \`__phase\` ` +
          `witness — a cast here bypasses the phase assert the view exists to ` +
          `carry. Call the matching projection instead.`,
      });
    }
    if (
      /\b__phase\b/.test(line) &&
      rel !== "src/shared/core/system-interfaces.ts"
    ) {
      violations.push({
        file: rel,
        line: idx + 1,
        reason:
          "names the `__phase` witness. It is phantom — never present at " +
          "runtime, never read. Declared in system-interfaces.ts, consumed " +
          `only by ${PHASE_VIEWS}.`,
      });
    }
  }
}

/** Blank out comment bodies, preserving newlines so line numbers survive.
 *  Every check here is about what the CODE does; a field named in a docstring
 *  (`see the cannonLimits field`) is documentation, not a read. Without this
 *  the owner allowlist would fill up with "docstring reference only" entries
 *  that grant a file real read permission it never asked for. */
function stripComments(src: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let idx = 0; idx < src.length; idx++) {
    const ch = src[idx]!;
    const next = src[idx + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        idx++;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        idx++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        mode = "string";
        quote = ch;
      }
      out += ch;
      continue;
    }
    if (mode === "string") {
      // Skip the char after a backslash so an escaped quote doesn't end it.
      if (ch === "\\") {
        out += "  ";
        idx++;
        continue;
      }
      if (ch === quote) mode = "code";
      out += ch;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
      continue;
    }
    // block
    if (ch === "*" && next === "/") {
      mode = "code";
      idx++;
      continue;
    }
    if (ch === "\n") out += ch;
  }
  return out;
}

/** Projection helper name for a phase, used in the violation message. */
function viewFor(phase: string): string {
  if (phase === "WALL_BUILD") return "buildView";
  if (phase === "CANNON_PLACE") return "cannonView";
  return "battleView";
}

function report(): never {
  if (violations.length === 0) {
    const fields = PHASE_SCOPED_FIELDS.map((f) => f.field).join(", ");
    console.log(`lint-phase-scoped-fields: ok (${fields})`);
    process.exit(0);
  }
  console.error(
    `lint-phase-scoped-fields: ${violations.length} violation(s)\n`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.reason}\n`);
  }
  process.exit(1);
}
