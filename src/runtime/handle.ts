/**
 * Public composition return type. `GameRuntime` lives in its own file —
 * not `types.ts` — because it sits ABOVE every subsystem in the
 * import graph (it pulls in every `RuntimeXxx` interface). Keeping it
 * separate lets `types.ts` stay a low-layer contract file holding
 * `RuntimeConfig` / `NetworkApi` / online-mode types that subsystems read.
 */

import type { GameMap } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { RuntimeMusic } from "./audio/music-player.ts";
import type { RuntimeSfx } from "./audio/sfx-player.ts";
import type { RuntimeState } from "./state.ts";
import type { RuntimeCamera } from "./subsystems/camera.ts";
import type { RuntimeLifecycle } from "./subsystems/game-lifecycle.ts";
import type { RuntimeLifeLost } from "./subsystems/life-lost.ts";
import type { RuntimeLobby } from "./subsystems/lobby.ts";
import type { RuntimePhaseTicks } from "./subsystems/phase-ticks.ts";
import type { RuntimeScoreDelta } from "./subsystems/score-deltas.ts";
import type { RuntimeSelection } from "./subsystems/selection.ts";
import type { RuntimeUpgradePick } from "./subsystems/upgrade-pick.ts";

export interface GameRuntime {
  /** Mutable runtime state — direct property access replaces getter/setter pairs. */
  runtimeState: RuntimeState;

  // --- Sub-system handles ---
  selection: RuntimeSelection;
  lifeLost: RuntimeLifeLost;
  scoreDelta: RuntimeScoreDelta;
  upgradePick: RuntimeUpgradePick;
  lobby: RuntimeLobby;
  lifecycle: RuntimeLifecycle;
  phaseTicks: RuntimePhaseTicks;
  music: RuntimeMusic;
  sfx: RuntimeSfx;
  /** Bind the bus-driven observers (haptics, music cues, SFX event map) to
   *  the current `state.bus`. Each bootstrap creates a fresh bus, so every
   *  bootstrap path must call this from its `onStateReady` hook — the local
   *  startGame path does it internally; online's initFromServer calls it
   *  through this handle. Skipping it silences all bus-driven audio/haptics
   *  for the match. */
  bindStateObservers: () => void;
  /** Quit-to-menu cleanup shared by both entry points (local + online).
   *  Sets mode to STOPPED, stops any active bg track, and silences
   *  in-flight SFX. Wired to the GAME_EXIT_EVENT (back-button / hash
   *  navigation away from /play). */
  shutdown: () => void;
  /** Camera sub-system. Exposed so tests (and any future consumer) can
   *  observe zoom/pitch state — the underlying camera value is already
   *  constructed inside `createGameRuntime`, this just surfaces it on
   *  the public handle. */
  camera: RuntimeCamera;

  // --- Cross-cutting orchestration ---
  mainLoop: (now: number) => void;
  clearFrameData: () => void;
  render: () => void;
  /** Hide the current banner. The banner no longer auto-dismisses on
   *  sweep completion — it sits in its `swept` state until a caller
   *  hides it or a new `showBanner` overwrites it. */
  hideBanner: () => void;
  /** Pre-warm the terrain render cache for a map (avoids first-frame stall). */
  warmMapCache: (map: GameMap) => void;
  /** Install a fresh LOCAL human controller for `playerId`, primed for the
   *  live phase. The online seat-reclaim owner swap: when a rejoiner's seat
   *  is handed back from the AI that took it over (online/online-seat-reclaim.ts),
   *  this replaces the dormant AI controller with the returning human's.
   *  SYNCHRONOUS + rng-neutral so it can ride the lockstep SEAT_RECLAIM apply
   *  in the same tick as the slot-set flip (see the impl note in composition.ts). */
  installLocalHumanController: (playerId: ValidPlayerId) => void;
  /** Convert any open life-lost / upgrade-pick entry for `playerId` to
   *  AI-resolved. The seat-takeover companion to the reclaim swap above:
   *  an AI taking a seat over mid-dialog inherits an entry whose
   *  `autoResolve` is still frozen to the departed human, so it would
   *  stall to the max-timer ABANDON instead of the AI playing it.
   *  Shared-RNG-neutral; runs at the lockstep takeover apply on every peer. */
  adoptDialogSeat: (playerId: ValidPlayerId) => void;
}
