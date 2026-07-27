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
 * Three checks keep the labels honest, because a stale label is worse
 * than a missing one — `cell-lookup.ts` sends you confidently to the
 * wrong cell:
 *   - orphan LABELS keys (a label matching no cell — the signature of a
 *     cell shifting layer and leaving its label pinned to the old index)
 *   - duplicate role strings (two cells sharing a role make lookup
 *     ambiguous)
 *   - label drift (a cell's file list changed while its role stayed
 *     byte-identical — nobody re-read whether the label still fits)
 *
 * Usage:
 *   deno run -A scripts/cells/regen-cells.ts                  # write
 *   deno run -A scripts/cells/regen-cells.ts --check          # CI: fail if stale
 *   deno run -A scripts/cells/regen-cells.ts --allow-todo     # emit TODOs for new cells
 *   deno run -A scripts/cells/regen-cells.ts --accept-labels  # membership changed, label still fits
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
  shared: ["sim"],
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
  "1::ai": "AI utilities (secondsToTicks, traitLookup) + personality roll",
  "2::ai": "AI build/battle diagnostic hooks & deterministic upgrade fallback",
  "0::game": "domain barrel & dependency-free leaves",
  "0::input": "tap-gesture thresholds",
  "0::online": "DOM lookup helpers",
  "0::protocol": "wire route constants",
  "0::render":
    "instanced-shader modulation, procedural sprite textures, canvas letterbox math & dev perf HUD",
  "0::render/3d/effects": "3D effect infrastructure",
  "0::runtime":
    "runtime leaves: banner copy, DOM/timing shims, camera pitch & modifier-effect ramp curves",
  "0::runtime/audio":
    "audio asset storage & retro format converters (AIL/XMI/snd)",
  "0::server": "wire send helpers",
  "0::shared": "shared constants, RNG & platform leaves",

  // L1 — foundational types
  "1::online": "online server config, SPA router & away watchdog",
  "1::render": "3D sprite scene builders, lights & wall-destroy anim curve",
  "1::render/3d/effects": "effect terrain pattern textures",
  "1::runtime":
    "modifier-effect overlays, mode/dialog tick dispatch & browser timing",
  "1::runtime/audio": "audio leaf infra (synth loader, sound modal)",
  "1::shared":
    "feature/upgrade registry defs, piece & geometry vocabulary, UI interaction types & theme",
  "1::shared/sim": "sim internals — occupancy cache contract",

  // L2 — derived types & local entry
  "2::entry": "boot entry",
  "2::online": "online type definitions",
  "2::protocol": "checkpoint payload types",
  "2::render": "3D camera, debug, sprite scenes & UI theme",
  "2::render/3d/effects": "effect terrain SDF texture",
  "2::runtime": "camera projection math",
  "2::shared":
    "battle event registry, inter-round dialog state & player config",
  "2::shared/sim": "sim internals — RNG-driven piece-bag draw",

  // L3 — wire payloads & shared definitions
  "3::online":
    "peer-local presence state (crosshair interpolation, host-migration banner)",
  "3::shared":
    "battle entity structs, game event bus & settings option helpers",

  // L4 — core state & adjacent types
  "4::render": "3D entity helpers",
  "4::shared":
    "cannon-mode & modifier registry defs, Player struct, phantom payloads & banner content",

  // L5 — first logic
  "5::game": "build-phase placement contracts",
  "5::protocol": "wire message unions & MESSAGE constants",
  "5::render": "3D instance bucketing",
  "5::runtime": "runtime banner state",
  "5::shared":
    "core GameState & spatial helpers, system contracts & overlay view types",
  "5::shared/sim":
    "sim internals — interior freshness epochs, piece-bag lifecycle & Player rule write-surface",

  // L6 — upgrades, modifiers & runtime contracts
  "6::ai":
    "AI decision intents (life lost, upgrade pick), build-pipeline shared types, the ice-trench tactic planner & in-flight ball dedup",
  "6::game":
    "core game systems (combos, selection, map gen, elevation, aim occlusion)",
  "6::game/modifiers":
    "state-only modifier implementations & eligibility filter",
  "6::game/upgrades": "upgrade implementations",
  "6::online":
    "online session core: lobby UI, session state, heartbeat desync detection & rejoin",
  "6::render":
    "frame contract & overlay helpers, aim-elevation picks, shader warm-up fixture & touch loupe",
  "6::runtime":
    "runtime cores: state, tick context, dialog cores, overlay registry & battle-aim targeting",
  "6::runtime/audio": "audio players (music + sfx)",
  "6::runtime/subsystems": "haptics — leaf-depth subsystem factory",
  "6::server": "server game-room",
  "6::shared":
    "shared controller guards, phase-view projections, render-view & input deps",
  "6::shared/sim": "sim internals — occupancy queries & wall mutators",

  // L7 — entity renderers & cross-domain handlers
  "7::ai": "AiStrategy contract & the grunt-sweep tactic planner",
  "7::game": "match init & zone re-flood",
  "7::game/modifiers":
    "shared tile-eviction helper for terrain-mutating modifiers",
  "7::game/upgrades":
    "wall-mutating upgrade implementations (demolition, erosion)",
  "7::input": "pointer/tap → action dispatch, touch-control state & seed field",
  "7::online":
    "server-message lifecycle, lockstep seat reclaim & online client stores",
  "7::render": "entity renderers",
  "7::render/3d/effects":
    "terrain tile-data texture, aim crosshairs & base effect meshes (fire, dust, impacts, fog, shield, reveal-burst)",
  "7::runtime":
    "castle-build, tick consumers, no-peer NetworkApi, wire senders, modifier reveal timing & runtime/UI contracts",
  "7::runtime/subsystems":
    "audio, banner, camera, dialog & pointer-player subsystems",
  "7::server": "server room manager",
  "7::shared/sim": "sim internals — board occupancy & territory queries",

  // L8 — subsystems
  "8::ai":
    "AiBrain contract, castle-rect geometry & the selection phase machine",
  "8::entry": "server entry",
  "8::runtime/subsystems":
    "input, render, lobby, options & cannon-animator subsystems",
  "8::game": "core subsystems (castle gen, grunt movement, upgrade system)",
  "8::game/modifiers":
    "terrain-mutating modifier implementations (fire, tides, sinkhole)",
  "8::input": "input device handlers (keyboard, mouse, touch canvas, touch UI)",
  "8::online": "online runtime websocket",
  "8::render": "render UI (overlays, screens, settings)",
  "8::render/3d/effects":
    "entity burn/dust effects & terrain element effects (emergence, collapse, ice, lightning, water surge, wildfire, supply-ship)",
  "8::runtime": "UIContext adapter",

  // L9 — system implementations
  "9::ai": "min-cut wall planner & build scoring",
  "9::game": "cannon, modifier, game-over & wall-impact systems",
  "9::online": "online runtime lobby",
  "9::render": "render UI entry",
  "9::render/3d/effects": "modifier-effect registry",

  // L10 — mid-depth assembly
  "10::ai": "shared build infra & the cannon phase machine/placement strategy",
  "10::game": "grunt system",
  "10::render": "map renderer & 3D scene bootstrap",
  "10::runtime": "main loop",

  // L11 — system composition
  "11::game": "battle & build systems",
  "11::render": "Canvas2D frame renderer",

  // L12 — phase orchestration
  "12::ai": "build target selection, build phase machine & battle strategy",
  "12::controllers": "BaseController abstraction",
  "12::game": "game actions, phase setup & scheduling",
  "12::online": "online server-event handlers & remote crosshair mirroring",
  "12::render": "3D renderer entry",
  "12::runtime": "battle animation driver",

  // L13 — wiring
  "13::ai":
    "battle phase machine, battle tactic planners & build desperation/lookahead",
  "13::controllers": "human controller & AI commit port",
  "13::game": "phase entry helpers",
  "13::online": "online state serialization & action send path",
  "13::runtime": "local action surface",
  "13::runtime/subsystems": "score-delta subsystem factory",

  // L14 — brain contract & factories
  "14::controllers":
    "controller factory & AI controller (host wrapper around injected brain)",
  "14::online": "online host promotion",
  "14::runtime": "phase transition machine",
  "14::runtime/subsystems": "selection — castle-selection subsystem factory",

  // L15 — tactic planners & bootstrap
  "15::controllers": "AI assisted-human controller variant",
  "15::online": "online lockstep seat takeover",
  "15::runtime": "match bootstrap — controllers & GameState from settings",
  "15::runtime/subsystems":
    "game-lifecycle & phase-ticks — phase-orchestrating subsystem factories",

  // L16 — brain assembly
  "14::ai":
    "AiBrain assembly, build-phase placement orchestrator & derived tactic planners (grunt breach, max-repair-cost, super-attack)",
  "16::runtime": "GameRuntime handle — composition return type",

  // L17 — composition roots
  "15::ai": "DefaultStrategy — production AiStrategy implementation",
  "17::online":
    "online phase transitions, rehydrate, resync defer & host promote",
  "17::runtime": "runtime composition",

  // L18 — entry assembly
  "16::ai": "default AI bundle (strategy + brain assembly entrypoint)",
  "18::entry": "local-game entry",
  "18::online": "online runtime deps & session",

  // L19 — online deps wiring
  "19::online": "online runtime composition",

  // L20 — online client entry
  "20::entry": "online client entry",
};

main();

function main(): void {
  const args = new Set(Deno.args);
  const checkMode = args.has("--check");
  const allowTodo = args.has("--allow-todo");
  const acceptLabels = args.has("--accept-labels");

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

  const previous = readPreviousCells();
  if (!reportOrphanLabels(cells)) Deno.exit(1);
  if (!reportDuplicateRoles(cells)) Deno.exit(1);
  if (!acceptLabels && !reportLabelDrift(cells, previous)) Deno.exit(1);

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

/**
 * The previously committed cell map, or null when it doesn't exist yet.
 * `.import-cells.json` doubles as the label baseline: it records both the
 * role and the file list as of the last approved regen, which is exactly
 * what `reportLabelDrift` needs to tell "membership changed" from
 * "membership changed and someone re-read the label".
 */
function readPreviousCells(): Map<string, Cell> | null {
  let raw: string;
  try {
    raw = readFileSync(CELLS_PATH, "utf-8");
  } catch {
    return null;
  }
  const cells: Cell[] = JSON.parse(raw);
  return new Map(
    cells.map((cell) => [
      cellKey(cell.layer, cell.domain, cell.subdomain),
      cell,
    ]),
  );
}

/**
 * LABELS keys that match no cell. These accumulate silently whenever a
 * domain's layer indices shift — the vacated key keeps its label and the
 * cell that moved inherits its new neighbour's label instead. Catching the
 * vacated key is what makes that shift visible.
 */
function reportOrphanLabels(cells: Cell[]): boolean {
  const live = new Set(
    cells.map((cell) => cellKey(cell.layer, cell.domain, cell.subdomain)),
  );
  const orphans = Object.keys(LABELS).filter((key) => !live.has(key));
  if (orphans.length === 0) return true;

  console.error(
    `✗ ${orphans.length} LABELS ${orphans.length === 1 ? "entry matches" : "entries match"} no cell:`,
  );
  for (const key of orphans) console.error(`    ${key} — "${LABELS[key]}"`);
  console.error(
    `\n  A label with no cell usually means the cell shifted layer. Check whether` +
      `\n  its label followed it, then delete the stale key from LABELS in` +
      `\n  scripts/cells/regen-cells.ts.`,
  );
  return false;
}

/**
 * Two cells sharing a role string make `cell-lookup.ts` ambiguous — the
 * whole point of the cell map is that a role names one place.
 */
function reportDuplicateRoles(cells: Cell[]): boolean {
  const byRole = new Map<string, string[]>();
  for (const cell of cells) {
    if (cell.role.startsWith("TODO:")) continue;
    const key = cellKey(cell.layer, cell.domain, cell.subdomain);
    byRole.set(cell.role, [...(byRole.get(cell.role) ?? []), key]);
  }
  const duplicates = [...byRole].filter(([, keys]) => keys.length > 1);
  if (duplicates.length === 0) return true;

  console.error(`✗ ${duplicates.length} role label(s) used by several cells:`);
  for (const [role, keys] of duplicates) {
    console.error(`    "${role}" — ${keys.join(", ")}`);
  }
  console.error(
    `\n  cell-lookup.ts can't disambiguate these. Differentiate the labels by` +
      `\n  what actually splits the cells.`,
  );
  return false;
}

/**
 * Cells whose membership changed while their role label stayed byte-identical.
 * That is the signature of label-widening debt: a file joins a cell and nobody
 * re-reads whether the role still describes what's in there. Revising the label
 * in the same change clears it automatically; `--accept-labels` is the escape
 * hatch for when the existing label genuinely already covers the new file.
 */
function reportLabelDrift(
  cells: Cell[],
  previous: Map<string, Cell> | null,
): boolean {
  if (previous === null) return true;

  const drifted: { key: string; cell: Cell; before: Cell }[] = [];
  for (const cell of cells) {
    if (cell.role.startsWith("TODO:")) continue;
    const key = cellKey(cell.layer, cell.domain, cell.subdomain);
    const before = previous.get(key);
    if (before === undefined) continue;
    if (before.role !== cell.role) continue;
    if (before.files.join("\n") === cell.files.join("\n")) continue;
    drifted.push({ key, cell, before });
  }
  if (drifted.length === 0) return true;

  console.error(
    `✗ ${drifted.length} cell(s) changed membership without a label review:`,
  );
  for (const { key, cell, before } of drifted) {
    const gained = cell.files.filter((file) => !before.files.includes(file));
    const lost = before.files.filter((file) => !cell.files.includes(file));
    console.error(`\n    ${key} — "${cell.role}"`);
    for (const file of gained) console.error(`      + ${file}`);
    for (const file of lost) console.error(`      - ${file}`);
  }
  console.error(
    `\n  Re-read each role above against its new file list. Widen or rewrite the` +
      `\n  label in LABELS (scripts/cells/regen-cells.ts) and re-run, or re-run with` +
      `\n  --accept-labels if the existing label already covers the change.`,
  );
  return false;
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
