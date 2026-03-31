---
name: layer-graph-cleanup
description: Use the collapsed layer graph to find and remove architecturally undesirable cross-layer edges — even when there are zero formal violations. Run after import-hygiene, or periodically as the codebase grows.
user-invocable: true
---

# Layer Graph Cleanup

`import-hygiene` fixes formal violations (upward imports). This skill goes further: it uses the *collapsed* layer graph to spot edges that are technically valid but architecturally wrong — e.g., online networking logic importing from the render layer.

## When to use

- After a round of `import-hygiene` (no violations, but the graph still has unexpected edges)
- After a major refactor that moved files between layers
- When a new architectural boundary is desired (e.g., "input should not know about render")

## Step 1 — Generate the collapsed graph

```bash
npx tsx scripts/layer-graph.ts
```

This emits a dot graph where each **node = one layer group**, and each **edge = at least one file in group A imports a file in group B**. Paste the output at https://dreampuf.github.io/GraphvizOnline/ or render with `dot`.

The graph is far more readable than a file-level graph: ~15 nodes instead of ~90.

## Step 2 — Read the graph for smells

Formal violations (upward edges) are already caught by `--check`. Look instead for:

| Smell | Example | Why it matters |
|---|---|---|
| High layer → low layer (unexpected) | Online logic (L11) → render (L8) | Networking code shouldn't know about canvas types |
| Entry point bypassing runtime | `online-client` → `ai-strategy` directly | Should go through the runtime layer |
| Cross-domain edges | Input layer imports game UI layer | Input should be usable independently of UI |
| File group name doesn't match files inside | `render-theme.ts` in "config & interfaces" | Name drift signals a misclassified file |

Ask for each edge: **"Should this layer need to know about that layer?"** If the answer is no, there's work to do.

## Step 3 — Classify the fix

Once you have a suspicious edge `A → B`, trace which specific files cause it:

```bash
grep -rn "from.*render-" src/online-*.ts
```

Then classify:

| Root cause | Fix |
|---|---|
| Type/interface defined in wrong layer | Move it to a lower layer (or reclassify the file) |
| File has no deps above layer N but is classified higher | Reclassify the file in `.import-layers.json` — no code change needed |
| Injected dependency passed from entry point | Import directly in the consuming layer (hoist) |
| Factory logic inlined at entry point | Extract a factory helper into a lower module |

## Step 4 — Apply the fix

### Move a type to a lower layer

1. Add to the lower file (e.g., `types.ts`)
2. In the old file, add a re-export for backward compat: `export type { X } from "./types.ts"`
3. Update consumers that need the dep eliminated (not just the re-export): change their import to the canonical source
4. Run `knip` — if the re-export has no remaining consumers, remove it

### Reclassify a file (zero code changes)

If a file's actual imports are all below layer N, it can be moved to layer N in `.import-layers.json` regardless of its filename prefix:

```json
{ "name": "shared types & config", "files": ["src/render-theme.ts", "src/render-types.ts", ...] }
```

Check: does the file import from anything in its current group or higher? If not, it can move down freely.

### Hoist an injected dependency

If entry point A injects function `foo` (from layer L) into runtime B, and B is already above L:

```typescript
// Before: entry-point imports foo from L5, passes to runtime
// After: runtime imports foo from L5 directly
import { foo } from "./ai-strategy.ts";
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
npx tsx scripts/generate-import-layers.ts --check --server
npx tsx scripts/layer-graph.ts   # regenerate to confirm the edge is gone
```

Re-read the graph. Fixes often cascade — removing one edge may reveal another that was hidden.

## Step 6 — Update group names

After moving files, check that group names still describe their contents:

- Files with a `render-` prefix but no canvas deps → belong in a shared types group, not "render"
- Logic files (game rules, phase transitions) mixed into "controllers" → move to "game systems"
- A file whose only reason for being in group G is a single type → move the type, then move the file

Rename groups in `.import-layers.json` to match reality. **Naming is the analysis** — a mismatch is always a signal.

## Patterns from this codebase

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
