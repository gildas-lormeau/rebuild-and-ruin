/**
 * Tier is a function of layer — the 5 prescriptive partitions of the
 * 21-layer import graph (`types` / `logic` / `systems` / `assembly` /
 * `roots`). These boundaries are architectural decisions, stable
 * across refactors; storing them in JSON only created a sync burden
 * (drift between `.import-layers.json` and `.import-cells.json`).
 *
 * `lint-entry-placement.ts` reads tier to decide which layers hold true
 * entry points; the `audit-layer-*` scripts and `cell-lookup.ts` read it
 * for reporting. They import this helper instead of reading a JSON
 * `tier` field.
 *
 * The `assembly`/`roots` cut is the load-bearing one: `roots` means
 * composition roots (entry points, the runtime/online session wiring,
 * the AI default assembly), so it must stay a dozen files, not a
 * catch-all for "high layer".
 *
 * If the partition ever shifts (e.g. a new tier wedges in), update
 * both `Tier` and `tierOfLayer` here — it's a code change, not data.
 */

export type Tier = "types" | "logic" | "systems" | "assembly" | "roots";

export function tierOfLayer(layer: number): Tier {
  if (layer <= 4) return "types";
  if (layer <= 6) return "logic";
  if (layer <= 9) return "systems";
  if (layer <= 16) return "assembly";
  return "roots";
}
