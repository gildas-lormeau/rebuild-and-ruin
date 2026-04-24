import type { OutputFormat, StandardFlags } from "./types.ts";

export interface ParsedArgs {
  positional: string[];
  flagMap: Map<string, string>;
  flagMulti: Map<string, string[]>;
  flags: StandardFlags;
}

const BOOL_FLAGS = new Set([
  "dry-run",
  "write",
  "cascade",
  "verify",
  "type",
  "drop-param",
  "all",
  "force",
  "idempotent",
  "no-idempotent",
]);
const MULTI_FLAGS = new Set(["include", "exclude", "symbol", "files"]);
const VALID_OUTPUTS: ReadonlySet<OutputFormat> = new Set<OutputFormat>([
  "human",
  "diff",
  "json",
  "patch",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flagMap = new Map<string, string>();
  const flagMulti = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eqIndex = body.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eqIndex >= 0) {
      key = body.slice(0, eqIndex);
      value = body.slice(eqIndex + 1);
    } else {
      key = body;
      if (BOOL_FLAGS.has(key)) {
        value = "true";
      } else {
        value = argv[index + 1];
        index++;
      }
    }
    if (value === undefined) {
      throw new Error(`flag --${key} requires a value`);
    }
    if (MULTI_FLAGS.has(key)) {
      const current = flagMulti.get(key) ?? [];
      current.push(value);
      flagMulti.set(key, current);
    } else {
      flagMap.set(key, value);
    }
  }

  const outputRaw = flagMap.get("output") ?? "human";
  if (!VALID_OUTPUTS.has(outputRaw as OutputFormat)) {
    throw new Error(
      `--output must be one of: ${[...VALID_OUTPUTS].join(", ")}, got '${outputRaw}'`,
    );
  }

  const flags: StandardFlags = {
    dryRun: flagMap.get("dry-run") === "true",
    write: flagMap.get("write") === "true",
    output: outputRaw as OutputFormat,
    near: flagMap.get("near"),
    cascade: flagMap.get("cascade") === "true",
    verify: flagMap.get("verify") === "true",
    include: flagMulti.get("include") ?? [],
    exclude: flagMulti.get("exclude") ?? [],
    type: flagMap.get("type") === "true",
    dropParam: flagMap.get("drop-param") === "true",
    all: flagMap.get("all") === "true",
    force: flagMap.get("force") === "true",
    idempotent: flagMap.get("no-idempotent") !== "true",
  };

  return { positional, flagMap, flagMulti, flags };
}

export function flagSummary(flags: StandardFlags): string {
  const parts: string[] = [];
  if (flags.dryRun) parts.push("dry-run");
  if (flags.verify) parts.push("verify");
  if (flags.cascade) parts.push("cascade");
  if (flags.type) parts.push("type-only");
  if (flags.dropParam) parts.push("drop-param");
  if (flags.near) parts.push(`near="${flags.near}"`);
  return parts.length ? `[${parts.join(" ")}]` : "";
}
