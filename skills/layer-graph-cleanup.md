---
name: layer-graph-cleanup
description: Two-axis architecture analysis — vertical (layer graph edges) and horizontal (domain boundaries, coupling metrics, natural clustering). Finds misplaced code, cross-domain violations, and pain points. Run after import-hygiene, or periodically as the codebase grows.
user-invocable: true
---

# Architecture Cleanup

Two complementary analyses:
1. **Layer graph** (vertical) — spot undesirable cross-layer edges
2. **Architecture health** (horizontal) — coupling pain points, domain boundary violations, natural clustering mismatches

## Repo reality

This codebase has been written and repeatedly refactored by LLM-based agents rather than by a stable human team with shared tacit knowledge. Treat the architecture files, lint scripts, comments, and skills as the project's primary memory.

Implications for this workflow:
- Prefer **executable rules** over inferred style. If a convention matters, encode it in scripts, types, or comments rather than assuming future agents will rediscover it.
- Treat `.import-layers.json` (layer groups with `tier` field), `.domain-boundaries.json`, and the audit scripts as the canonical source of architectural intent.
- When you find a real pattern that agents must follow, update the relevant skill or in-code documentation in the same session when practical.
- Be skeptical of "organic" clustering alone: in an agent-maintained repo, some structure exists because the tooling taught it, not because humans would naturally name it that way.

## When to use

- After a round of `import-hygiene` (no violations, but the graph still has unexpected edges)
- After a major refactor that moved files between layers
- Periodically to detect coupling drift (pain points increasing, domain mismatches appearing)
- When a new architectural boundary is desired (e.g., "input should not know about render")

## Step 1 — Generate the collapsed graph

```bash
deno run -A scripts/layer-graph.ts
```

This emits a dot graph where each **node = one layer group**, and each **edge = at least one file in group A imports a file in group B**. Paste the output at https://dreampuf.github.io/GraphvizOnline/ or render with `dot`.

The graph is far more readable than a file-level graph: ~19 nodes instead of ~190. Nodes cluster into 5 tiers: **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L18).

## Step 2 — Read the graph for smells

Formal violations (upward edges) are already caught by `--check`. Look instead for:

| Smell | Example | Why it matters |
|---|---|---|
| High layer → low layer (unexpected) | Online logic (L15) → handlers (L7) | Networking code shouldn't know about input handlers |
| Entry point bypassing runtime | `online-client` → `assembly` directly | Should go through the composition/wiring layers |
| Cross-domain edges | Input files import render files at same layer | Input should be usable independently of rendering |
| File group name doesn't match files inside | `server.ts` in "deep logic" | Name drift signals a misclassified file |

Ask for each edge: **"Should this layer need to know about that layer?"** If the answer is no, there's work to do.

## Step 3 — Classify the fix

Once you have a suspicious edge `A → B`, trace which specific files cause it:

```bash
grep -rn "from.*render-" src/online/*.ts
```

Then classify:

| Root cause | Fix |
|---|---|
| Type/interface defined in wrong layer | Move it to a lower layer (or reclassify the file) |
| File has no deps above layer N but is classified higher | Reclassify the file in `.import-layers.json` — no code change needed |
| Injected dependency passed from entry point | Import directly in the consuming layer (hoist) |
| Factory logic inlined at entry point | Extract a factory helper into a lower module |
| Agent-only convention lives only in examples | Add or tighten docs/comments/scripts so later agents don't have to infer it |

## Step 4 — Apply the fix

### Move a type to a lower layer

1. Add to the lower file (e.g., `types.ts`)
2. In the old file, add a re-export for backward compat: `export type { X } from "./types.ts"`
3. Update consumers that need the dep eliminated (not just the re-export): change their import to the canonical source
4. Run `knip` — if the re-export has no remaining consumers, remove it

### Reclassify a file (zero code changes)

If a file's actual imports are all below layer N, it can be moved to layer N in `.import-layers.json` regardless of its filename prefix:

```json
{ "name": "game state & orchestration", "files": ["src/shared/spatial.ts", "src/shared/overlay-types.ts", ...] }
```

Check: does the file import from anything in its current group or higher? If not, it can move down freely.

### Hoist an injected dependency

If entry point A injects function `foo` (from layer L) into runtime B, and B is already above L:

```typescript
// Before: entry-point imports foo from L5, passes to runtime
// After: runtime imports foo from L5 directly
import { foo } from "../ai/ai-strategy.ts";
```

Remove `foo` from the injected config interface. Entry point no longer needs the import.

### Encapsulate a factory

If an entry point calls `createX(...)` from a low layer with inline logic:

```typescript
// Before: entry-point imports createController from L6
createControllerForSlot: (i, gs) => createController(i, isAi, kb, seed)

// After: extract makeXFactory() into a mid-layer module (e.g., runtime-bootstrap.ts)
// Entry point imports makeXFactory from L12, not createController from L6
createControllerForSlot: makeXFactory(myId, keyBinding)
```

## Step 5 — Verify and iterate

```bash
npx tsc --noEmit
deno run -A scripts/generate-import-layers.ts --check --server
deno run -A scripts/layer-graph.ts   # regenerate to confirm the edge is gone
```

Re-read the graph. Fixes often cascade — removing one edge may reveal another that was hidden.

If the fix introduced a new architectural convention or clarified an old one, update the relevant skill/doc immediately. In this repo, documentation is part of the architecture, not an afterthought.

## Step 6 — Update group names and tiers

After moving files, check that group names and tiers still describe their contents:

- Files with a `render-` prefix but no canvas deps → belong in a shared types group, not "render"
- Logic files (game rules, phase transitions) mixed into "controllers" → move to "game systems"
- A file whose only reason for being in group G is a single type → move the type, then move the file
- If a group moved across a tier boundary (e.g., from logic to systems), update its `tier` field

Rename groups in `.import-layers.json` to match reality. **Naming is the analysis** — a mismatch is always a signal. Tier assignments: **types** (L0–L4), **logic** (L5–L6), **systems** (L7–L9), **assembly** (L10–L13), **roots** (L14+).

**Name drift after refactors.** The generator preserves `name` and `tier` across regens (indexed by layer number); it never rewrites them. After any refactor that adds/removes files at a layer, the preserved label may no longer describe the contents. Treat this as a **bug**, not cosmetic: the project's stated invariant is a perfect graph where every group name honestly describes its files. When a refactor lands, re-read every affected group's file list and rename if the label lies. Legitimate min-depth edge cases (entry points, server stubs, barrel files) should be accommodated by broader names (e.g., "foundational types & local entry"), not hidden behind a narrower label.

## Step 7 — Find single-consumer exports crossing domains

```bash
deno run -A scripts/report-hot-exports.ts --threshold 1 --max 1 --kinds function,const --summary
```

This shows every exported function/const imported by exactly one file, with **From/To domain** and **Src/Dst layer** columns. Entries marked with `←` cross a domain boundary.

**What to look for:**
- `shared → render` or `shared → input` with a large layer gap (e.g., L0→L13) — the export may belong in or near its sole consumer
- Functions exported from a shared module to one consumer — candidates to inline or colocate (like `createLobbyConfirmKeys` which was moved to its sole consumer `screen-builders.ts`)
- Constants that are semantically tied to their consumer's domain (e.g., `LOUPE_*` render constants defined in `theme.ts` but consumed only by `render-loupe.ts`)

**Not issues:** Most same-domain single-consumer exports are intentional modular APIs. Game balance constants in `game-constants.ts` are deliberately centralized even if consumed once.

Use `--max 2` to also catch two-consumer exports that might be overexposed.

## Step 8 — Run architecture health analysis

The layer graph catches vertical problems. The health report catches horizontal ones.

```bash
deno run -A scripts/architecture-health.ts
```

Three analyses, zero hand-written rules:

### Coupling metrics (Robert Martin)

For each file: Cv (value dependents), Ct (type-only dependents), Ce (dependencies), Instability = Ce/(Ca+Ce), **Pain = Cv × stability × concreteness**.

The Pain table splits incoming edges into **value** vs **type-only** because they represent different kinds of coupling:

- A **value import** (`import { foo }`, default, namespace, side-effect) means the consumer runs the imported file's code. Changes propagate at runtime.
- A **type-only import** (`import type { Foo }`, `import { type Foo }`, or all-`type` named specifiers) is erased by the compiler. The consumer only depends on the *shape*; changes propagate through the type-checker, not runtime.

**Pain uses Cv only.** A file with Cv=2, Ct=30 is a contract / DI seam — many consumers know its shape, but only two execute its code. That's not a god file; it's exactly what you'd want from a well-placed interface module. The old (unweighted) Pain metric flagged these as drift, leading agents to propose pointless splits.

**What to look for:**
- **High Pain** (Cv ≥ 10, low instability): concrete file whose *runtime behavior* is depended on by many files. Any change cascades. Ask: does this file mix unrelated value exports that could be split?
- **High Ct, low Cv**: shows up in the **Contracts / DI seams** section, not Pain. Leave it alone — it's working as designed.
- **High Ce + low Ca**: composition root — should be at the top of the layer stack, not mid-graph.

**Fix pattern:** Extract widely-used *values* (functions, constants) from god files into dedicated modules. Examples: `PlayerSlotId` extracted from `game-constants.ts` → `player-slot.ts` dropped Cv from 82 to 8 (and the bulk of consumers turned out to be type-only, which the new metric makes visible).

### Contracts / DI seams (separate section)

Listed as `◆ Contracts / DI seams (high type fan-in, low value fan-in)` below the Pain table. Threshold: `Ct ≥ 5 AND Cv ≤ 2`.

These files are **not** drift even though Louvain may still cluster their consumers loosely around them. They are the project's interface boundaries: deps-object contracts (`RegisterOnlineInputDeps` in `ui-contracts.ts`), pure shape modules (`geometry-types.ts`, `overlay-types.ts`), and serialization DTOs (`checkpoint-data.ts`). Treat them as pinned: don't propose splits without a value-side reason.

If a file should appear here but doesn't, it likely has a stray value export (a factory function, an `export const X = ...`) pulling its Cv up. Move that one value out to drop the file into the contracts list.

### Domain boundary lint

```bash
deno run -A scripts/lint-domain-boundaries.ts
```

Checks that imports stay within allowed domain boundaries defined in `.domain-boundaries.json`. 9 domains: shared, game, ai, player, input, render, online, runtime, entry. Directories under `src/` match domains 1:1. Checks static imports, re-exports, dynamic `import()` expressions, `typeOnlyFrom` constraints, and fails on unassigned files.

**What to look for:**
- Violations mean a file imports from a domain it shouldn't know about (including via dynamic `import()`).
- A blanket permission (e.g., `online → render`) that only 3 of 26 online files actually need — the rule is too permissive.
- Unassigned files — any `.ts` file in `src/` or `server/` not registered in `.domain-boundaries.json` escapes all boundary checks.

**Fix pattern:** Move the shared type/interface to a lower domain, or tighten the allowed rules with per-file exceptions.

### Natural clustering (Louvain)

The health report discovers "natural" domains from actual coupling using community detection on a **weighted** undirected import graph. Edge weights:

- Value edge: `1.0`
- Type-only edge: `0.1`

Type weighting prevents DI seams from acting as gravitational centers. Without it, a single 600-line contract file consumed by 30 modules as `import type` would pull all 30 consumers into one giant blob and bury the real domain structure.

The diff against declared domains then surfaces *runtime* coupling drift, not type sharing.

**What to look for:**
- **Mismatches**: file declared in domain X but clusters with domain Y. After the type-weighting, this means real value coupling — the file's runtime behavior is intertwined with Y, not just its type vocabulary.
- **Large mixed clusters**: two declared domains that the algorithm merges into one — they share executable code paths, not just contracts.
- **Singletons**: file in its own cluster — it's an outlier with weak coupling to everything.

**Fix pattern:** If a file consistently clusters with the wrong domain *after type weighting*, either move it to the right domain (if its responsibilities match), or extract the cross-domain value dependency that pulls it toward the wrong cluster. If it only clustered wrong under the old unweighted metric, it was probably a contract — leave it alone.

**Anti-pattern to avoid:** Don't propose splitting a file just because it appears in many clusters' import lists. Check Cv first. A file with Cv=0 and Ct=40 is a seam by design; the sprawl is the *point*, not a problem.

## Step 9 — Iterate: the full workflow

The systematic workflow for a clean architecture session:

1. `deno run -A scripts/generate-import-layers.ts --check --server` — fix any formal violations first
2. `deno run -A scripts/layer-graph.ts` — read the collapsed graph, fix suspicious edges (Steps 1–6)
3. `deno run -A scripts/architecture-health.ts` — read the health report:
   - Fix the highest Pain points by extracting widely-used exports into dedicated modules
   - Run `deno run -A scripts/lint-domain-boundaries.ts` — fix cross-domain violations
   - Compare natural clusters vs declared domains — investigate mismatches
4. Re-run the health report after each fix to measure improvement (Pain should decrease)
5. Stop when: no formal violations, no domain violations, no Pain points that represent misplaced code (high Pain on abstract type files is acceptable)

Rename groups and update tiers in `.import-layers.json` to match reality. **Naming is the analysis** — a mismatch is always a signal.

## Step 10 — Bottom-up placement audit

The layer graph catches inter-layer edges; this audit catches **exports trapped at the wrong layer**. A file sits at the layer of its deepest import — but many of its exports may not need that import, meaning they're pinned higher than necessary.

### Methodology

Work **bottom-up** (L0 → L5). Fixes propagate upward: moving an export down can cascade, dropping consumer files to lower layers. Upper layers (L6+) are consumer-oriented with legitimate deep dependencies — diminishing returns.

**Focus on L3–L5** (the "sweet spot" where organic growth traps types at higher layers than needed).

### Per-file checklist

For each file in the target layer:

1. **List imports by layer** — which layer pins this file?
2. **For each export** — does it actually USE the pinning import? Or could it live lower?
3. **Check for re-exports** — a re-export from a higher layer creates dual import paths (consumers split between canonical and re-export source). Remove re-exports; point all consumers at the canonical L0 source.
4. **Check for mixed concerns** — does one file pack enums/types from multiple domains? Split if >50% of consumers need only one subset.

### Cascade protocol

After moving files to lower layers:

1. Re-check files in the layer above — their pinning import may have just dropped
2. Repeat until no more files can move
3. If an entire layer group empties, remove it and renumber

### Example: L4 "shared types & config" elimination

In the April 2025 audit, 8 files were moved out of L4 (dialog-types→L0, checkpoint-data→L0, theme→L1, player-config→L1, phantom-types→L3, life-lost→L3, upgrade-pick→L3, castle-build→L3). This caused all 7 remaining L4 files to cascade down (system-interfaces→L3, overlay-types→L3, settings-ui→L1, tick-context→L3, phase-banner→L3, phase-transition-shared→L3, screen-builders→L3), eliminating L4 entirely.

### When NOT to move

A file that *could* be at a lower layer but is semantically part of a higher group should stay. Example: online-types.ts could be L3 by imports, but belongs in "deep logic" (L6) because it defines online-specific state. Layer numbers enforce import direction; semantic grouping is also valuable.

## Patterns from this codebase

Historical log of past refactoring decisions. Filenames refer to what files were called
at the time of each change. Some have since been renamed, moved into domain
directories, or relocated entirely to `test/` (e.g. `runtime-headless.ts`
now lives at `test/runtime-headless.ts` since every option on it is
test-only). If you grep for a filename here and don't find it, run
`git log --all -- 'src/**/<name>'` and `git log --all -- 'test/**/<name>'`
to follow the move.

Most entries below were discovered and executed by LLM-based agents under script-enforced constraints. Read them as "previously verified transformations" rather than as informal historical anecdotes.

| Edge removed | How |
|---|---|
| `render` → `selection` (L7→L6) | Moved `SelectionState` from `selection.ts` to `types.ts` |
| `online-client` → `ai-strategy` (L14→L5) | Hoisted `autoPlaceCannons` import into `runtime-phase-ticks.ts` |
| `online-client` → `controller-factory` (L14→L6) | Extracted `createOnlineControllerSlotFactory` into `runtime-bootstrap.ts` |
| `input` → `render` (was L9→L7, now L7→L8) | Moved `render-theme.ts` to L3 (no canvas deps); moved `ControlsState` to `types.ts`; reordered input before render |
| `online-logic` → `render` (L11→L8) | Reclassified `render-types.ts` to L3 (only imports L1–L3) |
| `selection.ts` misplaced in "controllers" | Moved to "game systems" — it's phase logic, not a controller impl |
| `online-infra` → `game-logic` (L10→L4) | Reclassified `online-serialize.ts` to L11 (imports L0–L10) |
| `app-roots` → `game-logic` (L14→L4) | Hoisted `resetZoneState` to `online-phase-transitions.ts`; hoisted battle/build/cannon-system functions to `online-server-events.ts`; removed dead TransitionContext fields |
| `app-roots` → `controllers` (L14→L6) | Added `createAiController` to `runtime-bootstrap.ts`; `online-client-promote.ts` imports L12 instead of L6 |
| `online-client-stores.ts` misplaced in "app roots" | Reclassified to L12 "runtime" (only imports L0–L11); renamed to `runtime-online-stores.ts` |
| `game-ui-helpers.ts` prefix mismatch in "game logic" | Renamed to `game-helpers.ts` — deps are L3–L4, not L9 "game UI" |
| `app-roots` → `online-logic` (L14→L11) | Reclassified 5 `online-client-*.ts` orchestration files to L12 "runtime" (max dep is L12); eliminated L14→L10 edge too |
| `ai-constants.ts` over-classified in L5 | Reclassified to L0 — zero imports |
| `ai-build-types.ts` over-classified in L5 | Reclassified to L1 — only imports geometry-types + pieces |
| `ai-castle-rect.ts` over-classified in L5 | Reclassified to L2 — max dep is board-occupancy/spatial/types |
| `ai-build-score.ts`, `ai-build-fallback.ts` over-classified in L5 | Reclassified to L3 after cascade — max dep is L2 |
| `ai-build-target.ts` over-classified in L5 | Reclassified to L4 — needs build-system |
| `tick-context.ts` over-classified in L4 | Reclassified to L3 — max dep is controller-interfaces (freed by game-engine extraction) |
| `phase-transition-shared.ts` over-classified in L4 | Reclassified to L3 — max dep is phase-banner |
| `input & sound` → `game logic` (L7→L4) | Reconciled duplicate `BattleEvent`/`ImpactEvent`/`CannonFiredEvent`/`TowerKilledEvent` types from `battle-system.ts` with identical `*Message` types already in `protocol.ts` (L2); added `ImpactEvent` and `BattleEvent` union aliases to protocol; consumers import from protocol |
| `runtime-online-dom.ts` over-classified in "runtime" | Reclassified to L0 "leaf utilities" — zero imports; renamed to `online-dom.ts` |
| `runtime-host-phase-ticks.ts` over-classified in "runtime" | Reclassified to L4 "game logic" — max dep is L3; renamed to `host-phase-ticks.ts` |
| `runtime-host-battle-ticks.ts` over-classified in "runtime" | Reclassified to "online logic" — max dep was online-types (L11); renamed to `online-host-battle-ticks.ts` |
| `online-host-battle-ticks.ts` over-classified in L13 | After `HostNetContext` moved to `tick-context.ts` (L4), max dep dropped to L6; reclassified to "game logic", renamed to `host-battle-ticks.ts`; eliminated L14→L13 edge |
| `types.ts` Pain=80 (85 dependents) | Extracted Phase/Mode/Action enums + 6 phase guards → `game-phase.ts` (L0); extracted 13 dialog types (LifeLost*, UpgradePick*, ControlsState, GameOverFocus) → `dialog-types.ts` (L3); extracted cannon/battle types (CannonMode, Cannon, Cannonball, Impact, BurningPit, BattleAnimState) → `battle-types.ts` (L3); moved CastleData+PlayerStats → `overlay-types.ts`; moved WatcherTimingState → `tick-context.ts`; Pain dropped from 80→54; also eliminated L16→L3 and L3→L2 edges |
| 5 `ai-build-*.ts` files misplaced in L3/L4/L6 | Reclassified ai-build-types, ai-castle-rect, ai-build-score, ai-build-fallback, ai-build-target to L7 "AI strategy" — only consumed by AI files; eliminated L3→L2 edge |
| `runtime-online-stores.ts` over-classified in "runtime" | Reclassified to "online logic" — max dep is online-watcher-tick (same group); renamed to `online-stores.ts` |
| `runtime` → `controllers` (L13→L6) | Created L10 "runtime support" group; moved `runtime-bootstrap.ts`, `runtime-headless.ts`, `runtime-touch-ui.ts` (max deps L8/L6/L8); eliminated the edge |
| `MapData` duplicate of `GameMap` in `render-types.ts` | Eliminated `MapData`; renderer uses `GameMap` from `geometry-types.ts` directly |
| `Viewport` misplaced in `render-types.ts` | Moved to `geometry-types.ts` — pure geometry rect `{x,y,w,h}` |
| `loadSettings`/`saveSettings`/`computeGameSeed` in `game-ui-settings.ts` | Moved to `player-config.ts` — settings persistence belongs with `GameSettings` type |
| `game-ui-types.ts` zero imports at L9 | Reclassified to L0; renamed to `settings-defs.ts` (option labels & constants) |
| `game-ui-settings.ts` over-classified at L9 | Reclassified to L3; renamed to `settings-ui.ts` (cycleOption, formatKeyName) |
| `game-ui-screens.ts` over-classified at L9 | Reclassified to L3; renamed to `screen-builders.ts` (max dep L3) |
| L9 "game UI" eliminated | All 3 files cascaded to L0/L3; layer group removed |
| `render-types.ts` name mismatch at L3 | Renamed to `overlay-types.ts`; `PlayerStats` moved to `types.ts` |
| `render-theme.ts` name mismatch at L3 | Renamed to `theme.ts` — pure constants, no canvas deps |
| `runtime support` → `render` (L10→L8) | Moved `LoupeHandle` to `overlay-types.ts`; removed re-exports from `runtime-bootstrap.ts`; hoisted `precomputeTerrainCache` to caller |
| `WatcherTimingState` in `online-types.ts` (L10) | Moved to `types.ts` (L2) — pure interface, zero deps; unlocked `runtime-types.ts` cascade |
| `runtime-types.ts` over-classified in "runtime" | Reclassified to "runtime support" — max dep L7 (haptics, sound) |
| `runtime-camera.ts` over-classified | Reclassified to "runtime support" — max dep L2/L3 + runtime-types |
| `runtime-state.ts`, `runtime-touch-ui.ts` over-classified | Reclassified to L4 "runtime primitives" — max dep L3 |
| `runtime-banner.ts`, `runtime-human.ts` over-classified | Reclassified to L4 "runtime primitives" — max dep L3, no runtime-types dep |
| L3 "shared interfaces, config & scoring" bloated (19 files) | Split into L3 "shared types & config" (13 files) + L4 "runtime primitives" (6 files) |
| "geometry & pieces" bundled unrelated concerns | Split into L1 "geometry types" + L2 "pieces" — eliminates false edge (input → pieces) |
| L14 "runtime" mixed local + online (15 files) | Split into L14 "local runtime" (10 files) + L15 "online runtime" (5 files) |
| `server/room-manager.ts` over-classified in entry points | Reclassified to L13 "online logic" — max dep is L12 (online infrastructure) |
| `game-constants.ts` Pain=82 (82 dependents) | Extracted `PlayerSlotId`, `ValidPlayerSlot`, `SPECTATOR_SLOT`, `isActivePlayer` to `player-slot.ts` (L0) — Pain dropped to 40 |
| `upgrade-defs.ts` in game domain, imported by `types.ts` (shared) | Reclassified to shared domain — zero-dep option constants |
| `runtime support` → `input & sound` (L11→L9) | Extracted `HapticsSystem` and `SoundSystem` interfaces from `haptics-system.ts`/`sound-system.ts` to `system-interfaces.ts` (L4); runtime-types.ts no longer imports from input |
| `runtime-types.ts` over-classified in "runtime support" (L11) | After interface extraction, max dep dropped to L5 (runtime-state); reclassified to "runtime primitives" |
| `runtime-camera.ts` over-classified in L11 | Max dep is runtime-types (now L5); reclassified to "runtime primitives" |
| `runtime-score-deltas.ts`, `runtime-upgrade-pick.ts`, `runtime-game-lifecycle.ts` over-classified in L14 | Max dep is L5 (runtime-state) or zero imports; reclassified to "runtime primitives" |
| L11 "runtime support" renamed to "game bootstrap" | After cascade, only runtime-bootstrap.ts and runtime-headless.ts remained (factory/setup files) |
| `runtime-phase-ticks.ts`, `runtime-life-lost.ts` over-classified in L14 | After interface extraction freed them from L9 dep, max dep dropped to L6 (game logic); created L7 "phase orchestration" group |
| Layer ordering: input/render artificially inflated | Input (max dep L4) and render (max dep L4) sat between controllers (L8) and game bootstrap (L11), forcing cross-cutting runtime files above render. Reordered: phase orchestration (L7) → AI (L8) → controllers (L9) → game bootstrap (L10) → input (L11) → render (L12) |
| `controller-interfaces.ts` name mismatch | After adding HapticsSystem/SoundSystem interfaces, renamed to `system-interfaces.ts` — now hosts all sub-system contracts (controllers + haptics + sound) |
| L15 "local runtime" mixed composition root + sub-systems (6 files) | Split into L13 "runtime sub-systems" (5 sub-system factories, max dep L12) + L16 "local runtime" (1 file: runtime.ts); eliminates L7 edge from sub-system group |
| `runtime-selection.ts` → `runtime-bootstrap.ts` (L13→L10) | Injected `enterTowerSelection` via deps; moved `EnterTowerSelectionDeps` to `runtime-types.ts`; eliminated L13→L10 edge |
| `render/settings-ui.ts`, `render/screen-builders.ts` name mismatch in L5 "runtime primitives" | Reclassified to L4 "shared types & config" (max dep L4); L5 now pure runtime files (10 files) |
| `online-config.ts` over-classified in L14 | Reclassified to L0 "leaf utilities" — zero imports |
| L14 "online infrastructure" over-classified (max dep L4) | Moved entire group from L14 to L5 (after "shared types & config"); no L5–L13 files import from it; eliminated 9-layer gap |
| `runtime-e2e-bridge.ts` over-classified in L13 "runtime sub-systems" | Reclassified to L6 "runtime primitives" — max dep L6 (runtime-state); dev-only bridge with no render/input deps |
| `runtime-selection.ts` over-classified in L13 "runtime sub-systems" | Reclassified to L8 "phase orchestration" — max dep L7 (game logic); eliminated L14→L7 edge from runtime sub-systems |
| `ModifierDiff` dual import path | Removed re-export from `modifier-system.ts`; updated 3 consumers to import from canonical source `game-constants.ts` |
| `game-phase.ts` mixed 3 domain concerns | Split into `game-phase.ts` (Phase enum + predicates), `ui-mode.ts` (Mode enum + predicates), `input-action.ts` (Action enum); 33 import sites updated |
| `router.ts` stateful singleton in shared/ | Moved to `src/runtime/router.ts` — all 4 consumers in runtime/online/entry domains (can import runtime) |
| `dialog-types.ts` over-classified in L3 | Reclassified to L0 — all imports are L0 only (player-slot, upgrade-defs) |
| `checkpoint-data.ts` over-classified in L3 | Reclassified to L0 — pure serialization DTOs, only L0 deps (game-constants, player-slot) |
| `theme.ts` over-classified in L4 | Reclassified to L1 — only deps are geometry-types (L1) + platform (L0) |
| `player-config.ts` over-classified in L4 | Reclassified to L1 — only deps are game-constants (L0), geometry-types (L1), platform (L0), player-slot (L0) |
| `settings-ui.ts` over-classified in L4 | Cascaded to L1 after player-config moved to L1 — only dep is player-config |
| `phantom-types.ts` over-classified in L4 | Reclassified to L3 — only deps are battle-types (L3) + player-slot (L0) |
| `life-lost.ts`, `upgrade-pick.ts`, `castle-build.ts` over-classified in L4 | Reclassified to L3 — max dep is types/board-occupancy (L3) |
| `system-interfaces.ts`, `overlay-types.ts`, `tick-context.ts` cascade from L4 | After phantom-types/player-config moves, all L4 deps became L3; cascaded to L3 |
| `phase-banner.ts`, `phase-transition-shared.ts`, `screen-builders.ts` cascade from L4 | After overlay-types cascaded to L3, these followed; L4 "shared types & config" fully eliminated |
| L3 "core types, state & spatial" bloated (15 files) | Split into L3 "core game types" (battle-types, types, phantom-types, protocol) + L4 "game state & orchestration" (11 files); boundary = type definitions vs type consumers |
| `TileKey` import inversion in `spatial.ts` → `types.ts` | Moved `TileKey` branded type from `types.ts` to `spatial.ts` — lives with its constructor `packTile()`; eliminated the only `spatial → types` import |
| `Player`, `FreshInterior`, helpers trapped in `types.ts` | Extracted to `player-types.ts` (L3) — `Player`, `FreshInterior`, `emptyFreshInterior`, `brandFreshInterior`, `isPlayerAlive`, `isPlayerSeated`; broke the `system-interfaces → types.ts → all consumers` coupling chain |
| `types.ts` Pain=53.9 (Ca=60) — GameState god-object coupling | Introduced per-phase ViewState interfaces in `system-interfaces.ts`: `GameViewState` (phase + players + map), `BuildViewState` (10 fields), `CannonViewState` (7), `BattleViewState` (15). Controllers, AI strategy, and input/online modules import ViewStates instead of GameState. Pain dropped to 31.7 (Ca=39) |
| `AiStrategy` interface typed `GameState` on all methods | Narrowed to per-phase ViewStates: `pickPlacement`/`assessBuildEnd` → `BuildViewState`/`GameViewState`, `placeCannons` → `CannonViewState`, `planBattle`/`pickTarget`/`trackShot` → `BattleViewState`; freed `ai-phase-select`, `ai-phase-cannon`, `ai-phase-battle`, `ai-strategy` from `types.ts` |
| `BaseController` abstract methods typed `GameState` | Narrowed all method signatures to per-phase ViewStates matching `system-interfaces.ts` contracts; freed `controller-types.ts`, `controller-human.ts`, `runtime-input.ts` from `types.ts` |
| Controllers mutated state via `fire()`/`tryPlacePiece()` despite ViewState readonly contract | Extracted `FireIntent` and `PlacePieceIntent` — controllers return intent objects, orchestrator (runtime/online/AI tick) executes mutations against mutable `GameState`. Eliminated both `as never` casts; `fireAndSend` no longer observes `cannonballs.length` hack |
| `aimCannons`, `nextReadyCombined`, `canPlayerFire` typed `GameState` | Widened to structural `GameViewState & { capturedCannons, cannonballs }` intersections — compatible with `BattleViewState`; freed `online-host-crosshairs.ts` |
| `online-send-actions.ts` typed `GameState` on all functions | Narrowed per-function: `tryPlacePieceAndSend` → `BuildViewState`, `tryPlaceCannonAndSend` → `CannonViewState`, `fireAndSend` → `BattleViewState` |
| `phase` missing from `GameViewState` | Added `readonly phase: Phase` to `GameViewState` — universal field needed by input, runtime, and online domains; freed `runtime-e2e-bridge.ts` |
| L15 "online logic" naming mismatch | Renamed to "app entry" — `main.ts` (local) + `online-runtime-ws.ts` (online) |
| L8 "runtime modules" naming collision | Renamed to "system implementations" — 6/13 files were game/ai/render, not runtime domain |
| `feature-defs.ts`, `dev-console.ts` missing from domains | Added to shared and runtime domains respectively in `.domain-boundaries.json` |
| `createBannerState` trapped in L6 `phase-banner.ts` | Moved to `ui-contracts.ts` (L5) — trivial factory, `BannerState` type already there |
| `CastleBuildState` + `CastleWallPlan` trapped in L6 `castle-build.ts` | Moved types to `interaction-types.ts` (L1, was dialog-types.ts) — pure structs, fits alongside `LifeLostDialogState` |
| `dialog-types.ts` name too narrow after adding castle-build types | Renamed to `interaction-types.ts` — holds all transient UI/interaction state types |
| L7 "handlers" mixed 16 files from 5 domains | Split into L7 "handlers" (9 domain-specific files) + L8 "subsystems" (7 runtime files); zero cross-imports between the groups |
| `runtime-state.ts` over-classified in L7 "handlers" | After `createBannerState` + `CastleBuildState` moves, max dep dropped to L5; reclassified to L6 "deep logic" |
| 7 runtime files over-classified in L8 | After `runtime-state.ts` dropped to L6, max dep for `dev-console`, `runtime-human`, `runtime-lobby`, `runtime-options`, `runtime-render`, `runtime-score-deltas`, `runtime-types` dropped to L6; reclassified to L7 "handlers" |
| 4 runtime files over-classified in L9 | After `runtime-types.ts` dropped to L7, max dep for `runtime-camera`, `runtime-e2e-bridge`, `runtime-game-lifecycle`, `runtime-input` dropped to L7; reclassified to L8 "system implementations" |
| `router.ts` misplaced in runtime domain | Moved to `shared/router.ts` — zero deps, used by entry + online; clusters with online in Louvain; pure coordination primitive |
| L8 "runtime subsystems" naming mismatch | Renamed to "subsystems" — 6/13 files are game/ai/render domain, not runtime |
| `shared/` over-populated with mislabeled files (April 2026 pass) | Split into 4 honest moves: (a) `shared/net/{protocol,checkpoint-data,routes,tick-context}.ts` → new `protocol/` domain; (b) `shared/net/phantom-types.ts` stayed shared (`shared/core/phantom-types.ts`) — `overlay-types.ts` legitimately consumes it as a type; (c) `shared/ui/{canvas-layout,router,ui-contracts}` → moved out (see below); (d) the rest of `shared/ui/*` (interaction-types, overlay-types, theme, ui-mode, settings-defs/ui, input-action, player-config) verified as genuinely shared via cross-domain consumers |
| `shared/ui/canvas-layout.ts` belonged to render | Moved to `src/render/render-layout.ts` — only render-canvas + runtime-e2e-bridge consume it; renamed to match `render-` prefix |
| `shared/ui/router.ts` belonged to online | Moved to `src/online/online-router.ts` — only entry + online consumers; renamed to match `online-` prefix |
| `shared/ui/ui-contracts.ts` is a runtime DI seam, not a shared file | Moved to `src/runtime/runtime-contracts.ts` — defines `RegisterOnlineInputDeps` and the `*Deps` family; consumed as `import type` by input/render. Added `input → runtime` and `render → runtime` to `typeOnlyFrom`; dropped the old `runtime → input/render` typeOnlyFrom rule (it was over-strict — runtime is the layer that wires input/render by design, not a violation) |
| `protocol/tick-context.ts` was misclassified — it's not protocol | Moved + renamed: `src/runtime/runtime-tick-context.ts`. The file's docstring says "Shared types and utilities for phase/battle tick functions" — runtime tick state, not wire format. After the move, no runtime sub-system imports `protocol/` at all, so reverted the `protocol → ALLOWED_SUBSYSTEM_DOMAINS` relaxation |
| `player/` was a 3-file fictional domain that clustered with `ai/` | First merged player files into `ai/` → exposed the lie that `ai/controller-human.ts` makes ("human controller in AI domain"). Re-extracted into a new `controllers/` domain holding `controller-{types,human,ai,factory}.ts` (the 3 ex-player files plus `controller-ai.ts` from `ai/`); `ai/` is now strategy-only. `controllers → ai` allowed (controller-ai wraps `DefaultStrategy`) |
| `input/sound-system.ts` and `input/haptics-system.ts` are observers, not input | Both files' own docstrings say "Follows the factory-with-deps pattern used by **other runtime sub-systems**." Moved + renamed: `src/runtime/runtime-sound.ts`, `src/runtime/runtime-haptics.ts`. They join the existing 13 runtime sub-systems via the `runtime-` prefix; added to `lint-architecture.ts` `EXEMPT` set (they're factories with single deps + observer, not generic primitives). `input/` is now 9 files of true input handlers |
| Lateral-imports allowlist became fully stale after layer shifts | Cleared `scripts/lateral-imports-allowlist.json` to `[]` — the layer regen turned all 3 prior lateral edges into normal downward imports |
| Group names drifted after upgrade/modifier split + `controllers/` extraction (April 2026) | Nine groups renamed to match contents without moving any files: L1 "foundational definitions" → "foundational types & local entry" (now accommodates `entry.ts`); L3 "core game types" → "wire format & config types"; L4 "core state & interfaces" → "core game state & server stubs" (holds `server/game-room.ts`, `online-lobby-ui.ts` alongside types); L6 "deep logic" → "upgrades, modifiers & runtime contracts" (22 per-upgrade/per-modifier files dominate); L7 "handlers" → "cross-domain handlers" (24 files from 6 domains — no single theme); L10 "assembly" → "mid-depth assembly"; L11 "controllers" → "game & runtime composition" (the only controller lives at L13); L12 "orchestration" → "phase orchestration & app entry" (adds `main.ts`); L15 "app roots" → "online session lifecycle". No structural violations — this was pure semantic drift in preserved `name`/`tier` fields |
