import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Project, ScriptTarget, SyntaxKind } from "ts-morph";
import {
  classifyProperty,
  classifyRef,
  type RefKind,
  type RefStats,
} from "./audit-optional-classifier.ts";

Deno.test("classifier: plain property access is unguarded read", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const x = obj.foo;
  `);
  assertEquals(kinds, ["read-unguarded"]);
});

Deno.test("classifier: object-literal property assignment is assign", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    const obj: Foo = { foo: "x" };
  `);
  assertEquals(kinds, ["assign"]);
});

Deno.test("classifier: shorthand property assignment is assign", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const foo: string;
    const obj: Foo = { foo };
  `);
  assertEquals(kinds, ["assign"]);
});

Deno.test("classifier: x = obj.foo on the LHS of = is assign", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    obj.foo = "y";
  `);
  assertEquals(kinds, ["assign"]);
});

Deno.test("classifier: destructure-without-default is guarded (type propagation)", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const { foo } = obj;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: destructure-with-default is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const { foo = "z" } = obj;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: optional chain on PAE (obj?.foo) is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo | undefined;
    const x = obj?.foo;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: optional chain on call (obj.foo?.()) is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: () => void }
    declare const obj: Foo;
    obj.foo?.();
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: nested optional chain (obj.foo?.bar) is guarded for foo", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: { bar: number } }
    declare const obj: Foo;
    const x = obj.foo?.bar;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: ?? RHS default makes obj.foo guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const x = obj.foo ?? "default";
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: || LHS makes obj.foo guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const x = obj.foo || "default";
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: if (obj.foo) {...} test is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    if (obj.foo) console.log("set");
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: typeof obj.foo is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const t = typeof obj.foo;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: delete obj.foo is delete", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    delete obj.foo;
  `);
  assertEquals(kinds, ["delete"]);
});

Deno.test("classifier: obj.foo === undefined is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    if (obj.foo === undefined) {}
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: obj.foo === null is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string | null }
    declare const obj: Foo;
    if (obj.foo === null) {}
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: !obj.foo anywhere is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    if (someCondition || !obj.foo) console.log("missing");
    declare const someCondition: boolean;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: !obj.foo as bare return value is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const isMissing = !obj.foo;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: type signature reference is type-only (skipped)", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    type Bar = Pick<Foo, "foo">;
    declare const x: Bar;
  `);
  // Pick<Foo, "foo"> references the property name as a type-level string;
  // ts-morph surfaces it as a string-literal type ref rather than an Identifier
  // through the symbol search, so it shouldn't appear in the classified list.
  assertEquals(kinds, []);
});

Deno.test("classifier: ternary test is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    const x = obj.foo ? "yes" : "no";
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: while (obj.foo) test is guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    while (obj.foo) break;
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: parenthesized (obj.foo) preserves guard analysis", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    if ((obj.foo)) console.log("yes");
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: const alias + !local guard counts as guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: { bar: number } }
    declare const obj: Foo;
    function f() {
      const local = obj.foo;
      if (!local) return;
      console.log(local.bar);
    }
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: const alias + if (local) guard counts as guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    function f() {
      const local = obj.foo;
      if (local) console.log(local);
    }
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: const alias + local === undefined counts as guarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    function f() {
      const local = obj.foo;
      if (local === undefined) return;
      console.log(local);
    }
  `);
  assertEquals(kinds, ["read-guarded"]);
});

Deno.test("classifier: const alias with no defensive use stays unguarded", () => {
  const kinds = classifyAllRefs(`
    interface Foo { foo?: string }
    declare const obj: Foo;
    function f() {
      const local = obj.foo;
      console.log(local);
    }
  `);
  assertEquals(kinds, ["read-unguarded"]);
});

Deno.test("classifier: const alias with destructured RHS skips alias check", () => {
  // \`const { x } = obj.foo\` — the binding is a pattern, not a name; we don't
  // try to track per-field guards. Still classifies as unguarded since no
  // direct guard pattern wraps obj.foo.
  const kinds = classifyAllRefs(`
    interface Foo { foo?: { x: number } }
    declare const obj: Foo;
    function f() {
      const { x } = obj.foo!;
      console.log(x);
    }
  `);
  assertEquals(kinds, ["read-unguarded"]);
});

Deno.test("classifyProperty: 0 assigns + 0 reads + clean = dead", () => {
  assertEquals(classifyProperty(stats(), 0, 0, 0), "dead");
});

Deno.test("classifyProperty: 0 assigns + 0 reads + extra ident matches = suspicious-dead", () => {
  // One name-collision elsewhere → demote (likely a sibling type with the same
  // field name, ts-morph's symbol search missed it).
  assertEquals(classifyProperty(stats(), 0, 1, 0), "suspicious-dead");
});

Deno.test("classifyProperty: assigns + 0 reads + clean = write-only", () => {
  assertEquals(classifyProperty(stats(2, 0, 0), 0, 2, 0), "write-only");
});

Deno.test("classifyProperty: assigns + 0 reads + extra ident matches = suspicious-write-only", () => {
  assertEquals(
    classifyProperty(stats(2, 0, 0), 0, 5, 0),
    "suspicious-write-only",
  );
});

Deno.test("classifyProperty: 0 assigns + reads = read-only", () => {
  assertEquals(classifyProperty(stats(0, 0, 1), 0, 1, 0), "read-only");
});

Deno.test("classifyProperty: assigns + guarded reads = truly-optional", () => {
  assertEquals(classifyProperty(stats(1, 1, 0), 0, 2, 1), "truly-optional");
});

Deno.test("classifyProperty: assigns + only unguarded reads + all sites set = fake-optional", () => {
  // 1 assign + 1 unguarded read = 2 stringMatches accounted for, 0 unaccounted.
  // 1 construction site, 0 omitted. The clean fake-optional path.
  assertEquals(classifyProperty(stats(1, 0, 1), 0, 2, 1), "fake-optional");
});

Deno.test("classifyProperty: fake-optional pattern + omittedAt > 0 = ambiguous-fake", () => {
  // Construction site omits the field — dropping `?` would tsc-error. Demote.
  assertEquals(classifyProperty(stats(1, 0, 1), 1, 2, 2), "ambiguous-fake");
});

Deno.test("classifyProperty: fake-optional pattern + unaccounted matches = ambiguous-fake (structural-typing case)", () => {
  // 1 assign + 1 unguarded read = 2 accounted; 5 stringMatches → 3 unaccounted.
  // No omissions. The Cannonball.scoringPlayerId case: read via a structurally-
  // typed helper (`getScoringPlayer(ball)`) that the symbol search can't see
  // through, so the `??` guard inside the helper isn't counted. Demote.
  assertEquals(classifyProperty(stats(1, 0, 1), 0, 5, 1), "ambiguous-fake");
});

Deno.test("classifyProperty: settingSites > assigns counts as effectively-assigned (wire DTO case)", () => {
  // `FullStateMessage`-style wire field: ts-morph misses the assign through
  // contextual typing, but the construction-site walk found 3 literals that
  // all set the field. Should be treated as written, not write-only.
  // 0 symbol assigns, 1 unguarded read, 3 sites all set, stringMatches matches
  // (1 read accounted). Treated as fake-optional, not read-only.
  assertEquals(classifyProperty(stats(0, 0, 1), 0, 1, 3), "fake-optional");
});

function stats(assigns = 0, guarded = 0, unguarded = 0): RefStats {
  return { assigns, guardedReads: guarded, unguardedReads: unguarded };
}

/** Spin up an in-memory project, find references to `Foo.foo`, classify each
 *  non-declaration reference. Returns the list of RefKinds in source order
 *  so a single test can assert "the patterns in this file all classify as X".
 *  The fixture must declare `interface Foo { foo?: ... }` and `declare const
 *  obj: Foo;` (or similar with the same shape); the test source then exercises
 *  whatever pattern is under test. */
function classifyAllRefs(testSource: string): RefKind[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: ScriptTarget.ES2022,
    },
  });
  const sf = project.createSourceFile("test.ts", testSource);
  const iface = sf.getInterface("Foo");
  if (!iface) throw new Error("test fixture must declare `interface Foo`");
  const member = iface.getProperty("foo") ?? iface.getMethod("foo");
  if (!member) throw new Error("test fixture must declare `foo?` on Foo");
  const declId = member.getNameNode().asKindOrThrow(SyntaxKind.Identifier);
  const refs = declId.findReferencesAsNodes();
  return refs.filter((ref) => ref !== declId).map(classifyRef);
}
