import type { Project, SourceFile } from "ts-morph";

export type OutputFormat = "human" | "diff" | "json" | "patch";

export type ErrorCode =
  | "E_AMBIGUOUS"
  | "E_NOT_FOUND"
  | "E_INVALID_ARGS"
  | "E_PINNED_FILE"
  | "E_CROSS_DOMAIN"
  | "E_V1_FAILED"
  | "E_MANIFEST_INVALID"
  | "E_ALREADY_DONE"
  | "E_INTERNAL";

export interface StandardFlags {
  dryRun: boolean;
  write: boolean;
  output: OutputFormat;
  near?: string;
  cascade: boolean;
  verify: boolean;
  include: string[];
  exclude: string[];
  type: boolean;
  dropParam: boolean;
  all: boolean;
  force: boolean;
  idempotent: boolean;
}

export interface SymbolAddress {
  raw: string;
  file?: string;
  name: string;
  member?: string;
}

export interface ResolvedSymbol {
  file: string;
  name: string;
  member?: string;
  sourceFile: SourceFile;
}

export interface CommandContext {
  project: Project;
  flags: StandardFlags;
  positional: string[];
  flagMap: Map<string, string>;
  flagMulti: Map<string, string[]>;
  cwd: string;
  pinned: ReadonlyArray<string>;
}

export interface CommandResult {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
  noop?: boolean;
  changes?: ReadonlyArray<FileChange>;
  data?: unknown;
  details?: unknown;
}

export interface FileChange {
  file: string;
  before: string;
  after: string;
}

export type ManifestOp =
  | {
      op: "rename.symbol";
      file: string;
      name: string;
      newName: string;
      cascade?: boolean;
    }
  | {
      op: "rename.prop";
      typeName: string;
      prop: string;
      newProp: string;
      file?: string;
    }
  | { op: "rename.file"; from: string; to: string }
  | { op: "move.export"; symbol: string | string[]; from: string; to: string }
  | {
      op: "expose.reexport";
      barrel: string;
      from: string;
      symbol: string;
      type?: boolean;
    }
  | { op: "expose.redirect"; symbol: string; from: string; to: string }
  | { op: "remove.export"; file: string; name: string }
  | {
      op: "inline.constant";
      file: string;
      name: string;
      value: "true" | "false";
    }
  | {
      op: "inline.param";
      file: string;
      fn: string;
      param: string;
      value: "true" | "false";
      dropParam?: boolean;
    }
  | { op: "imports.merge"; files: string[] };

export interface Manifest {
  description?: string;
  ops: ManifestOp[];
}

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_INTERNAL = 2;
export const EXIT_NOOP = 3;

export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case "E_INTERNAL":
      return EXIT_INTERNAL;
    case "E_ALREADY_DONE":
      return EXIT_NOOP;
    default:
      return EXIT_USER_ERROR;
  }
}

export class RefactorError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class AmbiguousSymbolError extends RefactorError {
  readonly candidates: ReadonlyArray<{ file: string; name: string }>;
  constructor(
    input: string,
    candidates: ReadonlyArray<{ file: string; name: string }>,
  ) {
    const lines = candidates.map((c) => `  - ${c.file}#${c.name}`).join("\n");
    super(
      "E_AMBIGUOUS",
      `symbol '${input}' is ambiguous (${candidates.length} matches). Disambiguate with file#name or --near:\n${lines}`,
      { input, candidates },
    );
    this.candidates = candidates;
  }
}

export class SymbolNotFoundError extends RefactorError {
  constructor(input: string) {
    super("E_NOT_FOUND", `no symbol matches '${input}'`, { input });
  }
}

export class PinnedFileError extends RefactorError {
  readonly files: ReadonlyArray<string>;
  constructor(files: ReadonlyArray<string>) {
    const list = files.map((f) => `  - ${f}`).join("\n");
    super(
      "E_PINNED_FILE",
      `refactor would touch pinned file(s). Pass --force to override:\n${list}`,
      { files },
    );
    this.files = files;
  }
}

export class InvalidArgsError extends RefactorError {
  constructor(message: string, details?: unknown) {
    super("E_INVALID_ARGS", message, details);
  }
}
