/**
 * Audit type-only edges in the import tree — the class the layer lints can't
 * see. `generate-import-layers.ts` counts `import type` as a real edge (a type
 * dependency is still coupling), so a type can drag a file up a tier without
 * any runtime dependency existing.
 *
 * Two findings, each with its own remedy:
 *
 * A. STRANDED TYPE MODULE — a file whose every export is a type, sitting above
 *    the types tier (L0-L4). CLAUDE.md puts type homes at L1-L4; a pure-type
 *    module at L7+ got dragged up by its own type deps.
 *    **L5-L6 hits are informational, and the L1-L4 remedy does not apply to
 *    them.** Those layers are the floor, not slack: stripping every value from
 *    every module and recomputing over type references alone leaves
 *    `system-interfaces` / `overlay-types` / `build-types` at L5 and
 *    `runtime/types` / `input-deps` / `frame-ctx` at L6 — zero movement. The
 *    ladder below them (`zone-id` L0 -> `geometry-types` L1 -> `battle-events`
 *    L2 -> `battle-types` L3 -> `player-types` L4) is pure type composition, so
 *    any contract naming `Player` starts at L5 by arithmetic. 75 of ~420
 *    exported types have a type-only floor above L4; six reach L8. No
 *    relocation beats that — only splitting the contract does.
 *    FP class: composition return types (`runtime/handle.ts`) and phase-slice
 *    contracts necessarily reference what they compose, so they cannot drop to
 *    L1-L4 without splitting the contract.
 *    NB when re-deriving these floors: `interface X extends Y` is an
 *    ExpressionWithTypeArguments, not a TypeReference. Walking only
 *    TypeReference nodes silently drops every inheritance edge and reports a
 *    uniform one-layer slack that isn't there.
 *
 * B. SIBLING TYPE-BORROW — an `import type` reaching sideways into a
 *    same-directory *implementation* module (one with value exports) for a
 *    type. The type wants extracting to a type home; every borrower is coupled
 *    to a module it has no runtime need for. Reported per target with its
 *    borrower count, since one misplaced interface produces many borrowers.
 *    Depending on a lower contract (GameState from types.ts) is correct
 *    architecture and is NOT reported — only sideways reaches into peers.
 *    FP classes: (1) DI-factory return types — `runtime/subsystems/*` keeping
 *    `RuntimeCamera` beside `createCamera` is the deps-object idiom, not a
 *    misplaced type; (2) type homes that also export a few enums, so they
 *    don't read as pure-type. The signal worth acting on is a *generic*
 *    interface stranded in a heavy implementation module — `EffectManager`
 *    (2 methods) inside `fire-burst.ts`, borrowed by 10 peers.
 *
 * Usage:
 *   deno run -A scripts/audit-type-pins.ts            # both sections
 *   deno run -A scripts/audit-type-pins.ts --stranded # section A only
 *   deno run -A scripts/audit-type-pins.ts --borrow   # section B only
 *   deno run -A scripts/audit-type-pins.ts --min-borrowers=3
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project, type SourceFile, SyntaxKind } from "ts-morph";
import { tierOfLayer } from "./cells/tier-of-layer.ts";
import { buildImportGraph } from "./import-graph.ts";

interface LayerGroup {
  name: string;
  files: string[];
}

interface StrandedFinding {
  file: string;
  layer: number;
  tier: string;
  pins: string[];
}

interface BorrowFinding {
  target: string;
  targetLayer: number;
  types: string[];
  borrowers: string[];
}

/** Highest layer still inside the `types` tier — see cells/tier-of-layer.ts. */
const TYPES_TIER_MAX = 4;
const ROOT = path.resolve(import.meta.dirname!, "..");

main();

function main(): void {
  const args = process.argv.slice(2);
  const onlyStranded = args.includes("--stranded");
  const onlyBorrow = args.includes("--borrow");
  const minBorrowers = Number(
    args.find((arg) => arg.startsWith("--min-borrowers="))?.split("=")[1] ?? 1,
  );

  const layerGroups: LayerGroup[] = JSON.parse(
    readFileSync(path.join(ROOT, ".import-layers.json"), "utf-8"),
  );
  const fileToLayer = new Map<string, number>();
  for (let layer = 0; layer < layerGroups.length; layer++) {
    for (const file of layerGroups[layer]!.files) fileToLayer.set(file, layer);
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of fileToLayer.keys()) {
    try {
      project.addSourceFileAtPath(path.join(ROOT, file));
    } catch {
      // Not on disk (generated or renamed) — layer data is stale, skip.
    }
  }

  const pureTypeCache = new Map<string, boolean>();
  const isPureType = (file: string): boolean => {
    const cached = pureTypeCache.get(file);
    if (cached !== undefined) return cached;
    const sf = project.getSourceFile(path.join(ROOT, file));
    const result = sf !== undefined && isPureTypeModule(sf);
    pureTypeCache.set(file, result);
    return result;
  };

  const stranded: StrandedFinding[] = [];
  const borrowsByTarget = new Map<string, BorrowFinding>();
  const graph = buildImportGraph(project, new Set(fileToLayer.keys()), ROOT);

  for (const [file, layer] of fileToLayer) {
    const deps = graph
      .edgesFrom(file)
      .map((edge) => ({ ...edge, layer: fileToLayer.get(edge.to) ?? 0 }));
    if (deps.length === 0) continue;

    if (isPureType(file) && layer > TYPES_TIER_MAX) {
      const maxLayer = Math.max(...deps.map((dep) => dep.layer));
      stranded.push({
        file,
        layer,
        tier: tierOfLayer(layer),
        pins: deps
          .filter((dep) => dep.layer === maxLayer)
          .map((dep) => `${dep.to} (L${dep.layer})`),
      });
    }

    for (const dep of deps) {
      if (!dep.typeOnly) continue;
      // Reached through a barrel, not named directly. The deep-import
      // allowlist *mandates* going through `game/index.ts`, so the borrower
      // has no misplaced-type decision to make.
      if (dep.via !== undefined) continue;
      if (path.dirname(dep.to) !== path.dirname(file)) continue;
      if (isPureType(dep.to)) continue;
      // Target layer is the discriminator. A leaf/type-home module that also
      // exports values (`grid.ts` exporting Tile + TILE_SIZE, `player-slot.ts`
      // exporting ValidPlayerId) is a legitimate place to take a type from.
      // Reaching into a module that itself sits in the logic tier or above
      // means the type is riding on an implementation.
      if (dep.layer <= TYPES_TIER_MAX) continue;
      const existing = borrowsByTarget.get(dep.to);
      const entry = existing ?? {
        target: dep.to,
        targetLayer: dep.layer,
        types: [],
        borrowers: [],
      };
      entry.borrowers.push(file);
      for (const name of dep.names) {
        if (!entry.types.includes(name)) entry.types.push(name);
      }
      borrowsByTarget.set(dep.to, entry);
    }
  }

  stranded.sort((left, right) => right.layer - left.layer);
  const borrows = [...borrowsByTarget.values()]
    .filter((entry) => entry.borrowers.length >= minBorrowers)
    .sort((left, right) => right.borrowers.length - left.borrowers.length);

  if (!onlyBorrow) reportStranded(stranded);
  if (!onlyStranded) reportBorrows(borrows);
}

/** True when every exported declaration is a type (no runtime value). */
function isPureTypeModule(sf: SourceFile): boolean {
  let sawType = false;
  for (const [, decls] of sf.getExportedDeclarations()) {
    for (const decl of decls) {
      const kind = decl.getKind();
      if (
        kind !== SyntaxKind.InterfaceDeclaration &&
        kind !== SyntaxKind.TypeAliasDeclaration
      ) {
        return false;
      }
      sawType = true;
    }
  }
  return sawType;
}

function reportStranded(findings: StrandedFinding[]): void {
  const above = findings.filter((row) => tierOfLayer(row.layer) !== "logic");
  console.log(
    `\n=== A. Stranded type modules above L${TYPES_TIER_MAX} (${findings.length}, ` +
      `${above.length} beyond the logic tier) ===\n`,
  );
  if (findings.length === 0) {
    console.log("  none\n");
    return;
  }
  for (const row of findings) {
    console.log(`${row.file}  L${row.layer} [${row.tier}]`);
    for (const pin of row.pins) console.log(`    pinned by: ${pin}`);
  }
  console.log(
    `\n  Remedy (L7+ only): relocate the pinning type so the module drops.` +
      `\n  L5-L6 rows are the type-only floor, not slack — nothing to relocate,` +
      `\n  they are listed for context. Composition/return-type contracts are` +
      `\n  expected FPs even above L6 — see header.\n`,
  );
}

function reportBorrows(findings: BorrowFinding[]): void {
  const total = findings.reduce((sum, row) => sum + row.borrowers.length, 0);
  console.log(
    `=== B. Sibling type-borrows (${findings.length} target(s), ${total} borrower(s)) ===\n`,
  );
  if (findings.length === 0) {
    console.log("  none\n");
    return;
  }
  for (const row of findings) {
    console.log(
      `${row.target}  L${row.targetLayer}  ← ${row.borrowers.length} borrower(s)`,
    );
    console.log(`    types: ${row.types.join(", ")}`);
    for (const borrower of row.borrowers) console.log(`      ${borrower}`);
  }
  console.log(
    `\n  Remedy: move the borrowed type(s) into a type home so borrowers stop` +
      `\n  depending on an implementation module they have no runtime need for.\n`,
  );
}
