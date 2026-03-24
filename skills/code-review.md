---
name: code-review
description: Multi-pass code review and refactoring workflow. Use when the user asks to review code quality, clean up, or refactor.
user-invocable: true
---

# Code Review & Refactoring Workflow

Structured multi-pass review that catches issues in dependency order so each pass builds on a cleaner codebase.

## Passes (run in order)

### Pass 1: Dead code removal
- Unused imports, variables, functions, interfaces, type aliases
- No-op stubs (factories that return empty objects, unused callbacks)
- Commented-out code, unreachable branches
- **Why first:** reduces noise for all subsequent passes

### Pass 2: Hardcoded values
- Magic numbers (sizes, timers, thresholds, percentages)
- Inline font strings, color strings, CSsorruS values
- Repeated literals that should be named constants
- **Why second:** named constants make duplication visible

### Pass 3: Duplicate code & missing helpers
- Same logic repeated in 2+ places
- Copy-pasted patterns (device detection, coordinate conversion, player ID resolution)
- Inline types / shapes used in multiple places that should be named
- Functions that could be shared but are defined locally in each call site
- **Why third:** easier to spot with constants in place and dead code gone

### Pass 4: Misplaced logic
- Game logic in rendering code (state mutation in render functions)
- Rendering concerns in game runtime (pixel math, font strings, color values)
- Input handlers doing too much (business logic instead of delegation)
- Constants/helpers in the wrong module (increasing coupling)
- **Why fourth:** clearest when duplicates are merged and code is minimal

### Pass 5: Workarounds & questionable patterns
- Device detection scattered in logic instead of using a shared constant
- Roundtrip conversions (convert A→B→A)
- Side effects in supposedly pure functions
- Fragile implicit dependencies (button position derived from magic arithmetic)
- **Why last:** many get fixed by earlier passes; what remains is genuine

## Automated tooling (run before manual passes)

Before starting manual passes, run the lint toolchain to catch mechanical issues:

```bash
npm run lint:fix          # Biome: auto-fix import sorting & unused imports
npm run lint:unused       # Knip: dead files, unused exports & dependencies
npm run lint:circular     # Madge: circular dependency detection
npm run lint:duplicates   # jscpd: copy-paste / duplicate code detection
npx tsx scripts/find-duplicate-literals.ts  # AST-based: repeated string & numeric literals
```

Or run everything at once: `npm run lint:all`

- Fix Biome issues first (auto-fixable), then review Knip/Madge/jscpd output
- Knip unused exports feed directly into Pass 1 (dead code)
- jscpd clones feed directly into Pass 3 (duplicate code)
- Madge circular deps feed into Pass 4 (misplaced logic)
- `find-duplicate-literals.ts` findings feed into Pass 2 (hardcoded values) — extract to named constants

## How to run each pass

1. **Launch a sub-agent** (Explore type) with:
   - The list of files to review (scope to the area of interest)
   - The specific category for this pass
   - Instruction: "report findings only, do NOT edit"

2. **Review findings** — cross-reference with lint tool output, discard false positives, confirm real issues

3. **Fix all issues** from the pass

4. **Build + test** — verify no regressions (`npm run build`, `deno check server/server.ts`, E2E if UI changes)

5. **Commit** the pass as a single commit

6. **Proceed to next pass** — the sub-agent sees the clean state

## Sub-agent prompt template

```
Review the following files for [CATEGORY]:
[file list]

Check for:
[specific checklist items from the pass above]

For each finding, report: file, line number, what the code does,
what's wrong, and the suggested fix. Do NOT make any edits.
Be pragmatic — only flag things where the fix genuinely improves
the codebase, not theoretical purity issues.
```

### What to look for specifically
- UI layout/pixel constants in non-rendering modules
- Re-exports that add indirection over canonical sources (prefer importing from the source)
- Constants marked "shared with X" in comments — they should live in the common parent module
- Types defined in a "types" file but only used by one domain

## Tips

- **Scope narrowly** — review 5-10 related files per session, not the whole codebase
- **Commit after each pass** — if something breaks, you know which pass caused it
- **Skip passes that don't apply** — if there's no dead code, go straight to pass 2
- **Don't fix everything** — low-value fixes that risk regressions (e.g., deduplicating input handler dispatch) can be deferred
- **Always run E2E after UI changes** — use `timeout 45 npx tsx test/online-e2e.ts local 1 --mobile --headless --action "mode:GAME screenshot:check exit" "" 3`
- **After all passes, review deferred items** — present the list of issues you identified but chose not to fix, with severity, so the user can decide what else to tackle
