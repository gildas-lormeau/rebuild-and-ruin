import process from "node:process";
import { parseArgs } from "./lib/flags.ts";
import { emit, emitError, exitCode } from "./lib/output.ts";
import { loadPinned } from "./lib/pinned.ts";
import { createProject } from "./lib/project.ts";
import {
  type CommandContext,
  type CommandResult,
  EXIT_INTERNAL,
  EXIT_USER_ERROR,
  RefactorError,
} from "./lib/types.ts";

type Category = (typeof CATEGORIES)[number];

type HandlerModule = {
  handle: (
    ctx: CommandContext,
    verb: string,
  ) => CommandResult | Promise<CommandResult>;
};

const CATEGORIES = [
  "rename",
  "move",
  "expose",
  "remove",
  "inline",
  "imports",
  "query",
  "apply",
  "compose",
] as const;
const LOADERS: Record<Category, () => Promise<HandlerModule>> = {
  rename: () => import("./lib/cmd-rename.ts") as Promise<HandlerModule>,
  move: () => import("./lib/cmd-move.ts") as Promise<HandlerModule>,
  expose: () => import("./lib/cmd-expose.ts") as Promise<HandlerModule>,
  remove: () => import("./lib/cmd-remove.ts") as Promise<HandlerModule>,
  inline: () => import("./lib/cmd-inline.ts") as Promise<HandlerModule>,
  imports: () => import("./lib/cmd-imports.ts") as Promise<HandlerModule>,
  query: () => import("./lib/cmd-query.ts") as Promise<HandlerModule>,
  apply: () => import("./lib/cmd-apply.ts") as Promise<HandlerModule>,
  compose: () => import("./lib/cmd-compose.ts") as Promise<HandlerModule>,
};

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return 0;
  }

  const [category, ...rest] = argv;
  if (!isCategory(category)) {
    console.error(`unknown category: ${category}`);
    printUsage();
    return 1;
  }

  let verb = "";
  let verbArgs = rest;
  if (category !== "apply") {
    const [parsedVerb, ...parsedArgs] = rest;
    if (!parsedVerb) {
      console.error(`category '${category}' requires a verb`);
      printUsage();
      return 1;
    }
    verb = parsedVerb;
    verbArgs = parsedArgs;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(verbArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let mod: HandlerModule;
  try {
    mod = await LOADERS[category]();
  } catch (err) {
    console.error(
      `category '${category}' not implemented yet — missing lib/cmd-${category}.ts`,
    );
    if (err instanceof Error && process.env["REFACTOR_DEBUG"]) {
      console.error(err.stack);
    }
    return 2;
  }

  const project = createProject();
  const cwd = process.cwd();
  const pinned = loadPinned(cwd);
  const ctx: CommandContext = {
    project,
    flags: parsed.flags,
    positional: parsed.positional,
    flagMap: parsed.flagMap,
    flagMulti: parsed.flagMulti,
    cwd,
    pinned,
  };

  try {
    const result = await mod.handle(ctx, verb);
    emit(result, parsed.flags.output);
    return exitCode(result);
  } catch (err) {
    emitError(err, parsed.flags.output);
    if (err instanceof RefactorError) {
      return err.code === "E_INTERNAL" ? EXIT_INTERNAL : EXIT_USER_ERROR;
    }
    return EXIT_INTERNAL;
  }
}

function isCategory(value: string | undefined): value is Category {
  return (
    typeof value === "string" &&
    (CATEGORIES as readonly string[]).includes(value)
  );
}

function printUsage(): void {
  console.log(`refactor v2 — AST refactoring CLI

Usage:
  refactor <category> <verb> [args...] [flags]
  refactor apply <manifest.json>

Categories:
  rename   symbol | prop | file | in-file
  move     export | file
  expose   barrel | reexport | redirect | surface
  remove   export | import
  inline   constant | param
  imports  merge | sort | prune
  query    symbol | exports | refs | callsites | cross-domain | surface | blast
  apply    <manifest.json>
  compose  extract | decouple | collapse

Flags:
  --dry-run            Print changes, don't write
  --write              Explicit opt-in to write
  --output FMT         human | diff | json | patch
  --near "snippet"     Disambiguate bare name by snippet match
  --cascade            Also rename coincident locals
  --verify             Run tsc after, roll back on failure
  --include GLOB       Filter files touched (repeatable)
  --exclude GLOB       Filter files skipped (repeatable)
  --type               (expose.reexport) emit 'export type'
  --drop-param         (inline.param) drop param from signature + callers
  --force              Override the pinned-file safety rail
  --no-idempotent      Disable idempotency pre-check; always run the op

Exit codes:
  0 = success       1 = user error       2 = internal       3 = no-op (E_ALREADY_DONE)

See scripts/refactor2/README.md for the full grammar.`);
}
