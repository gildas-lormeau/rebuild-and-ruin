/**
 * lint-comment-refs — deterministic comment-rot detector (zero LLM tokens).
 *
 * Two rot classes, both detection-only (does NOT judge semantic accuracy —
 * that's the expensive LLM tier). The point is to hand a small candidate list
 * to a human/agent instead of paying tokens to ingest the whole tree.
 *
 *   1. File/path references — a comment naming `runtime-banner.ts` after the
 *      file moved to `subsystems/banner.ts`. Flagged if the path no longer
 *      resolves on disk. Always on.
 *   2. Symbol references — a backtick-wrapped `findReachableRingGaps()` or
 *      `GameState` after the symbol was renamed/removed. Flagged if the name
 *      appears nowhere in non-comment code across the repo. Opt-in (--symbols)
 *      because it carries a small false-positive rate (metavariable comment
 *      placeholders like `createXSystem`, intentional historical refs), so it
 *      is a candidate-list tool, not a pre-commit gate.
 *
 * The symbol allow-set is the union of the export index (`.export-index.json`,
 * supplementary — may be stale) and every identifier token in non-comment code.
 * A permissive allow-set is deliberate: extra allowed names only cost recall
 * (a missed rot), never a false block.
 *
 * Run: deno run -A scripts/lint-comment-refs.ts [--all] [--symbols]
 *   (default scans src/; --all scans src/ + test/ + scripts/ + dev/)
 */

import { walkSync } from "@std/fs";
import { dirname, join, resolve } from "@std/path";

interface Finding {
  file: string;
  line: number;
  ref: string;
  kind: "path" | "filename" | "symbol";
}

interface RepoIndex {
  basenames: Set<string>;
  paths: string[]; // repo-relative, forward-slash
}

const CODE_EXT = ["ts", "tsx", "js", "json", "md", "css", "sh"];
// A path/filename token ending in a known extension. Captures both
// backtick-wrapped (`foo/bar.ts`) and bare (foo/bar.ts) forms — backticks
// are just adjacent chars the regex steps over.
const REF_RE = new RegExp(
  `[\\w./@-]*[\\w@-]\\.(?:${CODE_EXT.join("|")})\\b`,
  "g",
);
// Library / prose tokens that look like filenames but never refer to a
// repo file. Extend as needed.
const DENY = new Set(["three.js", "Three.js"]);
// Backtick-wrapped spans — the only place we look for symbol refs. Prose
// outside backticks is too noisy to mine for identifiers.
const BACKTICK_RE = /`([^`\n]+)`/g;
// A symbol-shaped leading token inside a span: an identifier optionally
// followed by `(`. We capture the identifier and whether a call-paren follows.
const SYMBOL_RE = /^([A-Za-z_$][\w$]*)\s*(\()?/;
// Every identifier token, for the code-token allow-set.
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
// Language keywords, literals, and ubiquitous globals that read as symbols
// when backticked but are never project declarations.
const SYMBOL_DENY = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "this",
  "super",
  "new",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "yield",
  "await",
  "async",
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "from",
  "as",
  "in",
  "of",
  "typeof",
  "instanceof",
  "delete",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "namespace",
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "get",
  "set",
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "any",
  "unknown",
  "never",
  "Record",
  "Partial",
  "Pick",
  "Omit",
  "Readonly",
  "Array",
  "Object",
  "Set",
  "Map",
  "Promise",
  "Math",
  "JSON",
  "Date",
  "console",
  "window",
  "document",
  "globalThis",
  "Error",
  "RegExp",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "Infinity",
  "NaN",
]);

main();

function main(): void {
  const all = Deno.args.includes("--all");
  const checkSymbols = Deno.args.includes("--symbols");
  const roots = all ? ["src", "test", "scripts", "dev"] : ["src"];
  const indexRoots = ["src", "test", "scripts", "dev", "server", "docs"];

  // Index every file in the repo so refs can be resolved by basename
  // (bare names) or path suffix (partial paths like `subsystems/banner.ts`).
  const index = collectIndex(indexRoots);
  // Allow-set for symbol refs — empty when symbol checking is off.
  const symbols = checkSymbols ? collectSymbols(indexRoots) : null;

  const findings: Finding[] = [];
  for (const root of roots) {
    for (const entry of walkSync(root, { exts: [".ts"], includeDirs: false })) {
      scanFile(entry.path, index, symbols, findings);
    }
  }

  report(findings);
}

function scanFile(
  file: string,
  index: RepoIndex,
  symbols: Set<string> | null,
  out: Finding[],
): void {
  const text = Deno.readTextFileSync(file);
  const fileDir = dirname(file);
  const lines = text.split("\n");
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let comment: string | null = null;

    if (inBlock) {
      comment = raw;
      if (raw.includes("*/")) inBlock = false;
    } else {
      const blockStart = raw.indexOf("/*");
      const lineStart = raw.indexOf("//");
      if (blockStart !== -1 && (lineStart === -1 || blockStart < lineStart)) {
        comment = raw.slice(blockStart);
        if (!raw.includes("*/", blockStart + 2)) inBlock = true;
      } else if (lineStart !== -1) {
        comment = raw.slice(lineStart);
      }
    }
    if (comment === null) continue;

    for (const match of comment.matchAll(REF_RE)) {
      const ref = match[0];
      const idx = match.index ?? 0;
      if (comment.slice(0, idx).includes("://")) continue; // URLs
      if (ref.startsWith("@")) continue; // package specifiers, jsr/npm
      if (DENY.has(ref)) continue; // library/prose tokens
      // Drop glob/fragment matches (`*-scene.ts`, `.d.ts`): a real ref's
      // basename must start alphanumeric.
      const stem = ref.slice(ref.lastIndexOf("/") + 1);
      if (!/^[A-Za-z0-9]/.test(stem)) continue;

      if (!resolvesRef(ref, fileDir, index)) {
        out.push({
          file,
          line: i + 1,
          ref,
          kind: ref.includes("/") ? "path" : "filename",
        });
      }
    }

    if (symbols !== null) scanSymbols(comment, symbols, file, i + 1, out);
  }
}

// Mine backtick-wrapped symbol-shaped tokens from a comment line and flag any
// that resolve to neither an export nor a local declaration.
function scanSymbols(
  comment: string,
  symbols: Set<string>,
  file: string,
  line: number,
  out: Finding[],
): void {
  for (const span of comment.matchAll(BACKTICK_RE)) {
    const inner = span[1];
    // Skip spans that are clearly not a single symbol: paths (handled above),
    // member access, generics, or multi-token prose.
    if (inner.includes("/") || inner.includes(".")) continue;
    const tok = SYMBOL_RE.exec(inner);
    if (tok === null) continue;
    const name = tok[1];
    const isCall = tok[2] === "(";
    // Require a strong symbol shape to keep prose out: either a call-paren
    // (`foo()`), or a mixed-case / underscored identifier (camelCase,
    // PascalCase, CONSTANT_CASE). A bare lowercase word stays prose.
    const distinctive = /[A-Z]/.test(name) || name.includes("_");
    if (!isCall && !distinctive) continue;
    if (name.length < 3) continue;
    if (SYMBOL_DENY.has(name)) continue;
    if (symbols.has(name)) continue;
    out.push({ file, line, ref: isCall ? `${name}()` : name, kind: "symbol" });
  }
}

function resolvesRef(ref: string, fileDir: string, index: RepoIndex): boolean {
  if (!ref.includes("/")) {
    return index.basenames.has(ref); // bare filename: exists anywhere?
  }
  // Direct filesystem resolution (handles ../ relative refs).
  const candidates = [
    ref, // from repo root / cwd
    join("src", ref), // src-relative
    resolve(fileDir, ref), // relative to the commenting file
  ];
  if (candidates.some(existsSync)) return true;
  // Suffix match: a partial path like `subsystems/banner.ts` resolves if
  // any real file path ends with `/<ref>` (or equals it).
  const needle = "/" + ref;
  return index.paths.some((p) => p === ref || p.endsWith(needle));
}

function collectIndex(roots: string[]): RepoIndex {
  const basenames = new Set<string>();
  const paths: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of walkSync(root, { includeDirs: false })) {
      basenames.add(entry.name);
      paths.push(entry.path.replaceAll("\\", "/"));
    }
  }
  for (const f of Deno.readDirSync(".")) {
    if (f.isFile) basenames.add(f.name);
  }
  return { basenames, paths };
}

// Build the symbol allow-set: every identifier that appears in non-comment
// code anywhere in the repo. Two sources, unioned:
//   - the export index (`.export-index.json`) — supplementary, may be stale;
//   - every identifier token in code (comments stripped) under `roots`.
// A symbol comment-ref is rot only if it appears in NEITHER — i.e. the name is
// unknown to the codebase. Library symbols (`InstancedMesh`), properties
// (`.castShadow`) and string keys (`"balloon_flight"`) all land in the set at
// their use sites, so only renamed-away names are flagged. Comments are
// stripped so a stale comment never vouches for its own dead reference.
function collectSymbols(roots: string[]): Set<string> {
  const symbols = new Set<string>();

  try {
    const index = JSON.parse(Deno.readTextFileSync(".export-index.json"));
    if (Array.isArray(index)) {
      for (const entry of index) {
        if (typeof entry?.name === "string") symbols.add(entry.name);
      }
    }
  } catch {
    // No index (or unreadable) — the token scan below stands alone.
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of walkSync(root, { exts: [".ts"], includeDirs: false })) {
      const code = stripComments(Deno.readTextFileSync(entry.path));
      for (const match of code.matchAll(IDENT_RE)) symbols.add(match[0]);
    }
  }
  return symbols;
}

// Blank out `//` line comments and `/* */` block comments, preserving newline
// count and non-comment text. Good enough for identifier mining (does not
// attempt to honor `//` inside string/regex literals — at worst that drops a
// real token from the allow-set, costing recall, never a false block).
function stripComments(text: string): string {
  let out = "";
  let inBlock = false;
  for (const raw of text.split("\n")) {
    if (inBlock) {
      const end = raw.indexOf("*/");
      if (end === -1) {
        out += "\n";
        continue;
      }
      out += raw.slice(end + 2) + "\n";
      inBlock = false;
      continue;
    }
    const block = raw.indexOf("/*");
    const line = raw.indexOf("//");
    if (block !== -1 && (line === -1 || block < line)) {
      const end = raw.indexOf("*/", block + 2);
      out +=
        end === -1
          ? raw.slice(0, block) + "\n"
          : raw.slice(0, block) + raw.slice(end + 2) + "\n";
      if (end === -1) inBlock = true;
    } else if (line !== -1) {
      out += raw.slice(0, line) + "\n";
    } else {
      out += raw + "\n";
    }
  }
  return out;
}

function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function report(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log("✓ no dead file/path/symbol references in comments");
    return;
  }
  const byRef = new Map<string, Finding[]>();
  for (const f of findings) {
    (byRef.get(f.ref) ?? byRef.set(f.ref, []).get(f.ref)!).push(f);
  }
  const sorted = [...byRef.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(
    `⚠ ${findings.length} dead-reference comment(s), ${byRef.size} distinct ref(s):\n`,
  );
  for (const [ref, fs] of sorted) {
    const tag = fs[0].kind === "symbol" ? " [symbol]" : "";
    console.log(`  ${ref}${tag}  (${fs.length}×)`);
    for (const f of fs.slice(0, 4)) {
      console.log(`      ${f.file}:${f.line}`);
    }
    if (fs.length > 4) console.log(`      … +${fs.length - 4} more`);
  }
  Deno.exit(1);
}
