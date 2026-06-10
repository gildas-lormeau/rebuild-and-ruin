/**
 * Audio orchestrator — owns asset loading, the music/sfx subsystems, the
 * sound modal, and the mute rule. Created once per runtime, lives for the
 * page lifetime. The composition root wires this into lifecycle/render/UI
 * deps and the `visibilitychange` listener — that listener also calls
 * `setVisibilityHidden` (runtime/state.ts), since `pausedBy` is not an audio
 * responsibility.
 */

import { Mode } from "../../shared/ui/ui-mode.ts";
import { loadStoredAssets, type MusicAssets } from "../audio/music-assets.ts";
import {
  createMusicSubsystem,
  type MusicSubsystem,
} from "../audio/music-player.ts";
import { createSfxSubsystem, type SfxSubsystem } from "../audio/sfx-player.ts";
import { createSoundModal } from "../audio/sound-modal.ts";
import { type RuntimeState, safeState } from "../state.ts";

interface AudioOrchestratorDeps {
  runtimeState: RuntimeState;
}

interface AudioOrchestrator {
  music: MusicSubsystem;
  sfx: SfxSubsystem;
  /** Apply the mute rule: silenced when the tab is hidden OR `soundEnabled`
   *  is off. Idempotent — safe to call from every soundEnabled toggle and
   *  from the visibility listener. */
  applyMute(): void;
  /** Hard-stop every voice — quit-to-menu cleanup. AudioContexts stay open
   *  so the next match can play normally. */
  stopAll(): void;
  /** True once `loadStoredAssets()` has resolved with a non-empty result. */
  getSoundReady(): boolean;
  /** Open the Sound modal (URL field + file pickers). No-op in headless
   *  tests where the `#sound-modal` element is absent. */
  showSoundModal(): void;
}

export function createAudioOrchestrator(
  deps: AudioOrchestratorDeps,
): AudioOrchestrator {
  const { runtimeState } = deps;

  // Music assets are loaded asynchronously from IndexedDB (null until ready
  // / if the player hasn't dropped Rampart files into the settings dialog).
  // The subsystem reads the slot live on every `activate()` / `subscribeBus()`,
  // so files loaded later automatically take effect on the next game.
  let musicAssets: MusicAssets | undefined;
  const musicAssetsReady = loadStoredAssets()
    .then((assets) => {
      musicAssets = assets;
    })
    .catch((error) => {
      console.error("[music] loadStoredAssets failed:", error);
    });

  const music = createMusicSubsystem();

  // SFX lives in a separate AudioContext from the music synth — Web Audio
  // is natively polyphonic via BufferSource-per-trigger, so fast-firing
  // events (wallPlaced on each brick) overlap cleanly. Silent until
  // SOUND.RSC is loaded into IDB; bus subscription is re-established on
  // every new game.
  const sfx = createSfxSubsystem({
    getAssets: () => musicAssets,
    assetsReady: musicAssetsReady,
    getState: () => safeState(runtimeState),
    // First tower enclosure of a phase → player-specific fanfare sub-song.
    // SFX has already played elechit1 and delayed the callback by the
    // stinger's duration, so the fanfare lands cleanly after it.
    onFirstEnclosure: (playerId) => void music.playFanfare(playerId),
  });

  function applyMute(): void {
    const hidden = typeof document !== "undefined" && document.hidden;
    const silenced = hidden || !runtimeState.settings.soundEnabled;
    void music.setPaused(silenced);
    void sfx.setPaused(silenced);
  }

  // The Sound modal (URL field + file pickers) lives in index.html. Headless
  // tests run without DOM — skip construction so the options screen still
  // renders the row but the opener is a no-op.
  const soundModal =
    typeof document !== "undefined" && document.getElementById("sound-modal")
      ? createSoundModal()
      : undefined;
  // Synchronous close hook: kicks off `music.activate()` inside the close
  // click so `new AudioContext()` and `ctx.resume()` happen within the
  // transient user-activation window. Without this, the post-IDB-await
  // resume is silently denied on browsers that consume gesture state across
  // awaits — music plays into a suspended context and stays silent until
  // the next user interaction (e.g. toggling soundEnabled).
  soundModal?.setOnCloseSync(() => {
    void music.activate();
  });
  soundModal?.setOnClose((assets) => {
    musicAssets = assets;
    // Asset bytes may have changed — drop both subsystems' in-memory caches
    // so the next event/track re-hydrates from the new IDB data. Both skip
    // already-loaded entries (`activateOnce` / `ensureSamples`), so without
    // these refreshes the old SFX samples + music buffers play until reload.
    sfx.refreshSamples();
    music.refreshBuffers();
    // If assets were just loaded and the lobby is showing the title screen,
    // kick off playback. Safe to call repeatedly — the subsystem is
    // idempotent and no-ops when already playing or when assets are still
    // missing.
    if (assets && runtimeState.mode === Mode.LOBBY) {
      void music.startTitle();
    }
    // Re-apply mute state in case the user just removed/added assets while
    // soundEnabled was toggled to a non-default value.
    applyMute();
  });

  return {
    music,
    sfx,
    applyMute,
    stopAll: () => {
      sfx.stopAll();
      music.stopAll();
    },
    getSoundReady: () => musicAssets !== undefined,
    showSoundModal: () => {
      soundModal?.show();
    },
  };
}
