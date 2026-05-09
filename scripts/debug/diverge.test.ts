import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDivergenceReport, type DivergeHit } from "./diverge.ts";

Deno.test("diverge: per-field firstDivergentRow ordering — upstream cause before downstream symptom", () => {
  // host vs watcher; rng diverges first (row 2), scores diverges later (row 4).
  // The agent reads perField top-to-bottom and gets cause before symptom.
  const hits: DivergeHit[] = [
    hit({ tag: "host", rng: 7, scores: 0 }),
    hit({ tag: "watcher", rng: 7, scores: 0 }),
    hit({ tag: "host", rng: 8, scores: 0 }),
    hit({ tag: "watcher", rng: 8, scores: 0 }),
    hit({ tag: "host", rng: 9, scores: 0 }),
    hit({ tag: "watcher", rng: 10, scores: 0 }), // rng diverges (pair index 2)
    hit({ tag: "host", rng: 11, scores: 0 }),
    hit({ tag: "watcher", rng: 12, scores: 0 }),
    hit({ tag: "host", rng: 13, scores: 100 }),
    hit({ tag: "watcher", rng: 14, scores: 200 }), // scores diverges (pair index 4)
  ];
  const report = buildDivergenceReport(hits, { partitionExpr: "tag" });
  assertEquals(report.firstDivergentRow, 2);
  assertEquals(report.lastSharedRow, 1);
  assertEquals(report.perField.length, 2);
  assertEquals(report.perField[0].field, "rng");
  assertEquals(report.perField[0].firstDivergentRow, 2);
  assertEquals(report.perField[1].field, "scores");
  assertEquals(report.perField[1].firstDivergentRow, 4);
});

Deno.test("diverge: agreeing partitions yield no divergence; lastSharedRow = last pair", () => {
  const hits: DivergeHit[] = [
    hit({ tag: "host", x: 1 }),
    hit({ tag: "watcher", x: 1 }),
    hit({ tag: "host", x: 2 }),
    hit({ tag: "watcher", x: 2 }),
  ];
  const report = buildDivergenceReport(hits, { partitionExpr: "tag" });
  assertEquals(report.firstDivergentRow, null);
  assertEquals(report.perField, []);
  assertEquals(report.lastSharedRow, 1);
  assertEquals(report.context, undefined);
});

Deno.test("diverge: pair-zero divergence — lastSharedRow is null", () => {
  const hits: DivergeHit[] = [
    hit({ tag: "host", x: 1 }),
    hit({ tag: "watcher", x: 2 }),
  ];
  const report = buildDivergenceReport(hits, { partitionExpr: "tag" });
  assertEquals(report.firstDivergentRow, 0);
  assertEquals(report.lastSharedRow, null);
});

Deno.test("diverge: < 2 partitions returns error string, no throw", () => {
  const report = buildDivergenceReport([hit({ tag: "host", x: 1 })], {
    partitionExpr: "tag",
  });
  assertEquals(report.firstDivergentRow, null);
  assertEquals(report.error?.startsWith("expected ≥2 partitions"), true);
});

Deno.test("diverge: --ignore drops cosmetic fields from comparison", () => {
  const hits: DivergeHit[] = [
    hit({ tag: "host", core: 1, wobble: 0.1 }),
    hit({ tag: "watcher", core: 1, wobble: 0.9 }), // wobble differs but is ignored
  ];
  const report = buildDivergenceReport(hits, {
    partitionExpr: "tag",
    ignore: [/wobble/],
  });
  assertEquals(report.firstDivergentRow, null);
});

Deno.test("diverge: --align-by pairs by logical key, reports skipped rows", () => {
  // host has ticks 1,2,3; watcher has 1,3 (missing 2). At tick 3 the value differs.
  const hits: DivergeHit[] = [
    hit({ tag: "host", tick: 1, x: "a" }),
    hit({ tag: "watcher", tick: 1, x: "a" }),
    hit({ tag: "host", tick: 2, x: "b" }),
    hit({ tag: "host", tick: 3, x: "c" }),
    hit({ tag: "watcher", tick: 3, x: "DIFFERENT" }),
  ];
  const report = buildDivergenceReport(hits, {
    partitionExpr: "tag",
    alignBy: "tick",
  });
  assertEquals(report.firstDivergentRow, 1);
  assertEquals(report.skippedRows?.length, 1);
  assertEquals(report.skippedRows?.[0].missingFrom, "watcher");
  assertEquals(report.skippedRows?.[0].alignKey, "2");
  assertEquals(report.alignment, "byAlignKey:tick");
});

Deno.test("diverge: context window respects --context N", () => {
  const hits: DivergeHit[] = [];
  for (let i = 0; i < 10; i++) {
    hits.push(hit({ tag: "host", x: i }));
    hits.push(hit({ tag: "watcher", x: i === 5 ? 999 : i }));
  }
  const report = buildDivergenceReport(hits, {
    partitionExpr: "tag",
    contextN: 2,
  });
  assertEquals(report.firstDivergentRow, 5);
  assertEquals(report.context?.before.length, 2);
  assertEquals(report.context?.after.length, 2);
  assertEquals(report.context?.at.row, 5);
});

function hit(values: Record<string, unknown>): DivergeHit {
  return { file: "fixture.ts", line: 1, values };
}
