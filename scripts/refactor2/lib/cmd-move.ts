import { spawnSync } from "node:child_process";
import { fileOnDisk, hasExportedDecl, loadSourceFile } from "./idempotent.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

export function handle(ctx: CommandContext, verb: string): CommandResult {
  switch (verb) {
    case "export":
      return handleMoveExport(ctx);
    case "file":
      return handleMoveFile(ctx);
    default:
      return {
        ok: false,
        message: `unknown move verb '${verb}'. Expected: export, file`,
      };
  }
}

function handleMoveExport(ctx: CommandContext): CommandResult {
  const from = ctx.flagMap.get("from");
  const to = ctx.flagMap.get("to");
  if (!from || !to) {
    return {
      ok: false,
      message: "move export requires --from <file> and --to <file>",
    };
  }

  const multiSymbols = ctx.flagMulti.get("symbol") ?? [];
  const positional = ctx.positional[0];

  let args: string[];
  let symbolsForCheck: string[];
  if (multiSymbols.length > 0) {
    args = ["--from", from, "--to", to];
    for (const sym of multiSymbols) {
      args.push("--symbol", sym);
    }
    symbolsForCheck = [...multiSymbols];
  } else if (positional) {
    args = [from, to, positional];
    symbolsForCheck = [positional];
  } else {
    return {
      ok: false,
      message:
        "move export requires a symbol (positional) or one-or-more --symbol flags",
    };
  }

  if (ctx.flags.idempotent && from !== to) {
    const fromSf = loadSourceFile(ctx.project, ctx.cwd, from);
    const toSf = loadSourceFile(ctx.project, ctx.cwd, to);
    if (fromSf && toSf) {
      const allMoved = symbolsForCheck.every(
        (sym) => hasExportedDecl(toSf, sym) && !hasExportedDecl(fromSf, sym),
      );
      if (allMoved) {
        const names = symbolsForCheck.join(", ");
        return {
          ok: true,
          noop: true,
          code: "E_ALREADY_DONE",
          message: `move export: '${names}' already exported from ${to} and absent from ${from} — assuming prior run completed`,
        };
      }
    }
  }

  assertPinnedSafe("move-export", args, ctx.pinned, ctx.flags.force);
  const result = runV1("move-export", args, { dryRun: ctx.flags.dryRun });
  return finalize(ctx, result, "move export");
}

function handleMoveFile(ctx: CommandContext): CommandResult {
  const oldPath = ctx.positional[0];
  const newPath = ctx.flagMap.get("to");
  if (!oldPath || !newPath) {
    return {
      ok: false,
      message: "move file requires <oldPath> (positional) and --to <newPath>",
    };
  }

  if (ctx.flags.idempotent) {
    if (oldPath === newPath) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `move file: old and new paths are identical ('${oldPath}')`,
      };
    }
    const oldExists = fileOnDisk(ctx.cwd, oldPath);
    const newExists = fileOnDisk(ctx.cwd, newPath);
    if (!oldExists && newExists) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `move file: '${newPath}' exists and '${oldPath}' is absent — assuming prior run completed`,
      };
    }
  }

  assertPinnedSafe(
    "rename-file",
    [oldPath, newPath],
    ctx.pinned,
    ctx.flags.force,
  );
  const result = runV1("rename-file", [oldPath, newPath], {
    dryRun: ctx.flags.dryRun,
  });
  return finalize(ctx, result, "move file");
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

function runTsc(): { ok: boolean; output: string } {
  const result = spawnSync("npx", ["tsc", "--noEmit"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}
