import { spawnSync } from "node:child_process";
import {
  barrelReexportsSymbol,
  countImportsOfSymbolFrom,
} from "./idempotent.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

export function handle(ctx: CommandContext, verb: string): CommandResult {
  switch (verb) {
    case "barrel":
      return handleBarrel(ctx);
    case "reexport":
      return handleReexport(ctx);
    case "redirect":
      return handleRedirect(ctx);
    case "surface":
      return handleSurface(ctx);
    default:
      return {
        ok: false,
        message: `unknown expose verb '${verb}'. Expected: barrel, reexport, redirect, surface`,
      };
  }
}

function handleBarrel(ctx: CommandContext): CommandResult {
  const sourceDir = ctx.positional[0];
  const outFile = ctx.flagMap.get("out");
  if (!sourceDir || !outFile) {
    return {
      ok: false,
      message:
        "expose barrel requires <sourceDir> (positional) and --out <outFile>",
    };
  }
  assertPinnedSafe(
    "generate-barrel",
    [sourceDir, outFile],
    ctx.pinned,
    ctx.flags.force,
  );
  const result = runV1("generate-barrel", [sourceDir, outFile], {
    dryRun: ctx.flags.dryRun,
  });
  return finalize(ctx, result, "expose barrel");
}

function handleReexport(ctx: CommandContext): CommandResult {
  const symbol = ctx.positional[0];
  const barrel = ctx.flagMap.get("barrel");
  const from = ctx.flagMap.get("from");
  if (!symbol || !barrel || !from) {
    return {
      ok: false,
      message:
        "expose reexport requires <symbol> (positional), --barrel <barrelFile>, --from <sourceFile>",
    };
  }
  if (ctx.flags.idempotent) {
    const alreadyPresent = barrelReexportsSymbol(ctx.project, ctx.cwd, {
      barrel,
      from,
      symbol,
      typeOnly: ctx.flags.type,
    });
    if (alreadyPresent) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `expose reexport: ${barrel} already re-exports '${symbol}' from ${from}${ctx.flags.type ? " (type-only)" : ""} — assuming prior run completed`,
      };
    }
  }

  const args = [barrel, from, symbol];
  if (ctx.flags.type) args.push("--type");
  assertPinnedSafe("add-reexport", args, ctx.pinned, ctx.flags.force);
  const result = runV1("add-reexport", args, { dryRun: ctx.flags.dryRun });
  return finalize(ctx, result, "expose reexport");
}

function handleRedirect(ctx: CommandContext): CommandResult {
  const symbol = ctx.positional[0];
  const from = ctx.flagMap.get("from");
  const to = ctx.flagMap.get("to");
  if (!symbol || !from || !to) {
    return {
      ok: false,
      message:
        "expose redirect requires <symbol> (positional), --from <oldSource>, --to <newSource>",
    };
  }

  if (ctx.flags.idempotent) {
    if (from === to) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `expose redirect: --from and --to are identical ('${from}')`,
      };
    }
    const remaining = countImportsOfSymbolFrom(
      ctx.project,
      ctx.cwd,
      symbol,
      from,
    );
    if (remaining === 0) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `expose redirect: no imports of '${symbol}' from ${from} remain — assuming prior run completed`,
      };
    }
  }

  assertPinnedSafe(
    "redirect-import",
    [symbol, from, to],
    ctx.pinned,
    ctx.flags.force,
  );
  const result = runV1("redirect-import", [symbol, from, to], {
    dryRun: ctx.flags.dryRun,
  });
  return finalize(ctx, result, "expose redirect");
}

function handleSurface(ctx: CommandContext): CommandResult {
  const sourceDir = ctx.positional[0];
  if (!sourceDir) {
    return {
      ok: false,
      message: "expose surface requires <sourceDir> (positional)",
    };
  }
  const result = runV1("compute-public-surface", [sourceDir]);
  if (!result.ok) {
    return {
      ok: false,
      message: `expose surface failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: true, data: parsed };
  } catch {
    return { ok: true, message: result.stdout };
  }
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
