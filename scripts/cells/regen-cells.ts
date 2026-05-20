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
  /** When set, files in this cell live under `src/<domain>/<subdomain>/`
   *  and form their own role cluster separate from the rest of the domain
   *  at the same layer. See `SUBPATH_PARTITIONS` for which subpaths are
   *  promoted to subdomains. */
  subdomain?: string;
  role: string;
  files: string[];
}

const ROOT = path.resolve(import.meta.dirname!, "..", "..");
const CELLS_PATH = path.join(ROOT, ".import-cells.json");
const DOMINANT_THRESHOLD = 0.7;
/**
 * Per-domain subdirectory names that should be split out into their own
 * cells instead of being lumped into the parent domain at each layer.
 * Useful when one `(domain, layer)` intersection mixes structurally
 * distinct role clusters that share an import depth by coincidence (e.g.
 * `game/modifiers/*` and `game/upgrades/*` both compose the same core
 * types and land together at L6).
 *
 * A file under `src/<domain>/<subpath>/...` where `<subpath>` is in this
 * list gets `subdomain = <subpath>` and a cell key of
 * `<layer>::<domain>/<subpath>`. All other files in the domain stay in
 * the unpartitioned cell with key `<layer>::<domain>`.
 */
const SUBPATH_PARTITIONS: Record<string, readonly string[]> = {
  game: ["modifiers", "upgrades"],
  render: ["3d/effects"],
  runtime: ["audio", "subsystems"],
};
// Role labels keyed by `${layer}::${domain}` (or
// `${layer}::${domain}/${subdomain}` for subpath-partitioned cells, see
// SUBPATH_PARTITIONS above). Cells without an entry here either (a)
// inherit their layer name when the cell monopolizes the layer or
// dominates it (≥70% of files), or (b) hard-error in strict mode to
// force a human decision. See Phase 2 commit for the original labeling
// rationale.
const LABELS: Record<string, string> = {
  // L0 — leaf modules (no intra-project imports)
  "0::ai": "AI tuning data",
  "1::ai": "AI utilities (secondsToTicks, traitLookup)",
  "0::game": "domain barrel",
  "0::input": "input primitives & recorder",
  "0::online": "DOM lookup helpers",
  "0::protocol": "wire route constants",
  "0::render": "render primitives & 3D helpers",
  "0::render/3d/effects": "3D effect infrastructure",
  "0::runtime": "runtime leaf utilities & banner ramps",
  "0::runtime/audio": "audio asset storage",
  "0::server": "wire send helpers",
  "0::shared": "shared constants, RNG & platform leaves",

  // L1 — foundational types
  "1::online": "online wiring config",
  "1::render": "3D sprite scene builders & lights",
  "1::render/3d/effects": "effect terrain pattern textures",
  "1::runtime": "modifier reveal overlays & browser timing",
  "1::runtime/audio": "audio leaf infra (synth loader, sound modal)",
  "1::shared": "shared foundational types & defs",

  // L2 — derived types & local entry
  "2::entry": "boot entry",
  "2::online": "online type definitions",
  "2::protocol": "checkpoint payload types",
  "2::render": "3D camera, debug, sprite scenes & UI theme",
  "2::render/3d/effects": "effect terrain SDF texture",
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
  "6::game":
    "core game systems (combos, game-over, selection, map gen, elevation)",
  "6::game/modifiers": "modifier implementations",
  "6::game/upgrades": "upgrade implementations",
  "6::input": "input-handler deps shapes",
  "6::online": "online lobby UI & session state",
  "6::render": "render contracts & overlay helpers",
  "6::runtime":
    "runtime cores: state, tick context, dialog cores, haptics & overlay registry",
  "6::runtime/audio": "audio players (music + sfx)",
  "6::server": "server game-room",
  "6::shared": "shared action schedule & query helpers",

  // L7 — entity renderers & cross-domain handlers
  "7::ai": "AI strategy + Host interface contracts",
  "7::controllers": "human controller",
  "7::game": "game state setup",
  "7::game/modifiers": "modifier implementations",
  "7::input": "pointer-event dispatch",
  "7::online": "online server lifecycle, remote crosshairs & stores",
  "7::render": "entity renderers",
  "7::render/3d/effects": "effect builders",
  "7::runtime":
    "main loop + runtime contracts + battle-anim & timing translators",
  "7::runtime/subsystems": "subsystem factories",
  "7::server": "server room manager",
  "7::shared": "shared board occupancy",

  // L8 — subsystems
  "8::ai": "AI strategy primitives",
  "8::controllers": "controller factory",
  "8::entry": "server entry",
  "8::game": "core subsystems (castle gen, grunt movement)",
  "8::game/modifiers": "modifier implementations",
  "8::game/upgrades": "upgrade implementation (erosion)",
  "8::input": "input dispatch & touch update",
  "8::online": "online runtime websocket",
  "8::render": "render UI (overlays, screens, settings)",
  "8::render/3d/effects":
    "effect subsystems (burns, dust, supply-ship, modifier-reveal)",
  "8::runtime":
    "runtime subsystems (camera, input, render, lobby, life-lost, options) + lifecycle, castle-build, phase-machine, tick-consumers",

  // L9 — system implementations
  "9::ai": "AI brain assembly + build decision helpers",
  "9::controllers": "AI controller (host wrapper around injected brain)",
  "9::game": "modifier + upgrade systems",
  "9::input": "input device handlers (kb, mouse, touch)",
  "9::online": "online runtime lobby",
  "9::render": "render UI entry",
  "9::render/3d/effects":
    "effect implementations (emergence, collapse, ice, lightning, water surge, wildfire)",
  "9::runtime": "runtime types, main loop, phase machine & subsystems",

  // L10 — mid-depth assembly
  "10::ai": "AI build shared (fallback + small-enclosure check + memoize)",
  "10::controllers": "AI assisted-human controller variant",
  "10::game": "battle impact systems",
  "10::online": "online phase transitions",
  "10::render": "map renderer",
  "10::render/3d/effects": "modifier-effect registry",
  "10::runtime": "runtime tick consumers & lifecycle integration",

  // L11 — system composition
  "11::ai": "AI build strategy",
  "11::game": "grunt system",
  "11::render": "frame renderers",

  // L12 — phase orchestration
  "12::ai": "AI strategy orchestrator",
  "12::game": "battle & build system orchestration",
  "12::render": "3D renderer entry",

  // L13 — wiring
  "13::ai": "default AI bundle (strategy + brain assembly entrypoint)",
  "13::game": "game actions, phase setup & scheduling",
  "13::online": "online server-event handlers",
  "13::runtime": "runtime composition",

  // L14 — composition roots
  "14::controllers": "AI controller wrapper",
  "14::entry": "local-game entry",
  "14::game": "phase entry helpers",
  "14::online": "online state serialization",

  // L15 — online session lifecycle
  "15::controllers": "AI-assisted human controller",
  "15::online": "online runtime transitions",

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
    const subdomain = exceptions[file]
      ? undefined
      : inferSubdomain(file, domain);
    const key = cellKey(layer, domain, subdomain);
    if (!cellMap.has(key)) {
      // Insertion order is preserved by JSON.stringify; subdomain
      // appears between domain and role when present.
      const cell: Cell =
        subdomain !== undefined
          ? { layer, domain, subdomain, role: "", files: [] }
          : { layer, domain, role: "", files: [] };
      cellMap.set(key, cell);
    }
    cellMap.get(key)!.files.push(file);
  }

  for (const cell of cellMap.values()) cell.files.sort();

  return [...cellMap.values()].sort((leftCell, rightCell) => {
    if (leftCell.layer !== rightCell.layer)
      return leftCell.layer - rightCell.layer;
    if (leftCell.domain !== rightCell.domain)
      return leftCell.domain.localeCompare(rightCell.domain);
    // Unpartitioned (core) cell sorts before its subpath siblings.
    return (leftCell.subdomain ?? "").localeCompare(rightCell.subdomain ?? "");
  });
}

function applyLabels(cells: Cell[], newCells: string[]): void {
  for (const cell of cells) {
    const key = cellKey(cell.layer, cell.domain, cell.subdomain);
    const override = LABELS[key];
    if (override !== undefined) {
      cell.role = override;
      continue;
    }
    const displayDomain =
      cell.subdomain !== undefined
        ? `${cell.domain}/${cell.subdomain}`
        : cell.domain;
    cell.role = `TODO: L${cell.layer} · ${displayDomain}`;
    newCells.push(key);
  }
}

function cellKey(
  layer: number,
  domain: string,
  subdomain: string | undefined,
): string {
  return subdomain !== undefined
    ? `${layer}::${domain}/${subdomain}`
    : `${layer}::${domain}`;
}

/**
 * Promote a file's directory to a subdomain when its parent domain
 * declares the directory in `SUBPATH_PARTITIONS`. Partition keys may
 * span multiple path segments (e.g. `"3d/effects"`); longest match
 * wins so a deeper partition shadows a shallower one if both are
 * declared. Returns `undefined` for files that stay in the
 * unpartitioned domain cell.
 */
function inferSubdomain(file: string, domain: string): string | undefined {
  const partitions = SUBPATH_PARTITIONS[domain];
  if (!partitions) return undefined;
  const prefix = `src/${domain}/`;
  if (!file.startsWith(prefix)) return undefined;
  const remainder = file.slice(prefix.length);
  const sorted = [...partitions].sort(
    (leftSubpath, rightSubpath) => rightSubpath.length - leftSubpath.length,
  );
  for (const partition of sorted) {
    if (remainder.startsWith(`${partition}/`)) return partition;
  }
  return undefined;
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
