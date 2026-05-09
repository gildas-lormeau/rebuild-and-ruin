import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Project, ScriptTarget, SyntaxKind } from "ts-morph";
import { classifyRef, type RefKind } from "./audit-optional-classifier.ts";

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
