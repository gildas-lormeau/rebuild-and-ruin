/**
 * Generic JS/TS utilities with no game-type dependencies.
 */

/**
 * Compile-time exhaustiveness check for switch/if-else on enums.
 * A missing case makes `value` a concrete enum member instead of `never`,
 * producing a type error at the call site.
 */

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function anyHookTrue<T>(
  reg: Iterable<T>,
  hookFn: (item: T) => unknown,
): boolean {
  for (const item of reg) if (hookFn(item)) return true;
  return false;
}

export function allHooksAllow<T>(
  reg: Iterable<T>,
  hookFn: (item: T) => boolean | undefined,
): boolean {
  for (const item of reg) {
    const result = hookFn(item);
    if (result !== undefined && !result) return false;
  }
  return true;
}

export function sumHooks<T>(
  reg: Iterable<T>,
  hookFn: (item: T) => number | undefined,
): number {
  let total = 0;
  for (const item of reg) total += hookFn(item) ?? 0;
  return total;
}

export function productHooks<T>(
  reg: Iterable<T>,
  hookFn: (item: T) => number | undefined,
): number {
  let product = 1;
  for (const item of reg) product *= hookFn(item) ?? 1;
  return product;
}

export function firstNonNullHook<T, R>(
  reg: Iterable<T>,
  hookFn: (item: T) => R | null | undefined,
): R | null {
  for (const item of reg) {
    const result = hookFn(item);
    if (result) return result;
  }
  return null;
}

export function forEachHook<T>(
  reg: Iterable<T>,
  hookFn: (item: T) => void,
): void {
  for (const item of reg) hookFn(item);
}

export function* mergeHookGenerators<T, R>(
  reg: Iterable<T>,
  hookFn: (item: T) => Generator<R, void> | undefined,
): Generator<R, void> {
  for (const item of reg) {
    const gen = hookFn(item);
    if (gen) yield* gen;
  }
}
