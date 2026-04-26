/**
 * Source-map resolver.
 *
 * Deno emits TS files with embedded source maps (data: URIs in the
 * sourceMapURL field of `Debugger.scriptParsed`). V8's own source-map
 * resolution for `setBreakpointByUrl` produces broken column numbers for
 * cross-module TS files (returns positions like columnNumber=802, far
 * past line end, in some intermediate scope). To work around this we decode
 * the source maps ourselves, build a TS→JS reverse lookup, then call
 * `Debugger.setBreakpoint` with the resolved JS scriptId+line+col.
 *
 * Source map spec:
 *   https://sourcemaps.info/spec.html
 *
 * Mappings are base64-VLQ-encoded segments per generated line, separated
 * by ';'. Each segment has 1, 4, or 5 fields: genCol, sourceIndex,
 * sourceLine, sourceCol, [nameIndex]. All fields are deltas from the
 * previous segment in the same file (genCol resets each generated line).
 */

interface SourceMap {
  version: number;
  sources: string[];
  sourcesContent?: string[];
  mappings: string;
  sourceRoot?: string;
}

interface MappingSegment {
  genCol: number;
  sourceIndex: number;
  sourceLine: number;
  sourceCol: number;
}

interface JsPosition {
  genLine: number;
  genCol: number;
}

interface ResolvedSourceMap {
  jsScriptId: string;
  jsUrl: string;
  sources: string[];
  // For each source URL: map of source-line (0-indexed) → JS positions on
  // that source line, sorted by source col then gen position.
  reverseMap: Map<string, Map<number, JsPosition[]>>;
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < BASE64_CHARS.length; i++) m.set(BASE64_CHARS[i], i);
  return m;
})();

export class SourceMapResolver {
  private maps = new Map<string, ResolvedSourceMap>();

  addScript(
    scriptId: string,
    jsUrl: string,
    sourceMapURL: string | undefined,
  ): boolean {
    if (!sourceMapURL) return false;
    const sm = decodeSourceMapURL(sourceMapURL);
    if (!sm) return false;
    const sources = sm.sources.map((s) =>
      resolveSourceUrl(s, sm.sourceRoot ?? "", jsUrl),
    );
    const reverseMap = buildReverseMap(sm.mappings, sources);
    this.maps.set(scriptId, {
      jsScriptId: scriptId,
      jsUrl,
      sources,
      reverseMap,
    });
    return true;
  }

  /** Look up the first generated JS position for a (sourceUrl, sourceLine). */
  resolve(
    sourceUrl: string,
    sourceLine: number,
  ): { jsScriptId: string; jsLine: number; jsCol: number } | null {
    // Source line is 0-indexed in the map; callers pass 1-indexed user input,
    // they should convert. Match what the user gives us against any indexed
    // source URL.
    for (const [, m] of this.maps) {
      if (!m.sources.includes(sourceUrl)) continue;
      const positions = m.reverseMap.get(sourceUrl)?.get(sourceLine);
      if (!positions || positions.length === 0) continue;
      const p = positions[0];
      return { jsScriptId: m.jsScriptId, jsLine: p.genLine, jsCol: p.genCol };
    }
    return null;
  }

  /** Diagnostic: enumerate indexed source URLs (deduped). */
  knownSources(): string[] {
    const set = new Set<string>();
    for (const [, m] of this.maps) for (const s of m.sources) set.add(s);
    return [...set];
  }

  /** Has any indexed source map listed this URL as a source? Distinguishes
   *  "file we know about (parse-time)" from "file we've never seen". */
  hasSource(sourceUrl: string): boolean {
    for (const [, m] of this.maps) {
      if (m.sources.includes(sourceUrl)) return true;
    }
    return false;
  }

  /** Find the nearest source line that actually has at least one mapping
   *  segment, within ±range of the requested 0-indexed line. Useful when a
   *  user picks a line with no breakable code (comment, blank, multi-line
   *  expression continuation) — point them at a line that will fire.
   *  Returns null if nothing mapped within range. */
  nearestMappedLine(
    sourceUrl: string,
    sourceLine: number,
    range = 20,
  ): number | null {
    for (const [, m] of this.maps) {
      const perFile = m.reverseMap.get(sourceUrl);
      if (!perFile) continue;
      if (perFile.has(sourceLine)) return sourceLine;
      for (let d = 1; d <= range; d++) {
        if (perFile.has(sourceLine - d)) return sourceLine - d;
        if (perFile.has(sourceLine + d)) return sourceLine + d;
      }
    }
    return null;
  }
}

function decodeSourceMapURL(url: string): SourceMap | null {
  const m = url.match(/^data:application\/json(;[^,]*)?,(.+)$/);
  if (!m) return null;
  const isBase64 = (m[1] ?? "").includes("base64");
  let payload: string;
  try {
    payload = isBase64 ? atob(m[2]) : decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  try {
    return JSON.parse(payload) as SourceMap;
  } catch {
    return null;
  }
}

function resolveSourceUrl(
  source: string,
  sourceRoot: string,
  jsUrl: string,
): string {
  // Already absolute (file:// or http://).
  if (/^[a-z]+:\/\//i.test(source)) return source;
  const root = sourceRoot
    ? sourceRoot.endsWith("/")
      ? sourceRoot
      : `${sourceRoot}/`
    : "";
  const combined = `${root}${source}`;
  if (/^[a-z]+:\/\//i.test(combined)) return combined;
  // Resolve against jsUrl's directory.
  const slash = jsUrl.lastIndexOf("/");
  const base = slash > 0 ? jsUrl.slice(0, slash + 1) : jsUrl;
  return `${base}${combined}`;
}

function buildReverseMap(
  mappings: string,
  sources: string[],
): Map<string, Map<number, JsPosition[]>> {
  const out = new Map<string, Map<number, JsPosition[]>>();
  let genLine = 0;
  let genCol = 0;
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceCol = 0;
  const pos = { i: 0 };

  while (pos.i < mappings.length) {
    const c = mappings[pos.i];
    if (c === ";") {
      genLine++;
      genCol = 0;
      pos.i++;
      continue;
    }
    if (c === ",") {
      pos.i++;
      continue;
    }
    // Segment: 1, 4, or 5 VLQ values.
    genCol += decodeVlq(mappings, pos);
    if (segmentTerminated(mappings, pos)) {
      // 1-field segment: only generated col, no source mapping.
      continue;
    }
    sourceIndex += decodeVlq(mappings, pos);
    sourceLine += decodeVlq(mappings, pos);
    sourceCol += decodeVlq(mappings, pos);
    if (!segmentTerminated(mappings, pos)) {
      decodeVlq(mappings, pos); // optional name index — discard
    }
    const sourceUrl = sources[sourceIndex];
    if (!sourceUrl) continue;
    let perFile = out.get(sourceUrl);
    if (!perFile) {
      perFile = new Map();
      out.set(sourceUrl, perFile);
    }
    let perLine = perFile.get(sourceLine);
    if (!perLine) {
      perLine = [];
      perFile.set(sourceLine, perLine);
    }
    perLine.push({ genLine, genCol });
  }
  return out;
}

function segmentTerminated(mappings: string, pos: { i: number }): boolean {
  if (pos.i >= mappings.length) return true;
  const c = mappings[pos.i];
  return c === ";" || c === ",";
}

function decodeVlq(input: string, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  while (pos.i < input.length) {
    const ch = input[pos.i++];
    const digit = BASE64_INDEX.get(ch);
    if (digit === undefined)
      throw new Error(`invalid VLQ char "${ch}" at ${pos.i - 1}`);
    const cont = (digit & 32) !== 0;
    const value = digit & 31;
    result |= value << shift;
    shift += 5;
    if (!cont) break;
  }
  // Zigzag → signed.
  return result & 1 ? -(result >>> 1) : result >>> 1;
}
