/**
 * Detect JSDoc comments that add zero information beyond the identifier
 * name, and oversized file-level JSDoc headers.
 *
 * Two patterns:
 *
 * RESTATES_NAME — JSDoc whose entire description is a paraphrase of the
 *   identifier it documents. Caught by tokenising the description (drop
 *   stopwords, drop boilerplate doc verbs, drop tokens already present
 *   in the identifier name) and counting the remaining novel words. If
 *   the count is below the threshold (default 1), the comment carries
 *   no information the type/name doesn't already convey.
 *
 *     /** Reset all state for a new game. *\/        // 0 novel
 *     reset(): void;
 *
 *     /** The seeded PRNG used for online determinism. *\/  // 1 novel ("seeded")
 *     readonly rng: SeededRng;
 *
 * FILE_HEADER_WALL — Module-level JSDoc above the first statement that
 *   exceeds N lines (default 8). Catches ASCII state-machine diagrams,
 *   coordinate legends, and refactor-history walls — all guaranteed to
 *   drift away from the code beneath them.
 *
 * Skips (won't flag):
 *   - JSDoc carrying any `@tag` (param/returns/throws/deprecated/see/
 *     example/template/typeparam/internal/...). Tags are treated as
 *     evidence the author wanted to record something the name can't.
 *   - JSDoc containing code fences (```), markdown links `[text](url)`,
 *     bullet lists, or tables — likely intentional explanation.
 *   - File-header JSDoc that contains a tag (e.g. @file, @module).
 *
 * Usage:
 *   deno run -A scripts/lint-internal-jsdoc.ts [options]
 *
 * Options:
 *   --server                      Include server/ files
 *   --test                        Include test/ files
 *   --update-baseline             Write current detections to baseline
 *   --header-max=<n>              Max lines for file-header JSDoc (default 8)
 *   --restates-novel-max=<n>      Max novel words allowed (default 1)
 *
 * Baseline: .internal-jsdoc-baseline.json — entries are "file:line:pattern".
 *
 * Exits 1 if non-baselined violations or stale baseline entries are found.
 */

import fs from "node:fs";
import process from "node:process";
import { Node, Project, type SourceFile } from "ts-morph";

interface Finding {
  file: string;
  line: number;
  pattern: "RESTATES_NAME" | "FILE_HEADER_WALL";
  identifier: string;
  detail: string;
}

const BASELINE_FILE = ".internal-jsdoc-baseline.json";
const STOPWORDS = new Set([
  // articles / determiners
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "all",
  "any",
  "each",
  "every",
  // prepositions
  "of",
  "for",
  "to",
  "from",
  "in",
  "on",
  "at",
  "with",
  "by",
  "as",
  "into",
  "via",
  "per",
  "between",
  "across",
  "over",
  "under",
  "above",
  "below",
  // conjunctions
  "and",
  "or",
  "but",
  "so",
  "if",
  "when",
  "while",
  "whether",
  // pronouns
  "it",
  "its",
  "them",
  "they",
  "their",
  "we",
  "our",
  "you",
  "your",
  // common verbs that just describe what code does
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "having",
  "does",
  "do",
  "did",
  "doing",
  "returns",
  "return",
  "returning",
  "gets",
  "get",
  "getting",
  "fetches",
  "fetch",
  "fetching",
  "sets",
  "set",
  "setting",
  "creates",
  "create",
  "creating",
  "constructs",
  "construct",
  "computes",
  "compute",
  "computing",
  "calculates",
  "calculate",
  "calculating",
  "checks",
  "check",
  "checking",
  "called",
  "calls",
  "calling",
  "uses",
  "used",
  "using",
  "applied",
  "applies",
  "apply",
  "applying",
  "stores",
  "store",
  "stored",
  "storing",
  "reads",
  "read",
  "reading",
  "writes",
  "write",
  "wrote",
  "writing",
  "true",
  "false",
  "null",
  "undefined",
  // boilerplate doc nouns
  "value",
  "values",
  "function",
  "method",
  "property",
  "variable",
  "constant",
  "type",
  "interface",
  "field",
  "argument",
  "parameter",
  "result",
  "object",
  "instance",
  "implementation",
  "version",
  "callback",
  "handler",
  // qualifiers
  "current",
  "currently",
  "new",
  "old",
  "also",
  "only",
  "just",
  "still",
  "yet",
  "thus",
  "then",
  "now",
  "here",
  "there",
  "where",
  // demonstratives often used in doc prose
  "given",
  "such",
  "same",
  "other",
  "another",
]);
const TAG_PATTERN = /(^|\n)\s*\*?\s*@\w+/;
const CODE_FENCE = /```/;
const MARKDOWN_LINK = /\[[^\]]+\]\([^)]+\)/;
const BULLET_LIST = /(^|\n)\s*\*?\s*[-*+]\s/;
const TABLE_ROW = /\n\s*\*?\s*\|.*\|/;

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const updateBaseline = args.includes("--update-baseline");
  const headerMax = parseIntArg(args, "--header-max", 8);
  const novelMax = parseIntArg(args, "--restates-novel-max", 1);

  const baseline = loadBaseline();
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  const findings: Finding[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;

    scanFileHeader(sourceFile, relPath, headerMax, findings);
    scanDeclarations(sourceFile, relPath, novelMax, findings);
  }

  if (updateBaseline) {
    const keys = findings.map(findingKey).sort();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(keys, null, 2) + "\n");
    console.log(`✔ Wrote ${keys.length} entries to ${BASELINE_FILE}`);
    process.exit(0);
  }

  const newViolations = findings.filter((f) => !baseline.has(findingKey(f)));
  const currentKeys = new Set(findings.map(findingKey));
  const staleEntries = [...baseline].filter((key) => !currentKeys.has(key));

  const fileCount = project.getSourceFiles().length;

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselined = findings.length;
    const suffix = baselined > 0 ? `, ${baselined} baselined` : "";
    console.log(
      `✔ No internal-JSDoc rot (${fileCount} files checked${suffix})`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    const restates = newViolations.filter((f) => f.pattern === "RESTATES_NAME");
    const headers = newViolations.filter(
      (f) => f.pattern === "FILE_HEADER_WALL",
    );

    if (restates.length > 0) {
      console.log(
        `✘ ${restates.length} JSDoc comment(s) restate the identifier:\n`,
      );
      for (const f of restates) {
        console.log(`  ${f.file}:${f.line}: \`${f.identifier}\` — ${f.detail}`);
      }
    }
    if (headers.length > 0) {
      console.log(
        `\n✘ ${headers.length} file-header JSDoc wall(s) over ${headerMax} lines:\n`,
      );
      for (const f of headers) {
        console.log(`  ${f.file}:${f.line}: ${f.detail}`);
      }
    }
  }

  if (staleEntries.length > 0) {
    console.log(
      `\n✘ ${staleEntries.length} stale baseline entry/entries (remove from ${BASELINE_FILE}):\n`,
    );
    for (const key of staleEntries) console.log(`  ${key}`);
  }

  process.exit(1);
}

function scanFileHeader(
  sf: SourceFile,
  file: string,
  headerMax: number,
  out: Finding[],
): void {
  const firstStmt = sf.getStatements()[0];
  if (!firstStmt) return;
  for (const range of firstStmt.getLeadingCommentRanges()) {
    const text = range.getText();
    if (!text.startsWith("/**")) continue;
    if (TAG_PATTERN.test(text)) return; // module tag — leave alone
    const lines = text.split("\n").length;
    if (lines <= headerMax) return;
    out.push({
      file,
      line: sf.getLineAndColumnAtPos(range.getPos()).line,
      pattern: "FILE_HEADER_WALL",
      identifier: "<file header>",
      detail: `${lines} lines (limit ${headerMax})`,
    });
    return;
  }
}

function scanDeclarations(
  sf: SourceFile,
  file: string,
  novelMax: number,
  out: Finding[],
): void {
  sf.forEachDescendant((node) => {
    const docs = getJSDocs(node);
    if (docs.length === 0) return;
    const name = getDeclName(node);
    if (!name) return;
    for (const doc of docs) {
      const docText = doc.getText();
      if (!isCheckable(docText)) continue;
      const description = extractDescription(docText);
      if (description.length === 0) continue;
      const novel = countNovelWords(description, name);
      if (novel <= novelMax) {
        out.push({
          file,
          line: doc.getStartLineNumber(),
          pattern: "RESTATES_NAME",
          identifier: name,
          detail: `${novel} novel word(s) — ${truncate(description, 60)}`,
        });
      }
    }
  });
}

function getJSDocs(
  node: Node,
): { getText: () => string; getStartLineNumber: () => number }[] {
  const candidate = node as { getJsDocs?: () => unknown[] };
  if (typeof candidate.getJsDocs !== "function") return [];
  return candidate.getJsDocs() as {
    getText: () => string;
    getStartLineNumber: () => number;
  }[];
}

function getDeclName(node: Node): string | null {
  if (Node.isVariableStatement(node)) {
    const decls = node.getDeclarations();
    if (decls.length === 1) return decls[0].getName();
    return decls.map((decl) => decl.getName()).join(",");
  }
  const named = node as { getName?: () => string | undefined };
  if (typeof named.getName === "function") {
    const value = named.getName();
    if (value && value.length > 0) return value;
  }
  return null;
}

function isCheckable(jsdocText: string): boolean {
  if (TAG_PATTERN.test(jsdocText)) return false;
  if (CODE_FENCE.test(jsdocText)) return false;
  if (MARKDOWN_LINK.test(jsdocText)) return false;
  if (BULLET_LIST.test(jsdocText)) return false;
  if (TABLE_ROW.test(jsdocText)) return false;
  return true;
}

function extractDescription(jsdocText: string): string {
  return jsdocText
    .replace(/^\/\*\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .trim();
}

function countNovelWords(description: string, identifier: string): number {
  const idTokens = new Set(splitCamel(identifier));
  let novel = 0;
  for (const token of tokenize(description)) {
    if (STOPWORDS.has(token)) continue;
    if (idTokens.has(token)) continue;
    if (idTokens.has(stripPlural(token))) continue;
    if (idTokens.has(token + "s")) continue;
    novel++;
  }
  return novel;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 1);
}

function splitCamel(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((tok) => tok.length > 0);
}

function stripPlural(word: string): string {
  if (word.endsWith("ies") && word.length > 3) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 2) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 1) return word.slice(0, -1);
  return word;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function findingKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.pattern}:${f.identifier}`;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as string[],
  );
}

function parseIntArg(args: string[], flag: string, fallback: number): number {
  const prefix = `${flag}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number.parseInt(found.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
