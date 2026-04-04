---
name: refactor
description: AST-based refactoring via scripts/refactor.ts. Use for renaming symbols, moving exports, renaming properties, and discovering declarations/exports/references across files.
user-invocable: true
---

# AST Refactoring Tool

Reliable multi-file refactoring via ts-morph AST transforms. Use instead of manual multi-step Edit calls for renames, moves, and property renames. Also provides read-only discovery commands for planning refactors.

All commands support both positional args and named flags (`--flag value`).

## When to use

- **Discovery**: finding where a symbol is declared, what a file exports, or which files import a symbol
- Renaming a symbol (function, const, variable) that has references across files
- Moving exported declarations from one file to another (rewrites all imports)
- Renaming an interface/type property across all usage sites
- Renaming a local parameter/variable name across multiple functions in specific files
- Renaming/moving a file and updating all import paths across the project

## Discovery commands

### `find-symbol` — Locate where a symbol is declared

Searches all project files for declarations of the given name. Reports file, line, kind, and whether it's exported.

```bash
npm run refactor find-symbol <name>
npm run refactor find-symbol --symbol <name>
```

Best for: finding which file owns a symbol before running `move-export` or `rename-symbol`. Also finds class members, interface properties, and type alias properties — reported as `OwnerName.MemberKind`.

### `list-exports` — List all exports from a file

Shows every exported symbol with its kind (function, const, type, interface, enum) and line number.

```bash
npm run refactor list-exports <file>
npm run refactor list-exports --file <file>
```

Best for: surveying a file's public API before planning moves or splits.

### `list-references` — Show all files that import a symbol

Lists every file that imports the given symbol from the specified file, with line numbers and type-only annotations.

```bash
npm run refactor list-references <file> <name>
npm run refactor list-references --file <file> --symbol <name>
```

Best for: assessing blast radius before renaming or moving a symbol.

## Refactoring commands

### `rename-symbol` — Rename a single exported/declared symbol

Finds the declaration in the specified file and renames it + all references across the project.

```bash
npm run refactor rename-symbol <file> <name> <newName> [--dry-run]
npm run refactor rename-symbol --file <file> --symbol <name> --new-name <newName> [--dry-run]
npm run refactor rename-symbol --file <file> --old <name> --new <newName> [--dry-run]
```

Best for: exported functions, constants, types, enums — anything with one declaration and many references.

Handles shorthand property fixups automatically (`{ oldName }` → `{ newName: oldName }` when the local variable isn't renamed).

### `move-export` — Move declarations between files

Removes the export from the source file, adds it to the target file, carries over needed imports, and rewrites all consumer imports across the project. Supports moving multiple symbols at once with repeated `--symbol` flags.

```bash
npm run refactor move-export <from> <to> <name> [--dry-run]
npm run refactor move-export --from <from> --to <to> --symbol <name> [--dry-run]
npm run refactor move-export --from <from> --to <to> --symbol <name1> --symbol <name2> [--dry-run]
```

Positional arg order is auto-detected: `move-export <name> <from> <to>` also works (the tool detects when the first arg looks like a symbol rather than a file path).

Best for: moving a constant, function, type, or interface to a more appropriate module. Use multiple `--symbol` flags to move related declarations together (e.g., a type and its companion helper). Detects re-exports (`export type { X } from "..."`) and points to the canonical source instead of silently breaking.

### `rename-prop` — Rename an interface/type property

Finds the property on the named interface or type alias and renames it + all access sites.

```bash
npm run refactor rename-prop <typeName> <prop> <newProp> [--dry-run]
npm run refactor rename-prop --type <typeName> --prop <prop> --new-prop <newProp> [--dry-run]
npm run refactor rename-prop --type <typeName> --old <prop> --new <newProp> [--dry-run]
```

Positional arg order is auto-detected: `rename-prop <file> <typeName> <prop> <newProp>` also works (the tool detects when the first arg looks like a file path and shifts).

Works on both interfaces and type aliases — including intersection types (`type Foo = Bar & { prop: ... }`).

Best for: renaming a field on a widely-used interface or type alias (cascades to all `.prop` accesses and destructuring).

### `rename-file` — Rename/move a file and update all imports

Renames a source file and rewrites every import specifier across the project that referenced the old path.

```bash
npm run refactor rename-file <oldPath> <newPath> [--dry-run]
npm run refactor rename-file --from <oldPath> --to <newPath> [--dry-run]
```

Best for: renaming or relocating a module without manually fixing dozens of import paths. Always `--dry-run` first to see the blast radius.

### `rename-in-file` — Rename ALL declarations of a name in specific files

Iteratively finds every declaration (parameter, variable, property) of the given name in the listed files and renames each one. References cascade to other files via ts-morph.

```bash
npm run refactor rename-in-file <name> <newName> <file1> <file2> ... [--dry-run]
npm run refactor rename-in-file --symbol <name> --new-name <newName> --files <file1>,<file2> [--dry-run]
npm run refactor rename-in-file --old <name> --new <newName> --files <file1>,<file2> [--dry-run]
```

Positional arg order is auto-detected: `rename-in-file <file...> <name> <newName>` also works (the tool detects when leading args look like file paths and reorders).

Best for: renaming a commonly-used parameter name (like `ctx`) that appears in many functions within specific files, where each function has its own declaration.

Handles the case where both a property and its local variable are renamed — collapses redundant `{ newName: newName }` back to shorthand `{ newName }`.

## Tips

- Use `find-symbol` + `list-exports` + `list-references` to plan before refactoring
- Always `--dry-run` first to preview the scope of changes
- Run `tsc --noEmit` after to verify (the tool doesn't type-check)
- Run `npx biome check --write <files>` after to fix import ordering
- For interface property renames that should cascade everywhere, prefer `rename-prop` over `rename-in-file`
- For bulk parameter renames scoped to specific files, prefer `rename-in-file` over running `rename-symbol` N times
- Move related symbols together with `--symbol A --symbol B` to avoid broken intermediate states
- `move-export` handles self-imports (skips), `import type` vs value imports (splits), and `.ts` extensions (appends) automatically
