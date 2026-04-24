import path from "node:path";
import process from "node:process";
import type { ExportDeclaration, SourceFile } from "ts-morph";
import { resolveSymbol, toRel } from "./addressing.ts";
import { assertNotPinned } from "./pinned.ts";
import {
  type CommandContext,
  type CommandResult,
  PinnedFileError,
  RefactorError,
} from "./types.ts";
import { runV1, v1DryPreview } from "./v1-bridge.ts";

interface CrossDomainRecord {
  importer: string;
  imported: string;
  symbols: string[];
  kind: "value" | "type";
}

interface ManifestOp {
  op: "expose.redirect" | "move.export";
  symbol: string;
  from: string;
  to: string;
  kind?: "value" | "type";
}

interface BarrelReexport {
  symbol: string;
  from: string;
  isTypeOnly: boolean;
  star: boolean;
}

const DOMAINS: ReadonlyArray<string> = [
  "shared",
  "protocol",
  "game",
  "ai",
  "controllers",
  "input",
  "render",
  "online",
  "runtime",
];

export async function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  try {
    switch (verb) {
      case "extract":
        return handleExtract(ctx);
      case "decouple":
        return handleDecouple(ctx);
      case "collapse":
        return await handleCollapse(ctx);
      default:
        return {
          ok: false,
          message: `unknown compose verb '${verb}'. Expected: extract, decouple, collapse`,
        };
    }
  } catch (err) {
    if (err instanceof PinnedFileError) {
      return { ok: false, code: err.code, message: err.message };
    }
    if (err instanceof RefactorError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

function handleExtract(ctx: CommandContext): CommandResult {
  const newFile = ctx.positional[0];
  if (!newFile) {
    return {
      ok: false,
      message:
        "compose extract requires <newFile> (positional) and --symbols A,B,C",
    };
  }

  const symbols = collectSymbols(ctx);
  if (symbols.length === 0) {
    return {
      ok: false,
      message:
        "compose extract requires --symbols <name,name,...> (or repeated --symbols)",
    };
  }

  const fromFlag = ctx.flagMap.get("from");
  const resolvedFrom = resolveFromFile(ctx, symbols, fromFlag);
  if (!resolvedFrom.ok) {
    return { ok: false, message: resolvedFrom.message };
  }
  const from = resolvedFrom.file;

  const touched = new Set<string>();
  touched.add(path.resolve(ctx.cwd, from));
  touched.add(path.resolve(ctx.cwd, newFile));
  for (const sym of symbols) {
    const preview = v1DryPreview("move-export", [from, newFile, sym]);
    for (const file of preview) touched.add(path.resolve(ctx.cwd, file));
  }
  assertNotPinned([...touched], ctx.pinned, ctx.flags.force);

  const results: Array<{ symbol: string; ok: boolean; output: string }> = [];
  let allOk = true;
  for (const sym of symbols) {
    const result = runV1("move-export", [from, newFile, sym], {
      dryRun: ctx.flags.dryRun,
    });
    const output = (result.stdout + result.stderr).trim();
    results.push({ symbol: sym, ok: result.ok, output });
    if (!result.ok) allOk = false;
  }

  const lines = results.map(
    (record) =>
      `  ${record.ok ? "ok" : "FAIL"} ${record.symbol}${record.output ? `: ${record.output}` : ""}`,
  );
  const summary = `compose extract ${symbols.length} symbol(s) from ${from} to ${newFile}${ctx.flags.dryRun ? " [dry-run]" : ""}`;
  const message = `${summary}\n${lines.join("\n")}`;

  return { ok: allOk, message, data: { from, to: newFile, results } };
}

function handleDecouple(ctx: CommandContext): CommandResult {
  const srcDomain = ctx.positional[0];
  const dstDomain = ctx.positional[1];
  if (!srcDomain || !dstDomain) {
    return {
      ok: false,
      message:
        "compose decouple requires <srcDomain> <dstDomain> (positional). Example: compose decouple render game",
    };
  }
  if (!DOMAINS.includes(srcDomain) || !DOMAINS.includes(dstDomain)) {
    return {
      ok: false,
      message: `compose decouple: unknown domain. Valid: ${DOMAINS.join(", ")}`,
    };
  }

  const result = runV1("list-cross-domain-imports", [
    ctx.cwd === "" ? "src" : "src",
  ]);
  if (!result.ok) {
    return {
      ok: false,
      message: `compose decouple: list-cross-domain-imports failed: ${(result.stderr || result.stdout).trim()}`,
    };
  }

  let records: CrossDomainRecord[];
  try {
    records = JSON.parse(result.stdout) as CrossDomainRecord[];
  } catch (err) {
    return {
      ok: false,
      message: `compose decouple: could not parse v1 JSON output: ${(err as Error).message}`,
    };
  }

  const violations = records.filter(
    (record) =>
      domainOfPath(record.importer) === srcDomain &&
      domainOfPath(record.imported) === dstDomain,
  );

  const apply =
    ctx.flagMap.get("apply") !== undefined || hasBooleanFlag(ctx, "apply");

  if (!apply) {
    return {
      ok: true,
      message: `compose decouple: ${violations.length} cross-domain import(s) from ${srcDomain} to ${dstDomain}`,
      data: { violations },
    };
  }

  const proposedManifest = buildDecoupleManifest(violations, dstDomain);
  return {
    ok: true,
    message: `compose decouple --apply (advisory, phase 1): ${proposedManifest.length} suggested op(s). Review and run via 'refactor apply <manifest.json>'.`,
    data: { proposedManifest, violations },
  };
}

async function handleCollapse(ctx: CommandContext): Promise<CommandResult> {
  const subVerb = ctx.positional[0];
  if (subVerb !== "barrel") {
    return {
      ok: false,
      message: `compose collapse: only 'barrel' is supported (got '${subVerb ?? ""}')`,
    };
  }
  const barrelFile = ctx.positional[1];
  if (!barrelFile) {
    return {
      ok: false,
      message: "compose collapse barrel requires <barrelFile> (positional)",
    };
  }

  const absBarrel = path.resolve(ctx.cwd, barrelFile);
  const barrelSf =
    ctx.project.getSourceFile(absBarrel) ??
    ctx.project.getSourceFile(barrelFile) ??
    ctx.project.addSourceFileAtPathIfExists(absBarrel);
  if (!barrelSf) {
    return {
      ok: false,
      message: `compose collapse barrel: source file not found: ${barrelFile}`,
    };
  }

  const reexports = collectReexports(barrelSf);
  if (reexports.length === 0) {
    return {
      ok: true,
      message: `compose collapse barrel: ${barrelFile} has no re-exports to inline`,
    };
  }

  const touched = new Set<string>();
  touched.add(absBarrel);
  const named = reexports.filter((entry) => !entry.star);
  for (const entry of named) {
    const preview = v1DryPreview("redirect-import", [
      entry.symbol,
      barrelFile,
      entry.from,
    ]);
    for (const file of preview) touched.add(path.resolve(ctx.cwd, file));
  }
  assertNotPinned([...touched], ctx.pinned, ctx.flags.force);

  const redirected: Array<{ symbol: string; ok: boolean; output: string }> = [];
  let allOk = true;
  for (const entry of named) {
    const result = runV1(
      "redirect-import",
      [entry.symbol, barrelFile, entry.from],
      { dryRun: ctx.flags.dryRun },
    );
    const output = (result.stdout + result.stderr).trim();
    redirected.push({ symbol: entry.symbol, ok: result.ok, output });
    if (!result.ok) allOk = false;
  }

  const starSkipped = reexports
    .filter((entry) => entry.star)
    .map((entry) => entry.from);

  if (!ctx.flags.dryRun && allOk && starSkipped.length === 0) {
    barrelSf.delete();
    await ctx.project.save();
  }

  const summaryLines: string[] = [
    `compose collapse barrel ${toRel(absBarrel)}${ctx.flags.dryRun ? " [dry-run]" : ""}`,
    `  redirected ${redirected.filter((record) => record.ok).length}/${redirected.length} named re-export(s)`,
  ];
  if (starSkipped.length > 0) {
    summaryLines.push(
      `  WARNING: ${starSkipped.length} 'export *' re-export(s) skipped (cannot inline without symbol list) — barrel NOT deleted:`,
    );
    for (const source of starSkipped) summaryLines.push(`    - ${source}`);
  } else if (ctx.flags.dryRun) {
    summaryLines.push(`  would delete barrel file ${toRel(absBarrel)}`);
  } else if (allOk) {
    summaryLines.push(`  deleted barrel file ${toRel(absBarrel)}`);
  }

  return {
    ok: allOk,
    message: summaryLines.join("\n"),
    data: {
      barrel: toRel(absBarrel),
      redirected,
      starSkipped,
      deleted: !ctx.flags.dryRun && allOk && starSkipped.length === 0,
    },
  };
}

function collectSymbols(ctx: CommandContext): string[] {
  const raw: string[] = [];
  const multi = ctx.flagMulti.get("symbols") ?? [];
  for (const chunk of multi) {
    for (const name of chunk.split(",")) {
      const trimmed = name.trim();
      if (trimmed) raw.push(trimmed);
    }
  }
  const single = ctx.flagMap.get("symbols");
  if (single && !multi.includes(single)) {
    for (const name of single.split(",")) {
      const trimmed = name.trim();
      if (trimmed && !raw.includes(trimmed)) raw.push(trimmed);
    }
  }
  return raw;
}

function resolveFromFile(
  ctx: CommandContext,
  symbols: ReadonlyArray<string>,
  fromFlag: string | undefined,
): { ok: true; file: string } | { ok: false; message: string } {
  if (fromFlag) return { ok: true, file: fromFlag };

  const files = new Set<string>();
  try {
    for (const sym of symbols) {
      const resolved = resolveSymbol(ctx.project, sym, {
        near: ctx.flags.near,
      });
      files.add(resolved.file);
    }
  } catch (err) {
    if (err instanceof RefactorError) {
      return {
        ok: false,
        message: `compose extract: could not resolve symbols without --from: ${err.message}`,
      };
    }
    throw err;
  }

  if (files.size !== 1) {
    const list = [...files].map((file) => toRel(file)).join(", ");
    return {
      ok: false,
      message: `compose extract: symbols span ${files.size} file(s) (${list}). Pass --from <sourceFile> explicitly.`,
    };
  }
  return { ok: true, file: toRel([...files][0]) };
}

function hasBooleanFlag(ctx: CommandContext, name: string): boolean {
  const value = ctx.flagMap.get(name);
  if (value === "true" || value === "") return true;
  const list = ctx.flagMulti.get(name);
  if (list && list.length > 0) return true;
  return false;
}

function buildDecoupleManifest(
  violations: ReadonlyArray<CrossDomainRecord>,
  dstDomain: string,
): ManifestOp[] {
  const barrel = `src/${dstDomain}/index.ts`;
  const ops: ManifestOp[] = [];
  const seen = new Set<string>();
  for (const record of violations) {
    for (const symbol of record.symbols) {
      const key = `${symbol}:${record.imported}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ops.push({
        op: "expose.redirect",
        symbol,
        from: record.imported,
        to: barrel,
        kind: record.kind,
      });
    }
  }
  return ops;
}

function collectReexports(barrel: SourceFile): BarrelReexport[] {
  const entries: BarrelReexport[] = [];
  for (const decl of barrel.getExportDeclarations()) {
    const source = exportSourcePath(decl);
    if (!source) continue;
    if (decl.isNamespaceExport() || decl.getNamedExports().length === 0) {
      entries.push({
        symbol: "*",
        from: source,
        isTypeOnly: decl.isTypeOnly(),
        star: true,
      });
      continue;
    }
    for (const named of decl.getNamedExports()) {
      entries.push({
        symbol: named.getAliasNode()?.getText() ?? named.getName(),
        from: source,
        isTypeOnly: decl.isTypeOnly() || named.isTypeOnly(),
        star: false,
      });
    }
  }
  return entries;
}

function exportSourcePath(decl: ExportDeclaration): string | undefined {
  const specifier = decl.getModuleSpecifierValue();
  if (!specifier) return undefined;
  const resolved = decl.getModuleSpecifierSourceFile();
  if (!resolved) return specifier;
  return toRel(resolved.getFilePath());
}

function domainOfPath(file: string): string | undefined {
  const normalized = file.split(path.sep).join("/");
  const relative = normalized.startsWith("src/")
    ? normalized.slice(4)
    : path.relative(process.cwd(), normalized);
  const segments = relative.split("/");
  if (segments.length === 0) return undefined;
  const candidate = segments[0];
  return DOMAINS.includes(candidate) ? candidate : undefined;
}
