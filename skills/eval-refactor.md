---
name: eval-refactor
description: Evaluate a refactoring by comparing metrics before/after. Use after completing a non-trivial extraction, split, or reorganization.
user-invocable: true
---

# Evaluate Refactor

Compare structural metrics before and after a refactoring to verify it improved the codebase (or at least didn't make it worse).

## When to use

- After extracting a sub-system or helper module
- After splitting a large file
- After moving code between modules
- Before committing, to decide if the refactor is worth keeping

## Metrics to collect

Run these commands and record the results. Compare against the previous commit (or a specified git ref).

### 1. Line counts (affected files)

```bash
# Current state
wc -l <affected files>

# Before (from git)
git show HEAD~1:<file> | wc -l
```

**What to look for:**
- Total lines should stay flat or decrease slightly (extraction adds deps/interface overhead)
- The source file should shrink meaningfully (>50 lines saved)
- New files should be self-contained (not just moved code + a big deps interface)
- If total lines increased by >20%, the extraction added too much overhead

### 2. Export counts

```bash
npm run export-index
# Then check .export-index.json for the affected files
grep -c "affected-file" .export-index.json
```

Or use the hot-exports report:
```bash
npm run hot-exports
```

**What to look for:**
- New module should export a small API (1-3 functions/types)
- Source file should have fewer exports (or same — it now re-exports from the new module)
- No new "hot exports" (symbols imported by 5+ files) unless intentional

### 3. Dependency fan-out

```bash
# How many files does each affected file import from?
grep -c "^import" <file>

# How many files import from the new module?
grep -rl "from.*<new-module>" src/ | wc -l
```

**What to look for:**
- New module should have fewer imports than the source file
- New module should be imported by 1-2 files (ideally just the source)
- If the new module imports from 10+ files, it's not self-contained enough
- No new circular dependencies (`npm run lint:circular`)

### 4. Architecture compliance

```bash
npm run lint:architecture
npm run lint:layers
```

**What to look for:**
- New sub-system files pass architecture lint (factory pattern, single deps param, no peer imports)
- No layer violations introduced

## Evaluation template

After collecting metrics, fill in this summary:

```
### Refactor: [description]

| Metric              | Before | After | Delta |
|---------------------|--------|-------|-------|
| Source file lines    |        |       |       |
| New file lines      | —      |       | +N    |
| Total lines         |        |       |       |
| Source imports       |        |       |       |
| New file imports     | —      |       |       |
| New file exports     | —      |       |       |
| Files importing new  | —      |       |       |
| Layer violations     |        |       |       |
| Architecture violations |     |       |       |

Verdict: [GOOD / NEUTRAL / REVERT]
```

**GOOD:** Source file meaningfully smaller, new file is focused, total complexity flat or reduced.
**NEUTRAL:** Code moved but no real improvement. Keep if it improves readability, revert if not.
**REVERT:** Total complexity increased, deps interface is bloated, or new module isn't self-contained.

## Rules of thumb

- A deps interface longer than the extracted logic is a smell — the extraction boundary is wrong
- If the new file has >5 imports from within the project, it might be at the wrong abstraction level
- Extraction is worth it when the source file reads as high-level orchestration afterward
- Moving 30 lines into a new 80-line file (with deps/types overhead) is usually not worth it
- The best extractions have a clear name that describes a cohesive concept
