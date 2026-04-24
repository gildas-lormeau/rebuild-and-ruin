# refactor v2

AST-based refactoring CLI, successor to `scripts/refactor.ts`. Same ts-morph core, new grammar.

## Why v2

v1 grew organically to 21 commands across rename, move, expose, remove, inline, imports, and query. The flat `verb-subject` naming is hard to discover, bare-name addressing silently picks the wrong symbol when ambiguous, and multi-step refactors have to be scripted by hand in shell. v2 fixes these three things without rewriting the AST logic underneath.

## Design principles

1. **Category-first verbs**, subject-second — matches LSP `CodeActionKind` hierarchy, groups 21 commands into 8 mental buckets.
2. **Name-first addressing**, `file#symbol` qualification when ambiguous, snippet disambiguation as escape hatch — agent-friendly (no `line:col`).
3. **Ambiguity is an error**, not a silent pick — tool prints candidates, caller re-dispatches.
4. **Standard flags everywhere** (`--dry-run`, `--write`, `--output`, `--verify`, `--include/--exclude`).
5. **Manifest/transform mode** as a first-class runner, generalizing v1's `bulk-redirect`.

## Top-level shape

```
refactor <category> <verb> <subject> [target] [flags]
refactor apply <manifest.json>
refactor query <kind> <args>
```

## Category → verb matrix

| Category  | Verbs                                       | v1 equivalents                                                                |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `rename`  | `symbol`, `prop`, `file`, `in-file`         | `rename-symbol`, `rename-prop`, `rename-file`, `rename-in-file`               |
| `move`    | `export`, `file`                            | `move-export` (+ `rename-file` when path changes)                             |
| `expose`  | `barrel`, `reexport`, `redirect`, `surface` | `generate-barrel`, `add-reexport`, `redirect-import`, `compute-public-surface` |
| `remove`  | `export`, `import`                          | `remove-export` (+ new: remove unused imports)                                |
| `inline`  | `constant`, `param`                         | `fold-constant`, `inline-param`                                               |
| `imports` | `merge`, `sort`, `prune`                    | `merge-imports` (+ new: prune, sort)                                          |
| `query`   | `symbol`, `exports`, `refs`, `callsites`, `cross-domain`, `surface` | `find-symbol`, `list-*`, `compute-public-surface`    |
| `apply`   | (takes manifest)                            | `bulk-redirect` generalized                                                   |
| `compose` | `extract`, `decouple`, `collapse`           | composed intent verbs (agent-original; no V1 equivalent)                      |

## Canonical examples

### Rename

```
refactor rename symbol Phase --to GamePhase
refactor rename symbol src/types.ts#Phase --to GamePhase      # qualified
refactor rename symbol Phase --to GamePhase --near "enum"     # snippet disambig
refactor rename prop Player.score --to totalScore
refactor rename file src/old-name.ts --to src/new-name.ts
refactor rename in-file ctx --to canvasCtx --files src/render/*.ts
```

### Move / expose

```
refactor move export TILE_SIZE --from src/types.ts --to src/spatial.ts
refactor move export --from src/types.ts --to src/spatial.ts --symbol TILE_SIZE --symbol FOO
refactor expose barrel src/game --out src/game/index.ts
refactor expose reexport canPlacePiece --barrel src/game/index.ts --from src/game/build-system.ts
refactor expose reexport GameState --barrel src/game/index.ts --from src/game/types.ts --type
refactor expose redirect canPlacePiece --from src/game/build-system.ts --to src/game/index.ts
refactor expose surface src/game       # JSON: symbols with outside consumers
```

### Remove / inline

```
refactor remove export src/render/render-map.ts#drawTerrain
refactor inline constant terrainLayerEnabled --file src/render/renderer.ts --value false
refactor inline param drawCastles.drawWalls --file src/render/render-map.ts --value false --drop-param
```

### Imports

```
refactor imports merge --all
refactor imports merge src/game-state.ts src/types.ts
refactor imports prune src/**/*.ts              # new — remove unused imports
refactor imports sort src/**/*.ts               # new — defer to biome but dry-run surface
```

### Query (read-only, JSON-first output)

```
refactor query symbol GameState
refactor query exports src/types.ts
refactor query refs src/types.ts#GameState
refactor query callsites src/render/render-map.ts#drawTerrain
refactor query cross-domain                     # architecture audit
refactor query surface src/game                 # symbols with outside consumers
refactor query blast src/types.ts#GameState     # quantified risk profile
```

### Compose (intent verbs, compose multiple primitives)

```
refactor compose extract src/game/new-module.ts --symbols A,B,C --from src/game/types.ts
refactor compose decouple ai runtime             # list cross-domain violations
refactor compose decouple ai runtime --apply     # propose a fix manifest (advisory)
refactor compose collapse barrel src/game/index.ts
```

### Apply (manifest-driven)

```
refactor apply refactors/unify-cannon-types.json
```

Manifest format — JSON array of operations, executed in one AST pass:

```json
[
  { "op": "move.export", "symbol": "Cannon", "from": "src/types.ts", "to": "src/battle-types.ts" },
  { "op": "rename.symbol", "file": "src/battle-types.ts", "name": "Cannon", "newName": "BattleCannon" },
  { "op": "expose.redirect", "symbol": "BattleCannon", "from": "src/battle-types.ts", "to": "src/shared/core/battle-types.ts" },
  { "op": "remove.export", "file": "src/shared/core/battle-types.ts", "name": "CannonLegacy" }
]
```

## Standard flags

Work on every mutating command.

| Flag            | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `--dry-run`     | Print WorkspaceEdit as diff, don't write                              |
| `--write`       | Explicit opt-in to write (may become default-off in CI later)         |
| `--output`      | `human` (default), `diff`, `json`, `patch`                            |
| `--near <text>` | Snippet disambiguation for name-only addressing                       |
| `--cascade`     | (rename family) also rename coincident locals                         |
| `--verify`      | After writing, run `tsc --noEmit`; roll back WorkspaceEdit on failure |
| `--include`     | Glob filter for files touched                                         |
| `--exclude`     | Glob filter for files skipped                                         |
| `--type`        | (expose.reexport) emit `export type { ... }`                          |
| `--drop-param`  | (inline.param) also strip from signature + call sites                 |
| `--force`       | Override the pinned-file safety rail                                  |
| `--no-idempotent` | Disable idempotency check; force the op to run even if already applied |

## Exit codes & error envelope

Exit codes are structured so agents can branch without parsing prose:

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| `0`  | Success (op applied)                       |
| `1`  | User error (ambiguous, not found, pinned)  |
| `2`  | Internal error                             |
| `3`  | No-op (idempotent hit: op was already done)|

With `--output json`, failures emit a machine-readable envelope:

```json
{
  "ok": false,
  "code": "E_AMBIGUOUS",
  "message": "symbol 'Cannon' is ambiguous (2 matches). ...",
  "details": { "input": "Cannon", "candidates": [...] }
}
```

Error codes:

| Code                    | Meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `E_AMBIGUOUS`           | Bare-name addressing matched >1 symbol                        |
| `E_NOT_FOUND`           | Addressing resolved to zero matches                           |
| `E_INVALID_ARGS`        | Missing or bad flags/positionals                              |
| `E_PINNED_FILE`         | Op would touch a pinned file; pass `--force` to override      |
| `E_CROSS_DOMAIN`        | Op would create a new cross-domain import boundary violation  |
| `E_V1_FAILED`           | Underlying V1 subprocess returned non-zero                    |
| `E_MANIFEST_INVALID`    | Manifest JSON failed schema validation                        |
| `E_ALREADY_DONE`        | Idempotency hit: target state matches current state           |
| `E_INTERNAL`            | Uncaught runtime error                                        |

## Pinned files

A `.refactor-pinned` file at repo root (one glob per line, `#` for comments) lists files the tool refuses to touch by default. Defaults if the file doesn't exist:

```
test/determinism-fixtures/**
.readonly-literals-baseline.json
.import-layers.json
.domain-boundaries.json
```

Any mutating op that would touch these exits with `E_PINNED_FILE` unless `--force` is passed. The intent is to protect baselines, fixtures, and generated config from accidental damage during agent-driven refactors.

## Idempotency

By default (`--idempotent` on), every mutating op checks whether the target state matches the current state before doing anything. If it does, the op exits with code `3` and `E_ALREADY_DONE` — nothing is written. Examples:

- `rename symbol A → B` where `A` is absent and `B` already exists → idempotent hit
- `move export X from A to B` where `X` is already in `B` and not in `A` → idempotent hit
- `remove export X from F` where `X` is already absent from `F` → idempotent hit
- `expose reexport X barrel=B from=F` where `B` already re-exports `X` from `F` → idempotent hit

Pass `--no-idempotent` to skip the check (e.g., for diagnostics).

## Addressing

Every `<subject>` that takes a bare name follows one rule:

- **Zero matches** → exit 1, print `no symbol named X`
- **Exactly one match** → proceed
- **Multiple matches** → exit 1, print a list of qualified forms (`src/a.ts#X`, `src/b.ts#X`) the caller can re-dispatch on. Never silently pick.

Qualification forms accepted:

- `Foo` — bare name (must be globally unique)
- `src/foo.ts#Foo` — file-qualified
- `Foo.method` — member-qualified (for `rename prop`, `inline param`)
- `--near "snippet"` — textual disambiguation

`line:col` is deliberately **not** a primary address form: line numbers drift across edits, column counting is mechanical work LLMs do poorly, and the Claude Code `Edit` tool's string-based addressing is the precedent. If accepted at all, it's a fallback for piping `tsc` diagnostics.

## What's genuinely new vs v1

- **Category grouping** — pure UX / discoverability, no new capability
- **Name-first addressing with qualification** — the big agent-friendliness win
- **Ambiguity-as-error contract** — changes behavior for name-only calls
- **`apply <manifest>` generalized** from `bulk-redirect` to all ops — biggest leverage gain; makes multi-step refactors atomic and reviewable as a single JSON diff
- **`--verify`** — runs tsc after, rolls back on failure
- **`imports prune`** — cleanup that's currently missing
- **`--output json`** on every query

### Agent-originals (not found in V1 / LSP / ast-grep)

- **Machine-readable error codes** (`E_AMBIGUOUS`, `E_PINNED_FILE`, `E_ALREADY_DONE`, …) with JSON error envelope — agents branch on codes, not parsed prose
- **Idempotent-by-default** — retrying a completed op returns `E_ALREADY_DONE`, exit 3, not a fresh edit
- **Pinned-file safety rails** (`.refactor-pinned`) — baseline / fixture / generated-config files are protected from mutating ops unless `--force`
- **Blast-radius preview** (`query blast <symbol>`) — quantified risk profile (file count, cross-domain edges, pinned hits) before committing to a rename or move
- **Intent verbs** (`compose extract | decouple | collapse`) — composed recipes that turn 5–10 primitive calls into one atomic op

## Backwards compatibility

v1 verbs alias to v2 under the hood — `rename-symbol` stays valid, logs a one-line `→ rename symbol` hint. Lets the skill doc + agent memory migrate without breaking anything in-flight.

## File layout

```
scripts/refactor2/
  README.md              this file
  refactor2.ts           CLI entry + dispatcher
  lib/
    types.ts             shared types, error classes, exit codes
    project.ts           shared ts-morph Project factory
    addressing.ts        name-first resolver + ambiguity contract
    flags.ts             standard flag parser
    output.ts            human/diff/json/patch + error envelope
    verify.ts            --verify post-hook (tsc + rollback)
    pinned.ts            .refactor-pinned loader + glob matcher
    idempotent.ts        per-op idempotency precondition checks
    v1-bridge.ts         subprocess wrapper around scripts/refactor.ts + touched-file extractor
    cmd-rename.ts        rename symbol/prop/file/in-file
    cmd-move.ts          move export/file
    cmd-expose.ts        expose barrel/reexport/redirect/surface
    cmd-remove.ts        remove export/import
    cmd-inline.ts        inline constant/param
    cmd-imports.ts       imports merge/sort/prune
    cmd-query.ts         query symbol/exports/refs/callsites/cross-domain/surface/blast
    cmd-apply.ts         apply manifest runner
    cmd-compose.ts       compose extract/decouple/collapse (intent verbs)
```
