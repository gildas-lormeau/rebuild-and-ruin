/** Type guards for controller interfaces defined in system-interfaces.ts.
 *  Lives alongside (one layer above) the contracts so consumers can
 *  discriminate via `ctrl.kind` without forcing system-interfaces.ts to
 *  carry value exports. */

import type {
  AiAnimatable,
  ControllerIdentity,
  InputReceiver,
  PlayerController,
} from "./system-interfaces.ts";

/** Type guard — true when ctrl is a HumanController (implements InputReceiver).
 *  Overloaded so callers with the full PlayerController get a PlayerController predicate,
 *  while callers with only ControllerIdentity get a narrower predicate. */
export function isHuman(
  ctrl: PlayerController,
): ctrl is PlayerController & InputReceiver;

export function isHuman(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & InputReceiver;

export function isHuman(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & InputReceiver {
  return ctrl.kind === "human";
}

/** Type guard — true when ctrl is an AiController (implements AiAnimatable).
 *  Overloaded so callers with the full PlayerController get a PlayerController predicate,
 *  while callers with only ControllerIdentity get a narrower predicate. */
export function isAiAnimatable(
  ctrl: PlayerController,
): ctrl is PlayerController & AiAnimatable;

export function isAiAnimatable(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & AiAnimatable;

export function isAiAnimatable(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & AiAnimatable {
  return ctrl.kind === "ai";
}
