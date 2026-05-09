/**
 * Base shape for the four extension-point registries (features, upgrades,
 * modifiers, cannon modes). Each `*Def` extends this; the
 * `IMPLEMENTED_X = X_POOL.filter(d => d.implemented)` pattern reads against
 * the shared contract. See CLAUDE.md "Extension point registries".
 */

export interface PoolDef<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  /** Whether gameplay code exists for this entry. Filtered out of random
   *  selection (draft offers, modifier roll) until set to true. */
  readonly implemented: boolean;
}
