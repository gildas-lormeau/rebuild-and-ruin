/**
 * AI battle-phase diagnostic hook. Mirrors `ai-build-diag.ts`: emit-on-
 * decision via a global hook installed by test observers (narrative,
 * survival runner). Production cost = 1 branch. Lets the bus stay
 * observation-only.
 */

/** Which planner / fallback produced this fire's target tile. Closed
 *  union so adding a new planner is a compile error at the emit site. */

export type FireOrigin =
  // deny_enclosure shares CHAIN.STRUCTURAL's behaviour (surgical wall removal);
  // distinct origin so metrics can isolate min-cut enclosure-denial sieges from
  // the broader structural-hit tactic. Set via BattlePlan.originTag.
  | "deny_enclosure"
  | "pocket"
  | "structural"
  | "wall_chain"
  // super_attack shares CHAIN.WALL's behavior with wall_chain (demolition);
  // it's a distinct origin only so battle-metrics can separate super-gun
  // attacks from normal-cannon wall demolition. Set via BattlePlan.originTag.
  | "super_attack"
  | "grunt_sweep"
  // charity shares CHAIN.GRUNT's behavior with grunt_sweep; distinct origin
  // only so metrics can flag enemy-zone "charity" sweeps (which help the
  // opponent) apart from own-zone defensive sweeps. Set via originTag.
  | "charity"
  // fat_breach shares CHAIN.STRUCTURAL's behavior (surgical wall removal that
  // breaches a large enclosure); distinct origin only so metrics can separate
  // diagonal fat-wall cuts from single/double-tile structural hits. Set via
  // originTag.
  | "fat_breach"
  | "ice_trench"
  | "focus_fire"
  | "default";

/** Which sub-branch of the standard (non-chain) `pickTarget` produced a fire's
 *  target tile. Orthogonal to FireOrigin (which only splits focus_fire vs
 *  default for standard shots) — this resolves WHERE inside pickTarget the
 *  target came from, so the scatter source can be attributed. The enclosure-
 *  wall path is split by whether the contiguity bias engaged (`enclosure_contig`
 *  = picked a wall 4-adjacent to the last one hit) or not (`enclosure_jump` =
 *  fresh enclosure or no adjacent border wall → a scatter jump). Undefined for
 *  chain shots (their provenance is the chainType-derived FireOrigin). */
export type PickPath =
  | "supply_ship"
  | "strategic"
  | "grunt_wall"
  | "priority_cannon"
  | "fresh_cannon"
  | "enclosure_contig"
  // enclosure path, contiguity bias did NOT engage, split by cause:
  //   _switch  = a fresh enclosure was picked (anchor invalidated) → the walk
  //              restarts elsewhere on the fortress (an unavoidable jump).
  //   _deadend = same enclosure, but no border wall 4-adjacent to the last one
  //              was available → uniform fallback across the perimeter (a jump
  //              that a nearest-wall fallback could shrink).
  | "enclosure_switch"
  | "enclosure_deadend"
  | "fallback";

export type AiBattleDiagHook = (event: {
  origin: FireOrigin;
  pickPath?: PickPath;
}) => void;

let diagHook: AiBattleDiagHook | undefined = undefined;

export function setAiBattleDiagHook(hook: AiBattleDiagHook | undefined): void {
  diagHook = hook;
}

/** Returns whether a diag hook is installed. Callers gate diag-only
 *  emit-site work behind this. */
export function isAiBattleDiagHookActive(): boolean {
  return diagHook !== undefined;
}

/** Emit a fire-decision event with the planner-origin tag and (for standard
 *  shots) the pickTarget sub-branch. */
export function emitFireDecisionDiag(
  origin: FireOrigin,
  pickPath?: PickPath,
): void {
  if (!diagHook) return;
  diagHook({ origin, pickPath });
}
