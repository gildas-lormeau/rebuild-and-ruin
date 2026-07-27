/** Phase-view projections for the per-phase state slices in
 *  system-interfaces.ts. Lives alongside (one layer above) the contracts, the
 *  same way controller-guards.ts hosts the controller type guards — so
 *  system-interfaces.ts stays value-export free and keeps its L5 slot.
 *
 *  The only place allowed to mint a slice's phantom `__phase` witness; see
 *  `buildView` below for why the projections exist, and "Phase views" in
 *  CLAUDE.md for the mechanism end to end. */

import { Phase } from "./game-phase.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
} from "./system-interfaces.ts";
import type { GameState } from "./types.ts";

/** Unchecked projections for SPECULATIVE reads — "what would this tactic
 *  suggest if we were in that phase". No phase assert, so this is a real
 *  bypass; it exists because one caller legitimately has no phase to assert.
 *
 *  Sole sanctioned caller: `scripts/mcp-play/harness.ts`. Its `observe()`
 *  builds a full action-affordance preview on EVERY agent action, in whatever
 *  phase the game happens to be in — threat lists, min-cut breach targets,
 *  finish-it sprays, declutter candidates. Those planners declare battle/build
 *  views because that is where the game calls them for real, but the preview
 *  is deliberately phase-independent: an agent in WALL_BUILD still wants to see
 *  which walls it could later spray. Asserting would break the tool; returning
 *  null would silently empty its observation.
 *
 *  `lint-phase-scoped-fields.ts` enforces the single-caller rule, so this
 *  cannot quietly become the easy way out of a phase gate in `src/`. If a
 *  second caller ever needs it, that is a signal the underlying planner
 *  over-declares its parameter (it only reads geometry) and should be
 *  re-typed — not that this allowlist should grow. */
export const SPECULATIVE_VIEWS = {
  build: (state: GameState): BuildViewState =>
    state as unknown as BuildViewState,
  battle: (state: GameState): BattleViewState =>
    state as unknown as BattleViewState,
} as const;

/** Project to the WALL_BUILD slice. Throws outside WALL_BUILD.
 *
 *  WHY THE PROJECTIONS EXIST. Several `GameState` fields are only meaningful
 *  during one phase (`cannonLimits` in CANNON_PLACE, `battleCountdown` in
 *  BATTLE). That used to be enforced in prose — the field docs said "always
 *  guard on `state.phase`" and nothing checked it. The per-phase slices existed
 *  but `GameState` satisfied all of them structurally, so passing the whole god
 *  object where a slice was declared type-checked fine, and the slices
 *  documented a contract they could not enforce.
 *
 *  Each slice now carries a phantom `__phase` witness `GameState` does NOT have
 *  (see `CannonViewState.__phase`), so the only way to get one is a projection
 *  here — and every projection asserts the phase. That assert is a
 *  programming-error throw, not a recoverable runtime condition: same contract
 *  as `getInterior` / `assertInteriorFresh` in shared/sim. At every call site
 *  the `state.phase === Phase.X` branch was already present; the projection
 *  just carries that fact into the type system.
 *
 *  The casts in this module are the single sanctioned laundering point, and the
 *  reason the witness can stay phantom: nothing to populate, nothing to keep in
 *  sync, no runtime cost beyond the phase comparison. Do not write
 *  `as unknown as XViewState` elsewhere — `lint-phase-scoped-fields.ts` fails
 *  the build on witness casts outside this file. */
export function buildView(state: GameState): BuildViewState {
  assertPhase(state, Phase.WALL_BUILD);
  return state as unknown as BuildViewState;
}

/** Project to the CANNON_PLACE slice. Throws outside CANNON_PLACE. */
export function cannonView(state: GameState): CannonViewState {
  assertPhase(state, Phase.CANNON_PLACE);
  return state as unknown as CannonViewState;
}

/** Project to the BATTLE slice. Throws outside BATTLE. */
export function battleView(state: GameState): BattleViewState {
  assertPhase(state, Phase.BATTLE);
  return state as unknown as BattleViewState;
}

/** Non-throwing `battleView` — null outside BATTLE. For the one caller whose
 *  own gate is not the live phase: the render path refreshes crosshairs from
 *  `frameMeta.inBattle`, which is snapshotted at tick start and so stays true
 *  for the rest of a frame in which battle ended (render.ts documents the
 *  staleness where it re-derives the phase live). Extending remote crosshairs
 *  is a no-op outside battle anyway, so that window returns the list
 *  untouched instead of asserting. */
export function tryBattleView(state: GameState): BattleViewState | null {
  return state.phase === Phase.BATTLE
    ? (state as unknown as BattleViewState)
    : null;
}

/** Widen a phase view back to the full `GameState`.
 *
 *  This is a HOLE in the narrowing, and naming it is the point. It used to
 *  happen as bare `state as GameState` casts — invisible to grep and
 *  indistinguishable from an ordinary narrowing cast — plus one method whose
 *  parameter simply declared `GameState` while implementing a view-typed
 *  interface, which TypeScript's method bivariance accepted silently. Routing
 *  every case through one named function makes the laundering countable:
 *  `git grep widenToGameState` is the complete list.
 *
 *  Two sanctioned callers, both cases where a view genuinely cannot serve:
 *  1. `controllers/ai-commit-port.ts` — the three executors MUTATE the board,
 *     so they need the mutable object; the AI reaches them holding a view.
 *  2. `controllers/controller-human.ts:tryPlacePiece` — its Master Builder
 *     lockout gate calls `canPlayerBuild`, which fans out to the upgrade-impl
 *     registry (every impl takes `GameState`), reading `activeFeatures` and
 *     `modern` internals the BuildViewState slice deliberately hides.
 *
 *  Sound in practice for the same reason the projections above are the only
 *  source of a view: every value that reaches here IS a `GameState`, because
 *  nothing else can mint the `__phase` witness. */
export function widenToGameState(
  view: BuildViewState | CannonViewState | BattleViewState,
): GameState {
  return view as unknown as GameState;
}

/** Throw unless the state is in `expected`. A failure is a caller bug — a
 *  projection reached without the phase branch that makes the slice's fields
 *  meaningful — not a recoverable runtime condition. */
function assertPhase(state: GameState, expected: Phase): void {
  if (state.phase !== expected) {
    throw new Error(
      `Phase-view projection for ${expected} used during ${state.phase}. ` +
        `The slice's fields are only meaningful in ${expected} — guard the ` +
        `call site on state.phase, or use a non-asserting projection.`,
    );
  }
}
