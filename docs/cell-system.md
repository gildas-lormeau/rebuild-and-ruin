# Module Cells & Placement Reference

Agent-facing reference for placing new code and gauging edit impact. Read
this before adding a new file, before editing a contract that crosses
domain boundaries, or whenever the answer to "where does this go?" isn't
obvious from the directory tree.

## What & why

The codebase has two complementary indices over its modules:

- **Layers** (`.import-layers.json`) — mechanical depth. `layer(f) = 1 +
  max(layer(dep))`, or 0 if no intra-project imports. Used to enforce
  import-flow direction (higher layer imports lower). Names are pure
  indices `L0`, `L1`, …, `L18` — no semantic content.
- **Cells** (`.import-cells.json`) — `(domain × layer)` intersections
  with hand-curated `role` labels. Where naming actually happens.

A layer-only view (the old shape) forced unrelated roles to share a label
whenever they landed at the same depth (e.g. an online wire payload and a
shared event bus both at L3). Cells separate them by domain, so each cell
gets a sharp role identity.

## Files in play

- `.import-layers.json` — auto-generated. 19 layers, indexed `L0..L18`.
  Run `deno run -A scripts/generate-import-layers.ts` to regenerate.
  `--check` fails if any file is missing.
- `.import-cells.json` — derived from layers + path-inferred domain +
  hand-curated labels. Run `deno run -A scripts/cells/regen-cells.ts`.
  `--check` fails if stale.
- `.domain-boundaries.json` — domain edge policy (`allowed`, `typeOnlyFrom`)
  and a tiny `exceptions` block for files whose role overrides their path
  (e.g. `server/server.ts → entry`).
- `scripts/cells/` — three tools (see below).

Domain is inferred from path:

- `src/<X>/...` → domain `X` (one of `shared`, `protocol`, `game`, `ai`,
  `controllers`, `input`, `render`, `online`, `runtime`).
- `src/<file>` (root) → `entry`.
- `server/...` → `server`.
- Override via the `exceptions` block.

## Workflow: adding a new file

1. **Look up the cell by role.** Use one of the keywords the cell label
   would contain — usually the noun for what you're writing.

   ```bash
   deno run -A scripts/cells/cell-lookup.ts "modifier effect"
   deno run -A scripts/cells/cell-lookup.ts "wire payload"
   deno run -A scripts/cells/cell-lookup.ts "ai strategy"
   ```

   The top match is usually right. The result lists the cell's existing
   files — read 1–2 of them to learn the extension pattern.

2. **Write the file** in the directory implied by the cell's domain (e.g.
   `L7 · render` cell → `src/render/...` somewhere). Path implies domain;
   layer is computed from imports.

3. **Regenerate.**

   ```bash
   deno run -A scripts/generate-import-layers.ts
   deno run -A scripts/cells/regen-cells.ts
   ```

4. **Check.** Pre-commit runs both `--check` modes; you can also run them
   manually. If `regen-cells` says a new `(domain, layer)` cell appeared
   without a label, add an entry to the `LABELS` map in
   `scripts/cells/regen-cells.ts`.

## Workflow: editing a cross-cutting file

Before editing a contract (controller protocol, runtime types, wire
payloads, registry definition), get the impact radius:

```bash
deno run -A scripts/cells/cell-edit-impact.ts src/shared/core/system-interfaces.ts
```

The report includes:

- **Cell** — where this file lives.
- **Same-cell peers** — siblings; usually need the same shape of edit.
- **Consumers grouped by cell** — every caller, sorted descending by layer
  (closer to entry first). This is the cascade you must update.
- **Deps grouped by cell** — what this file imports (rarely relevant for
  edits but useful for refactors).
- **Test consumers** — `test/` files that import this one.

Use it when an interface change would otherwise require multi-grep to find
all sites. Replaces the "grep, miss two callers, build breaks, repeat"
loop.

## The layer formula (reminder)

```
layer(f) = 0                              if f has no intra-project imports
layer(f) = 1 + max(layer(dep) for dep)    otherwise
```

In English: a file's layer is one more than the deepest layer it imports.
You can't choose a layer — it's a deterministic function of imports. To
force a file up, give it a real dependency on a higher-layer module
(`audit-layer-pins.ts <file>` shows which import is pinning a file's
layer today).

## Maintaining cell labels

When `regen-cells.ts` flags a new cell or you notice an existing label no
longer fits, three responses (in order of preference):

1. **Add a new LABELS entry** — for new `(domain, layer)` intersections.
2. **Widen an existing label** — when one file joined a cell with an
   adjacent-but-different role. Pattern: join the two roles with `&` or
   `+`. Example: `L7 · render` started as "entity renderers & 3D effect
   factories", widened to "...& alternate renderers" when the ASCII
   renderer landed.
3. **Reorganize** — if the cell genuinely spans multiple unrelated
   roles, the right answer may be to move files between domains, split
   a feature across two files, or accept that the cell is a true
   compositional one (e.g. `L6 · game` legitimately holds modifier and
   upgrade implementations side-by-side).

Avoid: making the label vaguer ("misc render stuff"). The cell label is
the analysis — a lie there is a bug.

## Min-depth outliers

A file whose imports pin it to a lower layer than its role suggests is
called a **min-depth outlier**. The most common cause: a dev-only browser
entry whose deepest dependency lands shallow (it doesn't need the full
production wiring stack).

Recognized resolutions:

- **Move it out of `src/`** — dev/test tooling belongs in `dev/`,
  `scripts/`, or `test/` (all outside the layer system). This is the
  default for dev-only browser entries like the ASCII debug renderer
  and the sprite viewer page; they currently live in `dev/`.
- **Widen the cell label** — accept the outlier; document via the label.
  Use this only when the file is genuinely production code that happens
  to sit lower than its role suggests.
- **Force a real higher dependency** — only if such a dependency genuinely
  exists. Never invent a fake import.

## Troubleshooting

**"New cell appeared without a label" on regen.** Add an entry to LABELS
in `scripts/cells/regen-cells.ts`. The error message includes the
`(layer, domain)` key.

**"`.import-cells.json` is stale" in pre-commit.** Run
`deno run -A scripts/cells/regen-cells.ts` (no flags) to refresh.

**"File X is in .import-layers.json but its domain can't be inferred."**
The file path doesn't match the domain heuristic. Either move it under a
domain directory or add an `exceptions` entry in `.domain-boundaries.json`.

**File landed at the wrong layer.** Use `audit-layer-pins.ts <file>` to
see which import is pinning it. The pin is the deepest import — to move
the file lower, drop or replace that dependency; to move higher, add a
genuine higher-layer dependency.

**Cell label looks wrong.** Read the cell's files (`cell-lookup` shows
them). If the label is stale, update it in `LABELS`. If the cell genuinely
contains conflicting roles, that's a placement bug — surface it.
