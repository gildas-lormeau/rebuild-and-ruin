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
