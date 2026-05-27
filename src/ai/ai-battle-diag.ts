/**
 * AI battle-phase diagnostic hook. Mirrors `ai-build-diag.ts`: emit-on-
 * decision via a global hook installed by test observers (narrative,
 * survival runner). Production cost = 1 branch. Lets the bus stay
 * observation-only.
 */

/** Which planner / fallback produced this fire's target tile. Closed
 *  union so adding a new planner is a compile error at the emit site. */

export type FireOrigin =
  | "pocket"
  | "structural"
  | "wall_chain"
  | "grunt_sweep"
  | "ice_trench"
  | "focus_fire"
  | "default";

export type AiBattleDiagHook = (event: { origin: FireOrigin }) => void;

let diagHook: AiBattleDiagHook | undefined = undefined;

export function setAiBattleDiagHook(hook: AiBattleDiagHook | undefined): void {
  diagHook = hook;
}

/** Returns whether a diag hook is installed. Callers gate diag-only
 *  emit-site work behind this. */
export function isAiBattleDiagHookActive(): boolean {
  return diagHook !== undefined;
}

/** Emit a fire-decision event with the planner-origin tag. */
export function emitFireDecisionDiag(origin: FireOrigin): void {
  if (!diagHook) return;
  diagHook({ origin });
}
