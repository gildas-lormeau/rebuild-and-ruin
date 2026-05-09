/**
 * Base shape for the registry pool pattern.
 *
 * The four extension-point registries (features, upgrades, modifiers, cannon
 * modes) each declare a `*Def` interface with these four fields plus
 * registry-specific extras. Each one extends `PoolDef<Id>` to document the
 * shared shape and so the `IMPLEMENTED_X = X_POOL.filter(d => d.implemented)`
 * pattern reads against a known contract.
 *
 * See CLAUDE.md "Extension point registries" for the pattern rationale.
 */

export interface PoolDef<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  /** Whether gameplay code exists for this entry. Filtered out of random
   *  selection (draft offers, modifier roll) until set to true. */
  readonly implemented: boolean;
}
