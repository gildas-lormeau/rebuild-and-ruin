import { Phase } from "../shared/game-phase.ts";
import { Mode } from "../shared/ui-mode.ts";

type RecoveredBalloonFlight = {
  flight: { startX: number; startY: number; endX: number; endY: number };
  progress: number;
};

interface FullStateUiRecoveryDeps {
  setMode: (mode: Mode) => void;
  onModeSet?: (mode: Mode) => void;
  clearCastleBuilds: () => void;
  clearLifeLostDialog: () => void;
  clearAnnouncement: () => void;
  setBattleFlights: (flights: readonly RecoveredBalloonFlight[]) => void;
}

export function restoreFullStateUiRecovery(
  deps: FullStateUiRecoveryDeps,
  phase: Phase,
  balloonFlights?: readonly RecoveredBalloonFlight[],
): void {
  const mode = resolveModeAfterFullState(phase, balloonFlights);
  deps.setMode(mode);
  deps.onModeSet?.(mode);
  deps.clearCastleBuilds();
  deps.clearLifeLostDialog();
  deps.clearAnnouncement();
  deps.setBattleFlights(phase === Phase.BATTLE ? (balloonFlights ?? []) : []);
}

function resolveModeAfterFullState(
  phase: Phase,
  balloonFlights?: readonly RecoveredBalloonFlight[],
): Mode {
  if (phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT) {
    return Mode.SELECTION;
  }
  if (phase === Phase.BATTLE && balloonFlights && balloonFlights.length > 0) {
    return Mode.BALLOON_ANIM;
  }
  return Mode.GAME;
}
