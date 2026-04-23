/**
 * Analyze a V8 `.heapsnapshot` captured by the E2E perf API
 * (`sc.perf.heapSnapshot`). Reports the top 40 constructors (or node
 * types) by aggregated self-size, so instance-count explosions jump
 * out — e.g. `MeshStandardMaterial: 664` or `_Matrix3: 16,690`.
 *
 * Self-size is the bytes the object occupies directly, not the graph
 * it retains. Good enough to spot category bloat; DevTools' Memory
 * panel has the retainer graph for the deep dive.
 *
 * Snapshot format: `nodes` is a flat int array with stride =
 * `meta.node_fields.length`. `type` + `name` are indexes into
 * `strings` and `meta.node_types[0]`.
 *
 * Usage: `deno run -A scripts/analyze-heap.ts [path]`
 * Default path: `tmp/perf/heap.heapsnapshot`.
 */

interface HeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: [string[], ...unknown[]];
    };
    node_count: number;
  };
  nodes: number[];
  strings: string[];
}

const path = Deno.args[0] ?? "tmp/perf/heap.heapsnapshot";
const raw = await Deno.readTextFile(path);
const snap = JSON.parse(raw) as HeapSnapshot;
const fields = snap.snapshot.meta.node_fields;
const typeIdx = fields.indexOf("type");
const nameIdx = fields.indexOf("name");
const sizeIdx = fields.indexOf("self_size");
const stride = fields.length;
const typeNames = snap.snapshot.meta.node_types[0];
const strings = snap.strings;
const sizeByLabel = new Map<string, { count: number; size: number }>();
const ranked = [...sizeByLabel.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 40);

let totalSize = 0;

console.log("Reading heap snapshot…");

console.log(`Raw size: ${(raw.length / 1024 / 1024).toFixed(1)} MB. Parsing…`);

console.log(
  `Nodes: ${snap.snapshot.node_count.toLocaleString()}, stride=${stride}`,
);

for (let offset = 0; offset < snap.nodes.length; offset += stride) {
  const type = typeNames[snap.nodes[offset + typeIdx]];
  const name = strings[snap.nodes[offset + nameIdx]] ?? "";
  const size = snap.nodes[offset + sizeIdx];
  totalSize += size;
  // Bucket: "object" nodes get their constructor name; non-objects get
  // the type alone (string, closure, hidden, …).
  const label = type === "object" ? `${name || "(no name)"}` : `[${type}]`;
  const bucket = sizeByLabel.get(label) ?? { count: 0, size: 0 };
  bucket.count++;
  bucket.size += size;
  sizeByLabel.set(label, bucket);
}

console.log(`Total self-size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

console.log();

console.log("Top 40 constructors/types by self-size:");

console.log(
  `  ${"size(MB)".padStart(9)} ${"%".padStart(6)} ${"count".padStart(10)}  label`,
);

for (const [label, bucket] of ranked) {
  console.log(
    `  ${(bucket.size / 1024 / 1024).toFixed(2).padStart(9)} ${((100 * bucket.size) / totalSize).toFixed(2).padStart(6)} ${bucket.count.toLocaleString().padStart(10)}  ${label}`,
  );
}
