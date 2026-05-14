/**
 * Tier is a function of layer — the 5 prescriptive partitions of the
 * 19-layer import graph (`types` / `logic` / `systems` / `assembly` /
 * `roots`). These boundaries are architectural decisions, stable
 * across refactors; storing them in JSON only created a sync burden
 * (drift between `.import-layers.json` and `.import-cells.json`).
 *
 * Two lint scripts read tier for the "roots-tier exemption" rule
 * (composition roots can value-import across domain boundaries) and
 * for entry-placement enforcement. They import this helper instead of
 * reading a JSON `tier` field.
 *
 * If the partition ever shifts (e.g. a new tier wedges in), update
 * both `Tier` and `tierOfLayer` here — it's a code change, not data.
 */

export type Tier = "types" | "logic" | "systems" | "assembly" | "roots";

export function tierOfLayer(layer: number): Tier {
  if (layer <= 4) return "types";
  if (layer <= 6) return "logic";
  if (layer <= 9) return "systems";
  if (layer <= 13) return "assembly";
  return "roots";
}
