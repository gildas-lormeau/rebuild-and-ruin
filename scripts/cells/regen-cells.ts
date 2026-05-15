/**
 * Regenerate `.import-cells.json` from `.import-layers.json` (file →
 * layer) and `.domain-boundaries.json` (file → domain), applying the
 * hand-curated role labels in this file's `LABELS` map.
 *
 * This is the steady-state cell-map regenerator. Run it after
 * `generate-import-layers.ts` (or any time files move between
 * domains). It replaces the Phase 1 + Phase 2 two-step (extract draft,
 * then label) with a single command.
 *
 * Adding a new (layer, domain) cell: extend LABELS. A missing label
 * is a hard error in default mode, and emits a placeholder in
 * `--allow-todo` mode so the agent can land code before settling the
 * label.
 *
 * Usage:
 *   deno run -A scripts/cells/regen-cells.ts               # write
 *   deno run -A scripts/cells/regen-cells.ts --check       # CI: fail if stale
 *   deno run -A scripts/cells/regen-cells.ts --allow-todo  # emit TODOs for new cells
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface LayerGroup {
  name: string;
  files: string[];
}

interface DomainBoundaries {
  allowed: Record<string, string[]>;
  typeOnlyFrom?: Record<string, string[]>;
  /**
   * Per-file overrides for the path → domain heuristic. Use sparingly
   * — only for files whose role doesn't match their location (e.g.
   * `server/server.ts` is the server's entry point, not a regular
   * `server` domain module).
   */
  exceptions?: Record<string, string>;
}

interface Cell {
  layer: number;
  domain: string;
  role: string;
  files: string[];
}

const ROOT = path.resolve(import.meta.dirname!, "..", "..");
const CELLS_PATH = path.join(ROOT, ".import-cells.json");
const DOMINANT_THRESHOLD = 0.7;
// Role labels keyed by `${layer}::${domain}`. Cells without an entry
// here either (a) inherit their layer name when the cell monopolizes
// the layer or dominates it (≥70% of files), or (b) hard-error in
// strict mode to force a human decision. See Phase 2 commit for the
// original labeling rationale.
const LABELS: Record<string, string> = {
  // L0 — leaf modules (no intra-project imports)
  "0::ai": "AI tuning constants",
  "0::game": "domain barrel",
  "0::input": "input primitives & recorder",
  "0::online": "DOM lookup helpers",
  "0::protocol": "wire route constants",
  "0::render": "render primitives & 3D helpers",
  "0::runtime": "runtime leaf utilities & banner ramps",
  "0::server": "wire send helpers",
  "0::shared": "shared constants, RNG & platform leaves",

  // L1 — foundational types
  "1::online": "online config & route table",
  "1::render": "3D sprite scene builders & lights",
  "1::runtime": "modifier reveal overlays & audio leaf infra",
  "1::shared": "shared foundational types & defs",

  // L2 — derived types & local entry
  "2::entry": "boot entry",
  "2::online": "online type definitions",
  "2::protocol": "checkpoint payload types",
  "2::render": "3D camera, debug & terrain primitives",
  "2::runtime": "camera projection math",
  "2::shared": "derived shared types & UI configs",

  // L3 — wire payloads & shared definitions
  "3::online": "presence wire payload",
  "3::shared": "battle wire types & event bus",

  // L4 — core state & adjacent types
  "4::render": "3D entity helpers",
  "4::shared": "core state & adjacent types",

  // L5 — first logic
  "5::protocol": "protocol message dispatch",
  "5::render": "3D instance bucketing",
  "5::runtime": "runtime banner state",
  "5::shared": "first logic — spatial, walls, interior, contracts",

  // L6 — upgrades, modifiers & runtime contracts
  "6::ai": "AI decision intents & build types",
  "6::controllers": "BaseController abstraction",
  "6::game": "modifier & upgrade implementations + core game systems",
  "6::input": "input-handler deps shapes",
  "6::online": "online lobby UI & session state",
  "6::render": "render contracts & overlay helpers",
  "6::runtime": "runtime cores: anim, dialog, audio & overlay registry",
  "6::server": "server game-room",
  "6::shared": "shared action schedule & query helpers",

  // L7 — entity renderers & cross-domain handlers
  "7::ai": "AI strategy + Host interface contracts",
  "7::controllers": "human controller",
  "7::game": "game init, zone recompute & fire modifier",
  "7::input": "pointer-event dispatch",
  "7::online": "online action send, remote crosshairs & stores",
  "7::render": "entity renderers & 3D effect factories",
  "7::runtime": "runtime contracts & battle anim",
  "7::server": "server room manager",
  "7::shared": "shared board occupancy",

  // L8 — subsystems
  "8::ai": "AI strategy primitives",
  "8::controllers": "controller factory",
  "8::entry": "server entry",
  "8::game": "game subsystems (castle gen, grunt move, modifier impls)",
  "8::input": "input dispatch & touch update",
  "8::online": "online runtime websocket",
  "8::render": "3D effect subsystems (cannon, dust, grunt, etc.)",
  "8::runtime": "runtime state, castle-build & browser timing",

  // L9 — system implementations
  "9::ai": "AI build scoring & targeting",
  "9::controllers": "AI controller (host wrapper around injected brain)",
  "9::game": "upgrade system",
  "9::input": "input device handlers (kb, mouse, touch)",
  "9::online": "online runtime lobby",
  "9::render": "3D effect implementations (emergence, collapse, ice)",
  "9::runtime": "runtime types, main loop, phase machine & subsystems",

  // L10 — mid-depth assembly
  "10::ai": "AI build fallback",
  "10::controllers": "AI assisted-human controller variant",
  "10::game": "cannon & wall impact systems",
  "10::online": "online phase transitions",
  "10::render": "modifier effect registry & map renderer",
  "10::runtime": "runtime tick consumers & lifecycle integration",

  // L11 — system composition
  "11::ai": "AI build strategy",
  "11::game": "grunt system",
  "11::render": "3D scene & canvas renderer",

  // L12 — phase orchestration
  "12::ai": "AI strategy orchestrator",
  "12::game": "battle, build & modifier system orchestration",
  "12::render": "3D renderer entry",

  // L13 — wiring
  "13::ai": "AI per-phase strategies",
  "13::game": "game actions, phase setup & scheduling",
  "13::online": "online host promotion & server events",
  "13::runtime": "runtime composition",

  // L14 — composition roots
  "14::controllers": "AI controller wrapper",
  "14::entry": "local-game entry",
  "14::game": "phase entry helpers",
  "14::online": "online state serialization",

  // L15 — online session lifecycle
  "15::controllers": "AI-assisted human controller",
  "15::online": "online runtime promotion",
  "15::runtime": "runtime rehydrate",

  // L16 — online deps wiring
  "16::online": "online deps wiring",

  // L17 — online runtime composition
  "17::online": "online runtime composition",

  // L18 — online client entry
  "18::entry": "online client entry",
};

main();

function main(): void {
  const args = new Set(Deno.args);
  const checkMode = args.has("--check");
  const allowTodo = args.has("--allow-todo");

  const layerGroups: LayerGroup[] = JSON.parse(
    readFileSync(path.join(ROOT, ".import-layers.json"), "utf-8"),
  );
  const domainBoundaries: DomainBoundaries = JSON.parse(
    readFileSync(path.join(ROOT, ".domain-boundaries.json"), "utf-8"),
  );

  const cells = buildCells(layerGroups, domainBoundaries);
  const newCells: string[] = [];
  applyLabels(cells, newCells);

  if (newCells.length > 0 && !allowTodo) {
    console.error(
      `✗ ${newCells.length} new (layer, domain) cell(s) appeared without a LABELS entry:`,
    );
    for (const key of newCells) console.error(`    ${key}`);
    console.error(
      `\n  Add entries to LABELS in scripts/cells/regen-cells.ts, then re-run.`,
    );
    console.error(`  (Pass --allow-todo to emit placeholder labels for now.)`);
    Deno.exit(1);
  }

  const json = `${JSON.stringify(cells, null, 2)}\n`;

  if (checkMode) {
    const existing = readFileSync(CELLS_PATH, "utf-8");
    if (existing === json) {
      console.log(
        `✓ ${path.relative(ROOT, CELLS_PATH)} is up to date (${cells.length} cells)`,
      );
      return;
    }
    console.error(
      `✗ ${path.relative(ROOT, CELLS_PATH)} is stale — run \`deno run -A scripts/cells/regen-cells.ts\` to refresh.`,
    );
    Deno.exit(1);
  }

  writeFileSync(CELLS_PATH, json);
  const todoCount = cells.filter((cell) =>
    cell.role.startsWith("TODO:"),
  ).length;
  console.log(
    `Wrote ${cells.length} cells to ${path.relative(ROOT, CELLS_PATH)}` +
      (todoCount > 0 ? ` (${todoCount} TODO)` : ""),
  );
}

function buildCells(
  layerGroups: LayerGroup[],
  domainBoundaries: DomainBoundaries,
): Cell[] {
  const fileToLayer = new Map<string, number>();
  for (let layer = 0; layer < layerGroups.length; layer++) {
    for (const file of layerGroups[layer]!.files) fileToLayer.set(file, layer);
  }

  const exceptions = domainBoundaries.exceptions ?? {};
  const cellMap = new Map<string, Cell>();
  for (const [file, layer] of fileToLayer) {
    const domain = exceptions[file] ?? inferDomainFromPath(file);
    if (!domain) {
      throw new Error(
        `${file} is in .import-layers.json but its domain can't be inferred from the path. Add an entry to "exceptions" in .domain-boundaries.json.`,
      );
    }
    const key = `${layer}::${domain}`;
    if (!cellMap.has(key)) {
      cellMap.set(key, {
        layer,
        domain,
        role: "",
        files: [],
      });
    }
    cellMap.get(key)!.files.push(file);
  }

  for (const cell of cellMap.values()) cell.files.sort();

  return [...cellMap.values()].sort((leftCell, rightCell) => {
    if (leftCell.layer !== rightCell.layer)
      return leftCell.layer - rightCell.layer;
    return leftCell.domain.localeCompare(rightCell.domain);
  });
}

function applyLabels(cells: Cell[], newCells: string[]): void {
  for (const cell of cells) {
    const key = `${cell.layer}::${cell.domain}`;
    const override = LABELS[key];
    if (override !== undefined) {
      cell.role = override;
      continue;
    }
    cell.role = `TODO: L${cell.layer} · ${cell.domain}`;
    newCells.push(key);
  }
}

/**
 * Path → domain inference. `src/<X>/...` → X, `src/<file>` (root) →
 * "entry", `server/...` → "server". Returns null for paths that don't
 * fit these conventions. Pre-empted by `exceptions` in
 * `.domain-boundaries.json` for role-overrides (e.g. server/server.ts
 * is declared `entry` even though its path implies `server`).
 */
function inferDomainFromPath(file: string): string | null {
  if (file.startsWith("server/")) return "server";
  if (file.startsWith("src/")) {
    const rest = file.slice(4);
    if (!rest.includes("/")) return "entry";
    return rest.split("/")[0] ?? null;
  }
  return null;
}
