/**
 * Public composition return type. `GameRuntime` lives in its own file —
 * not `runtime-types.ts` — because it sits ABOVE every subsystem in the
 * import graph (it pulls in every `RuntimeXxx` interface). Keeping it
 * separate lets `runtime-types.ts` stay a low-layer contract file holding
 * `RuntimeConfig` / `NetworkApi` / online-mode types that subsystems read.
 */

import type { GameMap } from "../shared/core/geometry-types.ts";
import type { RuntimeMusic } from "./audio/music-player.ts";
import type { RuntimeSfx } from "./audio/sfx-player.ts";
import type { CameraSystem } from "./runtime-camera.ts";
import type { RuntimeLifecycle } from "./runtime-game-lifecycle.ts";
import type { RuntimeLobby } from "./runtime-lobby.ts";
import type { RuntimePhaseTicks } from "./runtime-phase-ticks.ts";
import type { RuntimeSelection } from "./runtime-selection.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { RuntimeLifeLost } from "./subsystems/life-lost.ts";
import type { RuntimeScoreDelta } from "./subsystems/score-deltas.ts";
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
  /** Quit-to-menu cleanup shared by both entry points (local + online).
   *  Sets mode to STOPPED, stops any active bg track, and silences
   *  in-flight SFX. Wired to the GAME_EXIT_EVENT (back-button / hash
   *  navigation away from /play). */
  shutdown: () => void;
  /** Camera sub-system. Exposed so tests (and any future consumer) can
   *  observe zoom/pitch state — the underlying camera value is already
   *  constructed inside `createGameRuntime`, this just surfaces it on
   *  the public handle. */
  camera: CameraSystem;

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
}
