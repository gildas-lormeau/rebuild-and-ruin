/**
 * Single banner-read site for modifier-reveal timing. Per-modifier effects
 * receive a `revealTimeMs` number from `revealTimeFor` and never see banner
 * state. `0` = snapshot window (hold stable), `>0` = ms since post-sweep
 * play started, `undefined` = no active reveal (release). Continuity is
 * structural: both the snapshot and the first playing frame call
 * `compute(0)`.
 */

import type { ModifierId } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RuntimeState } from "./runtime-state.ts";

export function tickModifierRevealClock(
  runtimeState: RuntimeState,
  nowMs: number,
): void {
  const activeModifier = runtimeState.state.modern?.activeModifier;
  const inRevealPhase = runtimeState.state.phase === Phase.MODIFIER_REVEAL;
  if (!activeModifier || !inRevealPhase) {
    runtimeState.modifierRevealPlayStartMs = undefined;
    return;
  }
  if (runtimeState.banner !== null && runtimeState.banner.progress < 1) {
    runtimeState.modifierRevealPlayStartMs = undefined;
    return;
  }
  if (runtimeState.modifierRevealPlayStartMs === undefined) {
    runtimeState.modifierRevealPlayStartMs = nowMs;
  }
}

export function revealTimeFor(
  runtimeState: RuntimeState,
  modifierId: ModifierId,
  nowMs: number,
): number | undefined {
  if (runtimeState.state.phase !== Phase.MODIFIER_REVEAL) return undefined;
  if (runtimeState.state.modern?.activeModifier !== modifierId)
    return undefined;
  if (runtimeState.banner !== null && runtimeState.banner.progress < 1) {
    return 0;
  }
  const startMs = runtimeState.modifierRevealPlayStartMs;
  if (startMs === undefined) return undefined;
  return nowMs - startMs;
}
