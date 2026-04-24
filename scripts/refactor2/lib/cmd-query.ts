import { resolveSymbol, toRel } from "./addressing.ts";
import { isPinned } from "./pinned.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { runV1 } from "./v1-bridge.ts";

interface SymbolDeclaration {
  file: string;
  line: number;
  kind: string;
  exported: boolean;
}

interface ExportEntry {
  name: string;
  kind: string;
  line: number;
}

interface ReferenceEntry {
  file: string;
  line: number;
  typeOnly: boolean;
}

interface CallsiteEntry {
  file: string;
  line: number;
  kind: string;
  context: string;
}

interface BlastProfile {
  symbol: string;
  file: string;
  files: number;
  refs: number;
  imports: number;
  type_refs: number;
  call_refs: number;
  read_refs: number;
  assign_refs: number;
  re_exports: number;
  cross_domain_edges: number;
  touches_pinned: number;
  touches_baselines: number;
  touches_fixtures: number;
  pinned_files: string[];
  consumer_domains: string[];
  consumer_layers: string[];
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
const FIXTURE_PREFIX = "test/determinism-fixtures/";
const BASELINE_FILES: ReadonlyArray<string> = [
  ".readonly-literals-baseline.json",
];

export function handle(ctx: CommandContext, verb: string): CommandResult {
  switch (verb) {
    case "symbol":
      return handleSymbol(ctx);
    case "exports":
      return handleExports(ctx);
    case "refs":
      return handleRefs(ctx);
    case "callsites":
      return handleCallsites(ctx);
    case "cross-domain":
      return handleCrossDomain(ctx);
    case "surface":
      return handleSurface(ctx);
    case "blast":
      return handleBlast(ctx);
    default:
      return {
        ok: false,
        message: `unknown query verb '${verb}'. Expected: symbol, exports, refs, callsites, cross-domain, surface, blast`,
      };
  }
}

function handleSymbol(ctx: CommandContext): CommandResult {
  const name = ctx.positional[0] ?? ctx.flagMap.get("name");
  if (!name) {
    return { ok: false, message: "query symbol requires <name>" };
  }
  const result = runV1("find-symbol", [name]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || `no symbol matches '${name}'`,
    };
  }
  const declarations = parseFindSymbol(result.stdout);
  if (declarations.length === 0) {
    return { ok: true, message: result.stdout.trim(), data: [] };
  }
  return {
    ok: true,
    data: { name, declarations },
    message: result.stdout.trim(),
  };
}

function handleExports(ctx: CommandContext): CommandResult {
  const file = ctx.positional[0] ?? ctx.flagMap.get("file");
  if (!file) {
    return { ok: false, message: "query exports requires <file>" };
  }
  const result = runV1("list-exports", [file]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const entries = parseListExports(result.stdout);
  return {
    ok: true,
    data: { file, exports: entries },
    message: result.stdout.trim(),
  };
}

function handleRefs(ctx: CommandContext): CommandResult {
  const address = ctx.positional[0];
  if (!address) {
    return {
      ok: false,
      message: "query refs requires <file#symbol>",
    };
  }
  const { file, symbol } = parseQualifiedAddress(address);
  if (!file || !symbol) {
    return {
      ok: false,
      message: `query refs requires <file#symbol>, got '${address}'`,
    };
  }
  const result = runV1("list-references", [file, symbol]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const references = parseListReferences(result.stdout);
  return {
    ok: true,
    data: { file, symbol, references },
    message: result.stdout.trim(),
  };
}

function handleCallsites(ctx: CommandContext): CommandResult {
  const address = ctx.positional[0];
  if (!address) {
    return {
      ok: false,
      message: "query callsites requires <file#symbol>",
    };
  }
  const { file, symbol } = parseQualifiedAddress(address);
  if (!file || !symbol) {
    return {
      ok: false,
      message: `query callsites requires <file#symbol>, got '${address}'`,
    };
  }
  const result = runV1("list-callsites", [file, symbol]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const callsites = parseListCallsites(result.stdout);
  return {
    ok: true,
    data: { file, symbol, callsites },
    message: result.stdout.trim(),
  };
}

function handleCrossDomain(ctx: CommandContext): CommandResult {
  const root = ctx.positional[0] ?? ctx.flagMap.get("root");
  const args = root ? [root] : [];
  const result = runV1("list-cross-domain-imports", args);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const data = tryParseJson(result.stdout);
  if (data === undefined) {
    return { ok: true, message: result.stdout };
  }
  return { ok: true, data };
}

function handleSurface(ctx: CommandContext): CommandResult {
  const sourceDir = ctx.positional[0] ?? ctx.flagMap.get("dir");
  if (!sourceDir) {
    return { ok: false, message: "query surface requires <sourceDir>" };
  }
  const result = runV1("compute-public-surface", [sourceDir]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const data = tryParseJson(result.stdout);
  if (data === undefined) {
    return { ok: true, message: result.stdout };
  }
  return { ok: true, data };
}

function handleBlast(ctx: CommandContext): CommandResult {
  const input = ctx.positional[0];
  if (!input) {
    return { ok: false, message: "query blast requires <symbol>" };
  }
  const resolved = resolveSymbol(ctx.project, input, { near: ctx.flags.near });
  const file = toRel(resolved.file);
  const name = resolved.name;

  const result = runV1("list-callsites", [file, name]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const callsites = parseListCallsites(result.stdout);

  const declaringDomain = domainOf(file);
  const perKind: Record<string, number> = {
    import: 0,
    "type-ref": 0,
    call: 0,
    read: 0,
    assign: 0,
    "re-export": 0,
  };
  const touchedFiles = new Set<string>();
  const consumerDomains = new Set<string>();
  let crossDomainEdges = 0;

  for (const entry of callsites) {
    if (entry.kind in perKind) perKind[entry.kind] += 1;
    touchedFiles.add(entry.file);
    const consumerDomain = domainOf(entry.file);
    if (consumerDomain) {
      consumerDomains.add(consumerDomain);
      if (declaringDomain && consumerDomain !== declaringDomain) {
        crossDomainEdges += 1;
      }
    }
  }

  const touchedList = [...touchedFiles];
  const pinnedHits = touchedList.filter((f) => isPinned(f, ctx.pinned));
  const fixtureHits = touchedList.filter((f) =>
    normalizePath(f).startsWith(FIXTURE_PREFIX),
  );
  const baselineHits = touchedList.filter((f) =>
    BASELINE_FILES.includes(normalizePath(f)),
  );

  const profile: BlastProfile = {
    symbol: name,
    file,
    files: touchedFiles.size,
    refs: callsites.length,
    imports: perKind.import,
    type_refs: perKind["type-ref"],
    call_refs: perKind.call,
    read_refs: perKind.read,
    assign_refs: perKind.assign,
    re_exports: perKind["re-export"],
    cross_domain_edges: crossDomainEdges,
    touches_pinned: pinnedHits.length,
    touches_baselines: baselineHits.length,
    touches_fixtures: fixtureHits.length,
    pinned_files: pinnedHits.sort(),
    consumer_domains: [...consumerDomains].sort(),
    consumer_layers: [],
  };

  return { ok: true, data: profile };
}

function parseQualifiedAddress(address: string): {
  file?: string;
  symbol?: string;
} {
  const hashIndex = address.indexOf("#");
  if (hashIndex < 0) return {};
  return {
    file: address.slice(0, hashIndex),
    symbol: address.slice(hashIndex + 1),
  };
}

function parseFindSymbol(stdout: string): SymbolDeclaration[] {
  const results: SymbolDeclaration[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("Found ")) continue;
    const match = line.match(/^(.+?):(\d+)\s+(.+?)\s+\((exported|private)\)$/);
    if (!match) continue;
    results.push({
      file: match[1],
      line: Number(match[2]),
      kind: match[3],
      exported: match[4] === "exported",
    });
  }
  return results;
}

function parseListExports(stdout: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("No exports")) continue;
    if (/^\d+\s+export\(s\)/.test(line)) continue;
    const match = line.match(/^:(\d+)\s+(\S+)\s+(\S+)$/);
    if (!match) continue;
    entries.push({
      line: Number(match[1]),
      kind: match[2],
      name: match[3],
    });
  }
  return entries;
}

function parseListReferences(stdout: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("No files import")) continue;
    if (/^\d+\s+file\(s\)\s+import/.test(line)) continue;
    const match = line.match(/^(.+?):(\d+)(?:\s+\(type-only\))?$/);
    if (!match) continue;
    entries.push({
      file: match[1],
      line: Number(match[2]),
      typeOnly: line.includes("(type-only)"),
    });
  }
  return entries;
}

function parseListCallsites(stdout: string): CallsiteEntry[] {
  const entries: CallsiteEntry[] = [];
  let currentFile = "";
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    if (rawLine.startsWith("No call sites")) continue;
    if (/^\d+\s+call site\(s\)/.test(rawLine.trim())) continue;
    if (!rawLine.startsWith(" ") && !rawLine.startsWith(":")) {
      currentFile = rawLine.trim();
      continue;
    }
    const match = rawLine.trim().match(/^:(\d+)\s+\[([^\]]+)\]\s+(.*)$/);
    if (!match) continue;
    entries.push({
      file: currentFile,
      line: Number(match[1]),
      kind: match[2],
      context: match[3],
    });
  }
  return entries;
}

function tryParseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function domainOf(file: string): string | undefined {
  const normalized = normalizePath(file);
  if (!normalized.startsWith("src/")) return undefined;
  const rest = normalized.slice(4);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return undefined;
  const candidate = rest.slice(0, slashIndex);
  return DOMAINS.includes(candidate) ? candidate : undefined;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
