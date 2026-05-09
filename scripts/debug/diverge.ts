/**
 * First-divergence finder for partitioned trace hits.
 *
 * `debug diverge` (cli.ts) hands a TraceHit[] plus options here and gets back
 * a structured report — partitions, per-field firstDivergentRow ordering, and
 * a context window around the pivot. Pure transformation; no I/O. Lives in
 * its own module so the math is testable from a fixture without spinning up
 * a CDP session.
 *
 * Inputs are TraceHit-shaped — we declare a minimal structural type locally
 * (only `values` actually matters for divergence math; file/line are kept
 * for diagnostic output) so this module has no import dependency on cli.ts.
 */

export interface DivergeHit {
  file: string;
  line: number;
  values: Record<string, unknown>;
}

export interface DivergeOptions {
  partitionExpr: string;
  alignBy?: string;
  ignore?: RegExp[];
  contextN?: number;
}

export interface FieldDivergence {
  field: string;
  firstDivergentRow: number;
  values: Record<string, unknown>;
}

export interface SkippedRow {
  alignKey: string;
  missingFrom: string;
}

export interface DivergeReport {
  partitions: string[];
  rowsPerPartition: Record<string, number>;
  alignment: string;
  firstDivergentRow: number | null;
  lastSharedRow: number | null;
  perField: FieldDivergence[];
  context?: {
    before: Array<{ row: number; values: Record<string, unknown> }>;
    at: { row: number; byPartition: Record<string, Record<string, unknown>> };
    after: Array<{
      row: number;
      byPartition: Record<string, Record<string, unknown>>;
    }>;
  };
  skippedRows?: SkippedRow[];
  error?: string;
}

interface Pair {
  a: DivergeHit;
  b: DivergeHit;
}

/** Compute the first cross-partition divergence in a trace. Output is sorted
 *  per-field by ascending `firstDivergentRow` so the agent reads upstream
 *  causes before downstream symptoms. */
export function buildDivergenceReport(
  hits: DivergeHit[],
  options: DivergeOptions,
): DivergeReport {
  const { partitionExpr, alignBy, ignore = [], contextN = 3 } = options;
  const partitions = groupByPartition(hits, partitionExpr);
  const partitionKeys = [...partitions.keys()].sort();
  const alignment = alignBy ? `byAlignKey:${alignBy}` : "byIndex";

  if (partitions.size < 2) {
    return {
      partitions: partitionKeys,
      rowsPerPartition: rowsPerPartition(partitions),
      alignment,
      firstDivergentRow: null,
      lastSharedRow: null,
      perField: [],
      error: `expected ≥2 partitions, got ${partitions.size}; verify both peers captured ${partitionExpr}`,
    };
  }
  if (partitions.size > 2) {
    throw new Error(
      `diverge currently supports exactly 2 partitions, got ${partitions.size} (${partitionKeys.join(", ")})`,
    );
  }

  const [aKey, bKey] = partitionKeys;
  const a = partitions.get(aKey) as DivergeHit[];
  const b = partitions.get(bKey) as DivergeHit[];
  const aligned = alignBy
    ? alignByKey(a, b, alignBy, aKey, bKey)
    : alignByIndex(a, b);

  const perField = computePerField(
    aligned.pairs,
    partitionExpr,
    ignore,
    aKey,
    bKey,
  );
  const firstDivergentRow =
    perField.length > 0
      ? Math.min(...perField.map((f) => f.firstDivergentRow))
      : null;
  const lastSharedRow =
    firstDivergentRow === null
      ? aligned.pairs.length > 0
        ? aligned.pairs.length - 1
        : null
      : firstDivergentRow > 0
        ? firstDivergentRow - 1
        : null;

  const context =
    firstDivergentRow !== null
      ? buildContext(
          aligned.pairs,
          firstDivergentRow,
          contextN,
          partitionExpr,
          aKey,
          bKey,
        )
      : undefined;

  return {
    partitions: [aKey, bKey],
    rowsPerPartition: { [aKey]: a.length, [bKey]: b.length },
    alignment,
    firstDivergentRow,
    lastSharedRow,
    perField,
    ...(context ? { context } : {}),
    ...(aligned.skipped.length > 0 ? { skippedRows: aligned.skipped } : {}),
  };
}

function groupByPartition(
  hits: DivergeHit[],
  expr: string,
): Map<string, DivergeHit[]> {
  const out = new Map<string, DivergeHit[]>();
  for (const h of hits) {
    const key = formatValue(h.values[expr]);
    let bucket = out.get(key);
    if (!bucket) {
      bucket = [];
      out.set(key, bucket);
    }
    bucket.push(h);
  }
  return out;
}

function rowsPerPartition(
  partitions: Map<string, DivergeHit[]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of partitions) out[k] = v.length;
  return out;
}

function alignByIndex(
  a: DivergeHit[],
  b: DivergeHit[],
): { pairs: Pair[]; skipped: SkippedRow[] } {
  const len = Math.min(a.length, b.length);
  const pairs: Pair[] = [];
  for (let i = 0; i < len; i++) pairs.push({ a: a[i], b: b[i] });
  return { pairs, skipped: [] };
}

function alignByKey(
  a: DivergeHit[],
  b: DivergeHit[],
  alignBy: string,
  aKey: string,
  bKey: string,
): { pairs: Pair[]; skipped: SkippedRow[] } {
  const aIndex = new Map<string, DivergeHit>();
  for (const h of a) {
    const k = formatValue(h.values[alignBy]);
    if (!aIndex.has(k)) aIndex.set(k, h);
  }
  const bIndex = new Map<string, DivergeHit>();
  for (const h of b) {
    const k = formatValue(h.values[alignBy]);
    if (!bIndex.has(k)) bIndex.set(k, h);
  }
  const pairs: Pair[] = [];
  const skipped: SkippedRow[] = [];
  // Iterate a's arrival order so the resulting row indices read intuitively
  // ("row 0" = a's first aligned key). Skipped rows from either side land in
  // a single list so the agent sees both directions of drift.
  const seen = new Set<string>();
  for (const h of a) {
    const key = formatValue(h.values[alignBy]);
    if (seen.has(key)) continue;
    seen.add(key);
    const counterpart = bIndex.get(key);
    if (counterpart) pairs.push({ a: h, b: counterpart });
    else skipped.push({ alignKey: key, missingFrom: bKey });
  }
  for (const h of b) {
    const key = formatValue(h.values[alignBy]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!aIndex.has(key)) skipped.push({ alignKey: key, missingFrom: aKey });
  }
  return { pairs, skipped };
}

function computePerField(
  pairs: Pair[],
  partitionExpr: string,
  ignore: RegExp[],
  aKey: string,
  bKey: string,
): FieldDivergence[] {
  const firstSeen = new Map<string, FieldDivergence>();
  for (let i = 0; i < pairs.length; i++) {
    const { a, b } = pairs[i];
    const keys = unionKeys(a.values, b.values, partitionExpr, ignore);
    for (const k of keys) {
      if (firstSeen.has(k)) continue;
      const av = a.values[k];
      const bv = b.values[k];
      if (formatValue(av) !== formatValue(bv)) {
        firstSeen.set(k, {
          field: k,
          firstDivergentRow: i,
          values: { [aKey]: av, [bKey]: bv },
        });
      }
    }
  }
  return [...firstSeen.values()].sort(
    (x, y) => x.firstDivergentRow - y.firstDivergentRow,
  );
}

function unionKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  partitionExpr: string,
  ignore: RegExp[],
): string[] {
  const set = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  set.delete(partitionExpr);
  return [...set].filter((k) => !ignore.some((re) => re.test(k))).sort();
}

function buildContext(
  pairs: Pair[],
  pivot: number,
  n: number,
  partitionExpr: string,
  aKey: string,
  bKey: string,
): NonNullable<DivergeReport["context"]> {
  const stripPart = (v: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (k !== partitionExpr) out[k] = v[k];
    }
    return out;
  };
  const before: Array<{ row: number; values: Record<string, unknown> }> = [];
  for (let i = Math.max(0, pivot - n); i < pivot; i++) {
    before.push({ row: i, values: stripPart(pairs[i].a.values) });
  }
  const after: NonNullable<DivergeReport["context"]>["after"] = [];
  for (let i = pivot + 1; i < Math.min(pairs.length, pivot + 1 + n); i++) {
    after.push({
      row: i,
      byPartition: {
        [aKey]: stripPart(pairs[i].a.values),
        [bKey]: stripPart(pairs[i].b.values),
      },
    });
  }
  return {
    before,
    at: {
      row: pivot,
      byPartition: {
        [aKey]: stripPart(pairs[pivot].a.values),
        [bKey]: stripPart(pairs[pivot].b.values),
      },
    },
    after,
  };
}

function formatValue(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
