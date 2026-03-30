---
name: refactor
description: AST-based refactoring via scripts/refactor.ts. Use when renaming symbols, moving exports, or renaming properties across files.
user-invocable: true
---

# AST Refactoring Tool

Reliable multi-file refactoring via ts-morph AST transforms. Use instead of manual multi-step Edit calls for renames, moves, and property renames.

## When to use

- Renaming a symbol (function, const, variable) that has references across files
- Moving an exported declaration from one file to another (rewrites all imports)
- Renaming an interface/type property across all usage sites
- Renaming a local parameter/variable name across multiple functions in specific files

## Commands

### `rename-symbol` — Rename a single exported/declared symbol

Finds the declaration in the specified file and renames it + all references across the project.

```bash
npm run refactor rename-symbol <file> <name> <newName> [--dry-run]
```

Best for: exported functions, constants, types, enums — anything with one declaration and many references.

Handles shorthand property fixups automatically (`{ oldName }` → `{ newName: oldName }` when the local variable isn't renamed).

### `move-export` — Move a declaration between files

Removes the export from the source file, adds it to the target file, carries over needed imports, and rewrites all consumer imports across the project.

```bash
npm run refactor move-export <from> <to> <name> [--dry-run]
```

Best for: moving a constant, function, type, or interface to a more appropriate module.

### `rename-prop` — Rename an interface/type property

Finds the property on the named interface or type alias and renames it + all access sites.

```bash
npm run refactor rename-prop <typeName> <prop> <newProp> [--dry-run]
```

Best for: renaming a field on a widely-used interface (cascades to all `.prop` accesses and destructuring).

### `rename-in-file` — Rename ALL declarations of a name in specific files

Iteratively finds every declaration (parameter, variable, property) of the given name in the listed files and renames each one. References cascade to other files via ts-morph.

```bash
npm run refactor rename-in-file <name> <newName> <file1> <file2> ... [--dry-run]
```

Best for: renaming a commonly-used parameter name (like `ctx`) that appears in many functions within specific files, where each function has its own declaration.

Handles the case where both a property and its local variable are renamed — collapses redundant `{ newName: newName }` back to shorthand `{ newName }`.

## Tips

- Always `--dry-run` first to preview the scope of changes
- Run `tsc --noEmit` after to verify (the tool doesn't type-check)
- Run `npx biome check --write <files>` after if import ordering matters
- For interface property renames that should cascade everywhere, prefer `rename-prop` over `rename-in-file`
- For bulk parameter renames scoped to specific files, prefer `rename-in-file` over running `rename-symbol` N times
