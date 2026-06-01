/**
 * lint-comment-refs — deterministic comment-rot detector (zero LLM tokens).
 *
 * Scans comments in src/ for file/path references and flags any that no
 * longer resolve on disk. This is the dominant rot class: a comment naming
 * `runtime-banner.ts` after the file moved to `subsystems/banner.ts`.
 *
 * Detection only — does NOT judge semantic accuracy (that's the expensive
 * LLM tier). The point is to hand a small candidate list to a human/agent
 * instead of paying tokens to ingest the whole tree.
 *
 * Run: deno run -A scripts/lint-comment-refs.ts [--all]
 *   (default scans src/; --all scans src/ + test/ + scripts/ + dev/)
 */

import { walkSync } from "@std/fs";
import { dirname, join, resolve } from "@std/path";

interface Finding {
  file: string;
  line: number;
  ref: string;
  kind: "path" | "filename";
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

main();

function main(): void {
  const all = Deno.args.includes("--all");
  const roots = all ? ["src", "test", "scripts", "dev"] : ["src"];

  // Index every file in the repo so refs can be resolved by basename
  // (bare names) or path suffix (partial paths like `subsystems/banner.ts`).
  const index = collectIndex([
    "src",
    "test",
    "scripts",
    "dev",
    "server",
    "docs",
  ]);

  const findings: Finding[] = [];
  for (const root of roots) {
    for (const entry of walkSync(root, { exts: [".ts"], includeDirs: false })) {
      scanFile(entry.path, index, findings);
    }
  }

  report(findings);
}

function scanFile(file: string, index: RepoIndex, out: Finding[]): void {
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
    console.log("✓ no dead file/path references in comments");
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
    console.log(`  ${ref}  (${fs.length}×)`);
    for (const f of fs.slice(0, 4)) {
      console.log(`      ${f.file}:${f.line}`);
    }
    if (fs.length > 4) console.log(`      … +${fs.length - 4} more`);
  }
  Deno.exit(1);
}
