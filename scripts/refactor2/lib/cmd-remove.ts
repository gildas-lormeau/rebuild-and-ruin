import { spawnSync } from "node:child_process";
import path from "node:path";
import { hasTopLevelDecl, loadSourceFile } from "./idempotent.ts";
import type { CommandContext, CommandResult, FileChange } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

export function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  switch (verb) {
    case "export":
      return handleRemoveExport(ctx);
    case "import":
      return handleRemoveImport(ctx);
    default:
      return Promise.resolve({
        ok: false,
        message: `unknown remove verb '${verb}'. Expected: export, import`,
      });
  }
}

function handleRemoveExport(ctx: CommandContext): Promise<CommandResult> {
  const qualified = ctx.positional[0];
  let file: string | undefined;
  let name: string | undefined;

  if (qualified && qualified.includes("#")) {
    const hashIndex = qualified.indexOf("#");
    file = qualified.slice(0, hashIndex);
    name = qualified.slice(hashIndex + 1);
    if (!file || !name) {
      return Promise.resolve({
        ok: false,
        message: `remove export: malformed qualified address '${qualified}' (expected file#name)`,
      });
    }
  } else {
    const flagFile = ctx.flagMap.get("file") ?? ctx.flagMap.get("from");
    const flagName = ctx.flagMap.get("name") ?? ctx.flagMap.get("symbol");
    const positionalA = ctx.positional[0];
    const positionalB = ctx.positional[1];
    file = flagFile ?? pickFileLike(positionalA, positionalB) ?? undefined;
    name = flagName ?? pickNameLike(positionalA, positionalB) ?? undefined;
  }

  if (!file || !name) {
    return Promise.resolve({
      ok: false,
      message:
        "remove export requires <file#symbol> or <file> <symbol> (positional), or --file + --symbol",
    });
  }

  if (ctx.flags.idempotent) {
    const sourceFile = loadSourceFile(ctx.project, ctx.cwd, file);
    if (sourceFile && !hasTopLevelDecl(sourceFile, name)) {
      return Promise.resolve({
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `remove export: '${name}' is not a top-level declaration in ${file} — assuming prior run completed`,
      });
    }
  }

  assertPinnedSafe("remove-export", [file, name], ctx.pinned, ctx.flags.force);
  const result = runV1("remove-export", [file, name], {
    dryRun: ctx.flags.dryRun,
  });
  return Promise.resolve(finalize(ctx, result, "remove export"));
}

async function handleRemoveImport(ctx: CommandContext): Promise<CommandResult> {
  const symbol = ctx.positional[0] ?? ctx.flagMap.get("symbol");
  const fromFile = ctx.flagMap.get("from");
  if (!symbol || !fromFile) {
    return Promise.resolve({
      ok: false,
      message: "remove import requires <symbol> (positional) and --from <file>",
    });
  }

  const absFrom = path.resolve(ctx.cwd, fromFile);
  const targetSf =
    ctx.project.getSourceFile(absFrom) ??
    ctx.project.getSourceFile(fromFile) ??
    ctx.project.addSourceFileAtPathIfExists(absFrom) ??
    ctx.project.addSourceFileAtPathIfExists(fromFile);

  if (!targetSf) {
    return Promise.resolve({
      ok: false,
      message: `remove import: source file not found: ${fromFile}`,
    });
  }

  const before = targetSf.getFullText();
  let removedSpecifiers = 0;
  let removedDeclarations = 0;

  for (const importDecl of [...targetSf.getImportDeclarations()]) {
    let declTouched = false;
    for (const specifier of [...importDecl.getNamedImports()]) {
      if (specifier.getName() === symbol) {
        specifier.remove();
        removedSpecifiers++;
        declTouched = true;
      }
    }
    if (
      declTouched &&
      importDecl.getNamedImports().length === 0 &&
      !importDecl.getDefaultImport() &&
      !importDecl.getNamespaceImport()
    ) {
      importDecl.remove();
      removedDeclarations++;
    }
  }

  if (removedSpecifiers === 0) {
    return Promise.resolve({
      ok: true,
      message: `remove import: no import of '${symbol}' found in ${fromFile}`,
      changes: [],
    });
  }

  const after = targetSf.getFullText();
  const changes: FileChange[] = [
    { file: targetSf.getFilePath(), before, after },
  ];

  if (!ctx.flags.dryRun) {
    await ctx.project.save();
  }

  const message = `removed ${removedSpecifiers} import(s) of '${symbol}' from ${fromFile}${
    removedDeclarations > 0
      ? ` (${removedDeclarations} import declaration(s) dropped)`
      : ""
  }${ctx.flags.dryRun ? " [dry-run]" : ""}`;

  if (ctx.flags.verify && !ctx.flags.dryRun) {
    const tsc = runTsc();
    if (!tsc.ok) {
      return {
        ok: true,
        message: `${message}\nwarning: --verify tsc --noEmit failed:\n${tsc.output}`,
        changes,
      };
    }
  }

  return { ok: true, message, changes };
}

function finalize(
  ctx: CommandContext,
  result: { ok: boolean; stdout: string; stderr: string },
  label: string,
): CommandResult {
  const baseMessage = result.ok
    ? result.stdout.trim() || `${label} completed`
    : `${label} failed: ${result.stderr.trim() || result.stdout.trim()}`;

  if (!result.ok) {
    return { ok: false, message: baseMessage };
  }

  if (ctx.flags.verify && !ctx.flags.dryRun) {
    const tsc = runTsc();
    if (!tsc.ok) {
      return {
        ok: true,
        message: `${baseMessage}\nwarning: --verify tsc --noEmit failed:\n${tsc.output}`,
      };
    }
  }

  return { ok: true, message: baseMessage };
}

function pickFileLike(
  positionalA: string | undefined,
  positionalB: string | undefined,
): string | undefined {
  if (positionalA && looksLikeFile(positionalA)) return positionalA;
  if (positionalB && looksLikeFile(positionalB)) return positionalB;
  return positionalA;
}

function pickNameLike(
  positionalA: string | undefined,
  positionalB: string | undefined,
): string | undefined {
  if (positionalA && !looksLikeFile(positionalA)) return positionalA;
  if (positionalB && !looksLikeFile(positionalB)) return positionalB;
  return positionalB;
}

function looksLikeFile(token: string): boolean {
  return token.includes("/") || token.endsWith(".ts") || token.endsWith(".tsx");
}

function runTsc(): { ok: boolean; output: string } {
  const result = spawnSync("npx", ["tsc", "--noEmit"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}
