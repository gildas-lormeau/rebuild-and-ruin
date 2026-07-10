/**
 * Mode → per-frame tick handler dispatch. Centralizes the mapping from
 * `Mode` to its tick handler with an exhaustive `default` branch so an
 * unhandled Mode is a loud failure rather than a silent no-op — adding a
 * new Mode is a compile error here AND at main-loop's call site. Deps are
 * thunks/getters so the composition root can wire forward references
 * (nothing is dereferenced until the first frame ticks).
 */

import { Phase } from "../shared/core/game-phase.ts";
import { assertNever } from "../shared/platform/utils.ts";
import { Mode } from "../shared/ui/ui-mode.ts";

/** The phase-ticks surface the mode dispatch drives — the sub-interface
 *  `PhaseTicksSystem` (subsystems/phase-ticks.ts) extends. */
export interface ModePhaseTicks {
  /** Decay the migration/disconnect announcement banner. Mode-independent
   *  — called for every tickable mode, not just Mode.GAME (announcements
   *  are set by wire handlers in any mode). */
  tickOnlineAnnouncement: (dt: number) => void;
  /** Self-driving ROUND_END phase tick. Drives the score-overlay beat
   *  (Mode.TRANSITION) → life-lost dialog beat (Mode.LIFE_LOST) → exit
   *  routing (game-over / reselect / advance-to-cannon), all re-derived
   *  from state, so a host-promoted peer resumes without a repair hatch. */
  tickRoundEndPhase: (dt: number) => void;
  tickBalloonAnim: (dt: number) => void;
  /** Self-driving UPGRADE_PICK phase tick (Mode.UPGRADE_PICK). */
  tickUpgradePickPhase: (dt: number) => void;
  tickGame: (dt: number) => void;
}

export interface ModeTickDeps {
  /** Current game phase — routes Mode.TRANSITION between the ROUND_END
   *  score-overlay beat and plain banner ticking. */
  readonly getPhase: () => Phase;
  /** Forward-reference getter — phase-ticks is constructed after the
   *  main loop that consumes this dispatch. */
  readonly getPhaseTicks: () => ModePhaseTicks;
  readonly tickLobby: (dt: number) => void;
  readonly tickSelection: (dt: number) => void;
  readonly tickBanner: (dt: number) => void;
  readonly requestRender: () => void;
}

export function createModeTick(
  deps: ModeTickDeps,
): (mode: Exclude<Mode, Mode.STOPPED>, dt: number) => void {
  return function tickMode(mode, dt) {
    const phaseTicks = deps.getPhaseTicks();
    // Mode-independent: announcement banners are set by wire handlers at
    // arbitrary moments (HOST_LEFT during SELECTION, PLAYER_LEFT
    // mid-dialog) — decaying only inside tickGame froze them on screen
    // until the next gameplay phase.
    phaseTicks.tickOnlineAnnouncement(dt);
    switch (mode) {
      case Mode.LOBBY:
        deps.tickLobby(dt);
        deps.requestRender();
        return;
      case Mode.OPTIONS:
        deps.requestRender();
        return;
      case Mode.CONTROLS:
        deps.requestRender();
        return;
      case Mode.SELECTION:
        deps.tickSelection(dt);
        return;
      case Mode.TRANSITION:
        // The ROUND_END score-overlay beat runs in Mode.TRANSITION but is
        // not a banner — route it to the self-driving round-end tick.
        if (deps.getPhase() === Phase.ROUND_END) {
          phaseTicks.tickRoundEndPhase(dt);
        } else {
          deps.tickBanner(dt);
        }
        return;
      case Mode.BALLOON_ANIM:
        phaseTicks.tickBalloonAnim(dt);
        return;
      case Mode.LIFE_LOST:
        // ROUND_END's life-lost dialog beat — self-driving (drives the
        // dialog tick AND polls for the exit). Mode.LIFE_LOST is
        // round-end-only.
        phaseTicks.tickRoundEndPhase(dt);
        return;
      case Mode.UPGRADE_PICK:
        // Self-driving like the timed phases: phase-ticks ticks the dialog
        // and dispatches the exit when it resolves (see tickUpgradePickPhase).
        phaseTicks.tickUpgradePickPhase(dt);
        return;
      case Mode.GAME:
        phaseTicks.tickGame(dt);
        return;
      default:
        assertNever(mode);
    }
  };
}
