/**
 * Music sub-system — PCM playback of player-supplied Rampart music.
 *
 * ### Topology
 *
 * Every track (title / cannon-bg / build-bg / score-bg / life-lost / jaws)
 * and every fanfare variant is rendered once at upload-time
 * ([sound-modal.ts](./sound-modal.ts) → `renderAllTracksToCache` in
 * [music-synth-loader.ts](./music-synth-loader.ts)) and persisted as PCM
 * in IndexedDB. The in-game `activate()` path just reads the cache and
 * builds `AudioBuffer`s — no WASM, no synth, ready in ~10 ms instead of
 * the 5–10 s a fresh render takes on mobile. Playback creates a fresh
 * `AudioBufferSourceNode` per trigger; looping is handled by the browser
 * (`source.loop` + XMI `loopStart` / `loopEnd` when present), volume +
 * fades by a per-trigger `GainNode`. No live AudioWorklet, free overlap
 * of fanfares with bg.
 *
 * Plays RXMI_TITLE.xmi from the moment the subsystem is bound to a game bus
 * (first launch + rematch) until the first WALL_BUILD phase starts. Silent
 * if the cache is empty (player hasn't dropped in their Rampart files yet,
 * or the render after their last upload failed). Mirrors the observer+bus
 * pattern used by [runtime-haptics.ts](./runtime-haptics.ts).
 *
 * ### Autoplay policy
 *
 * Browsers suspend a fresh AudioContext until a user gesture. The first
 * `activate()` call is wired to the home-page "Play" button so the context
 * resumes inside that gesture.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` that captures `onPlay(track)` / `onStop`
 * intents, so a scenario can assert "binding this bus would trigger title
 * music" without booting an AudioContext or reading IndexedDB.
 */

import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
  type GameEventMap,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { MusicObserver } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  AUDIO_CONTEXT_RUNNING,
  AUDIO_CONTEXT_SUSPENDED,
} from "../shared/platform/platform.ts";
import {
  type CachedPcm,
  fanfareCacheId,
  loadPcmCache,
  PRERENDER_BG_TRACKS,
  PRERENDER_FANFARE_SONGS,
  type XmiFileKey,
} from "./music-assets.ts";

interface MusicSubsystem {
  /** Pre-warm the AudioContext + decode every cached PCM track into
   *  AudioBuffers, inside a user-gesture handler (the home-page "Play"
   *  button click). Returns once buffers are ready. Idempotent — repeat
   *  calls short-circuit. Silent if no PCM is cached (user hasn't
   *  uploaded their Rampart files yet, or the upload-time render
   *  hasn't completed). */
  activate(): Promise<void>;
  /** Start the RXMI_TITLE.xmi track. Called from the lobby entry point so
   *  music covers the pre-game screen. Idempotent per instance. */
  startTitle(): Promise<void>;
  /** Stop any active playback. Idempotent. */
  stopTitle(): Promise<void>;
  /** Play the one-shot tower-enclosure fanfare for a player. Picks a
   *  TETRIS sub-song by player slot (5/6/7 cycle). Plays through a fresh
   *  AudioBufferSourceNode so it overlaps any in-flight bg track for free. */
  playFanfare(playerId: ValidPlayerSlot): Promise<void>;
  /** Bind to the supplied game bus so PHASE_START=WALL_BUILD auto-stops the
   *  title track when the first castle goes down. Re-binding to a different
   *  bus (rematch) unbinds the previous one. */
  subscribeBus(bus: GameEventBus): void;
  /** Compute continuous presentational signals from `state` each frame —
   *  currently drives the build bg decrescendo (derived from `state.timer`)
   *  and stop on WALL_BUILD exit. Mirrors sfx-player's equivalent hook. */
  tickPresentation(state: GameState): void;
  /** Suspend or resume the AudioContext — wired to `document.visibilitychange`
   *  so music doesn't keep looping in a backgrounded tab. No-op until
   *  `activate()` has run. */
  setPaused(paused: boolean): Promise<void>;
  /** Release the bus listener and stop playback. */
  dispose(): Promise<void>;
}

interface MusicSubsystemDeps {
  readonly observer?: MusicObserver;
}

type BgTrackId = "title" | "cannon" | "build" | "score" | "lifeLost" | "jaws";

/** Metadata for a track playing through the shared AudioContext. `cacheId`
 *  is the IDB key (matches an entry in `PRERENDER_BG_TRACKS`); `id` is the
 *  opaque label surfaced to the test observer — same string in current
 *  use, kept distinct so the cache key can change without breaking
 *  observer expectations. */
interface BgTrack {
  readonly id: string;
  readonly cacheId: string;
  readonly file: XmiFileKey;
  readonly loop: boolean;
  readonly volume: number;
}

// Centralized per-track mix levels. Numbers are pre-computed products of the
// old per-track base gain × the old global +25 % MIDI boost (libADLMIDI output
// sat noticeably below the PCM SFX layer). Cannon bg is ~4.5× hotter than the
// other tracks because RXMI_CANNON is mixed noticeably quieter in the original
// assets; jaws is 2× hotter so the one-shot cuts through the battle-anim mix.
// Edit these to retune the music layer's perceived volume.
const TRACK_VOLUMES: Record<BgTrackId, number> = {
  title: 1.25,
  cannon: 5.625,
  build: 1.25,
  score: 1.25,
  lifeLost: 1.25,
  jaws: 2.5,
};
const FANFARE_VOLUME = 1.25;
const BG_TRACK_TITLE: BgTrack = {
  id: "RXMI_TITLE.xmi",
  cacheId: "RXMI_TITLE.xmi",
  file: "RXMI_TITLE.xmi",
  loop: true,
  volume: TRACK_VOLUMES.title,
};
const BG_TRACK_CANNON: BgTrack = {
  id: "RXMI_CANNON.xmi",
  cacheId: "RXMI_CANNON.xmi",
  file: "RXMI_CANNON.xmi",
  loop: true,
  volume: TRACK_VOLUMES.cannon,
};
const BG_TRACK_BUILD: BgTrack = {
  id: "RXMI_TETRIS.xmi",
  cacheId: "RXMI_TETRIS.xmi",
  file: "RXMI_TETRIS.xmi",
  loop: true,
  volume: TRACK_VOLUMES.build,
};
// Score-overlay bg music — 0-indexed sub-song 4 of RXMI_SCORE.xmi
// (mapping.txt lists it 1-indexed as "5 -> bg music score"). Loops for
// the duration of the between-rounds score-delta overlay.
const BG_TRACK_SCORE: BgTrack = {
  id: "RXMI_SCORE.xmi",
  cacheId: "RXMI_SCORE.xmi",
  file: "RXMI_SCORE.xmi",
  loop: true,
  volume: TRACK_VOLUMES.score,
};
// Life-lost popup one-shot — 0-indexed sub-song 1 of RXMI_TETRIS.xmi
// (mapping.txt "2 -> life lost music"). No loop: plays once as the
// dialog appears. Reselect has no bg music of its own, so the stinger
// normally finishes naturally before the next WALL_BUILD banner would
// replace it; if a very short reselect races ahead the tail gets clipped.
const BG_TRACK_LIFE_LOST: BgTrack = {
  id: "RXMI_TETRIS.xmi#life-lost",
  cacheId: "RXMI_TETRIS.xmi#life-lost",
  file: "RXMI_TETRIS.xmi",
  loop: false,
  volume: TRACK_VOLUMES.lifeLost,
};
// Balloon-capture jaws theme — 0-indexed sub-song 6 of RXMI_BATTLE.xmi
// (mapping.txt "7 -> jaws theme"). One-shot, no loop: the track is
// ~7.66 s long (libADLMIDI playback). BALLOON_FLIGHT_DURATION is set
// to 5.5 s so balloonAnimEnd cuts the track's tail — an intentional
// trim to keep the animation beat tight.
const BG_TRACK_JAWS: BgTrack = {
  id: "RXMI_BATTLE.xmi",
  cacheId: "RXMI_BATTLE.xmi",
  file: "RXMI_BATTLE.xmi",
  loop: false,
  volume: TRACK_VOLUMES.jaws,
};
const FANFARE_TRACK: XmiFileKey = "RXMI_TETRIS.xmi";
// Tower-enclosure fanfares live at 0-indexed sub-songs 4/5/6 of
// RXMI_TETRIS.xmi (mapping.txt lists them 1-indexed as 5/6/7). One
// variant per player slot; a hypothetical 4th player reuses slot 0's.
// Sub-songs are persisted in the cache by index; this map picks one
// per player slot.
const FANFARE_SONG_BY_SLOT: readonly number[] = [4, 5, 6, 4];
// Build bg decrescendo runs on the same 1 s window as the snare's
// crescendo in sfx-player.ts (SNARE_CRESCENDO_SEC): fade STARTS at
// timer = 6.72 s (same instant the snare loop kicks in at 0 gain) and
// ends at timer = 5.72 s (snare at full gain, bg silent). Clean
// cross-fade with mirrored ramps.
const BUILD_BG_FADE_START_SEC = 6.72;
const BUILD_BG_FADE_DURATION_SEC = 1;
const STOP_REASON_PHASE = "phase" as const;
const STOP_REASON_DISPOSE = "dispose" as const;

export function createMusicSubsystem(deps: MusicSubsystemDeps): MusicSubsystem {
  // Single AudioContext shared by every bg track + every fanfare. Created
  // lazily inside `activate()` so the constructor never touches Web Audio
  // outside a user gesture. No worklet, no WASM at runtime.
  let audioContext: AudioContext | undefined;
  // Active bg source + its volume gain. Stopping bg = `source.stop()` +
  // null these out. Fading bg = ramp `gain.gain` on the audio-clock.
  let activeSource: AudioBufferSourceNode | undefined;
  let activeGain: GainNode | undefined;
  // Track most recently asked to play; cleared by stopBg. Drives
  // tickPresentation's build-bg fade trigger and the setPaused restart hook.
  let bgPlaying: BgTrack | undefined;

  // AudioBuffers built from cached PCM during activate(). Bg tracks live
  // by track id, fanfares by player slot. Populated incrementally — each
  // `activateOnce()` call only loads tracks not already cached, so the
  // first activate (cache empty) followed by a settings-modal upload +
  // close (cache populated) ends up loading the new entries on the
  // post-upload activate without needing a page refresh.
  const bgBuffers = new Map<string, CachedPcm>();
  const fanfareBuffers = new Map<number, AudioBuffer>();
  const bgAudioBuffers = new Map<string, AudioBuffer>();
  let activatingPromise: Promise<void> | undefined;

  // `wantsTitle` is the caller's intent (lobby said "play title"). `paused`
  // means the composition told us the host tab is hidden / externally
  // quieted — we honor wantsTitle but defer the play call until un-paused.
  let wantsTitle = false;
  let paused = false;

  // Tracks whether the tick-derived fade signal has already fired in the
  // current WALL_BUILD phase — prevents re-triggering the ramp every frame
  // past the threshold.
  let buildBgFadeTriggered = false;
  // Previous-tick phase for leave-WALL_BUILD edge detection.
  let buildBgLastPhase: Phase | undefined;

  // Bus binding tracker — one array instead of per-event locals so unbind
  // is a one-liner (matches sfx-player's pattern).
  let boundBus: GameEventBus | undefined;
  type EventKey = keyof GameEventMap;
  const boundHandlers: Array<{
    type: EventKey;
    handler: GameEventHandler<EventKey>;
  }> = [];

  function ensureAudioContext(): AudioContext | undefined {
    if (audioContext) return audioContext;
    if (typeof AudioContext === "undefined") return undefined;
    audioContext = new AudioContext();
    return audioContext;
  }

  function pcmToAudioBuffer(ctx: AudioContext, pcm: CachedPcm): AudioBuffer {
    // Cached PCM is rendered at the device sample rate the user had at
    // upload time — usually but not always the same as `ctx.sampleRate`.
    // Constructing the AudioBuffer at the cached rate is correct: the
    // AudioBufferSourceNode resamples on playback if rates differ.
    const buffer = ctx.createBuffer(2, pcm.frames, pcm.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < pcm.frames; i += 1) {
      left[i] = pcm.pcm[i * 2]!;
      right[i] = pcm.pcm[i * 2 + 1]!;
    }
    return buffer;
  }

  function activateOnce(): Promise<void> {
    if (activatingPromise) return activatingPromise;
    activatingPromise = (async () => {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      // Resume now (we're inside the home-page click). Safe to call repeatedly.
      if (ctx.state === AUDIO_CONTEXT_SUSPENDED) {
        await ctx.resume().catch(() => {});
      }
      // Hydrate bg tracks from the upload-time PCM cache. Skip tracks
      // already loaded — repeat calls (e.g. after a settings-modal upload)
      // only pay the IDB cost for newly-cached entries. Missing entries
      // (cache wiped, render failed, user hasn't uploaded yet) leave the
      // track silent — playBg gracefully no-ops.
      for (const spec of PRERENDER_BG_TRACKS) {
        if (bgAudioBuffers.has(spec.id)) continue;
        const pcm = await loadPcmCache(spec.id).catch((error) => {
          console.warn(`[music] cache read failed for ${spec.id}:`, error);
          return undefined;
        });
        if (!pcm) continue;
        bgBuffers.set(spec.id, pcm);
        bgAudioBuffers.set(spec.id, pcmToAudioBuffer(ctx, pcm));
      }
      // Hydrate fanfares the same way; map every slot that uses each
      // sub-song to the same AudioBuffer (slots 0 and 3 share song 4).
      const fanfareAudioBySong = new Map<number, AudioBuffer>();
      for (const songIndex of PRERENDER_FANFARE_SONGS) {
        if (
          // already loaded for some slot? skip the IDB read.
          [...fanfareBuffers.entries()].some(
            ([slot, buf]) =>
              FANFARE_SONG_BY_SLOT[slot] === songIndex && buf !== undefined,
          )
        ) {
          continue;
        }
        const pcm = await loadPcmCache(fanfareCacheId(songIndex)).catch(
          (error) => {
            console.warn(
              `[music] cache read failed for fanfare ${songIndex}:`,
              error,
            );
            return undefined;
          },
        );
        if (!pcm) continue;
        fanfareAudioBySong.set(songIndex, pcmToAudioBuffer(ctx, pcm));
      }
      for (let slot = 0; slot < FANFARE_SONG_BY_SLOT.length; slot += 1) {
        if (fanfareBuffers.has(slot)) continue;
        const songIndex = FANFARE_SONG_BY_SLOT[slot] ?? FANFARE_SONG_BY_SLOT[0];
        if (songIndex === undefined) continue;
        const buffer = fanfareAudioBySong.get(songIndex);
        if (buffer) fanfareBuffers.set(slot, buffer);
      }
    })();
    // Clear the in-flight handle once the load resolves, so a later
    // call (e.g. after the settings modal closes with new PCM in IDB)
    // re-runs the cache load instead of returning the cached resolved
    // promise.
    void activatingPromise.finally(() => {
      activatingPromise = undefined;
    });
    return activatingPromise;
  }

  function stopActiveSource(): void {
    if (!activeSource) return;
    try {
      activeSource.stop();
    } catch {
      // Source already ended — fine.
    }
    activeSource = undefined;
    activeGain = undefined;
  }

  async function playBg(track: BgTrack): Promise<void> {
    if (paused) return;
    await activateOnce();
    if (paused) return;
    const ctx = audioContext;
    const buffer = bgAudioBuffers.get(track.cacheId);
    const pcm = bgBuffers.get(track.cacheId);
    if (!ctx || !buffer || !pcm) return;
    try {
      stopActiveSource();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (track.loop) {
        source.loop = true;
        // XMI FOR/NEXT markers: re-loop only the marked region. Without
        // markers, source.loop with default loopStart=0 / loopEnd=0
        // re-loops the entire buffer.
        if (pcm.loopStartSec >= 0 && pcm.loopEndSec > 0) {
          source.loopStart = pcm.loopStartSec;
          source.loopEnd = pcm.loopEndSec;
        }
      }
      const gain = ctx.createGain();
      gain.gain.value = track.volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      // Self-clear when the source ends naturally (one-shots only — looped
      // sources keep the references alive until explicit stopBg).
      source.addEventListener("ended", () => {
        if (activeSource === source) {
          activeSource = undefined;
          activeGain = undefined;
        }
      });
      source.start(0);
      activeSource = source;
      activeGain = gain;
      bgPlaying = track;
      buildBgFadeTriggered = false;
      deps.observer?.onPlay?.(track.id);
    } catch (error) {
      console.error(`[music] ${track.id} playback failed:`, error);
    }
  }

  function stopBg(reason: "phase" | "rematch" | "dispose"): void {
    const wasPlaying = bgPlaying !== undefined;
    bgPlaying = undefined;
    stopActiveSource();
    if (wasPlaying) deps.observer?.onStop?.(reason);
  }

  function fadeOutBg(): void {
    if (!audioContext || !activeGain) return;
    const now = audioContext.currentTime;
    activeGain.gain.cancelScheduledValues(now);
    activeGain.gain.setValueAtTime(activeGain.gain.value, now);
    activeGain.gain.linearRampToValueAtTime(
      0,
      now + BUILD_BG_FADE_DURATION_SEC,
    );
  }

  async function playTitle(): Promise<void> {
    wantsTitle = true;
    if (paused) return; // will start when setPaused(false) fires
    if (bgPlaying === BG_TRACK_TITLE) return;
    await playBg(BG_TRACK_TITLE);
  }

  function stopTitle(): Promise<void> {
    wantsTitle = false;
    stopBg(STOP_REASON_PHASE);
    return Promise.resolve();
  }

  async function playFanfare(playerId: ValidPlayerSlot): Promise<void> {
    if (paused) return;
    await activateOnce();
    if (paused) return;
    const ctx = audioContext;
    if (!ctx) return;
    const buffer = fanfareBuffers.get(playerId) ?? fanfareBuffers.get(0);
    if (!buffer) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = FANFARE_VOLUME;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      deps.observer?.onPlay?.(`${FANFARE_TRACK}#slot${playerId}`);
    } catch (error) {
      console.error(
        `[music] fanfare playback failed for slot ${playerId}:`,
        error,
      );
    }
  }

  function tickPresentation(state: GameState): void {
    const phase = state.phase;
    // Edge: just left WALL_BUILD — hard-stop build-bg (safety net in case
    // the fade signal never crossed, e.g. build phase cut short). Guarded on
    // bgPlaying so we don't cut off the next phase's music (cannon-bg may
    // already have started by the time this frame runs).
    if (buildBgLastPhase === Phase.WALL_BUILD && phase !== Phase.WALL_BUILD) {
      if (bgPlaying === BG_TRACK_BUILD) stopBg(STOP_REASON_PHASE);
      buildBgFadeTriggered = false;
    }
    buildBgLastPhase = phase;

    if (phase !== Phase.WALL_BUILD) return;
    if (buildBgFadeTriggered) return;
    if (bgPlaying !== BG_TRACK_BUILD) return;
    if (state.timer <= 0 || state.timer > BUILD_BG_FADE_START_SEC) return;
    buildBgFadeTriggered = true;
    fadeOutBg();
  }

  function unbindCurrentBus(): void {
    if (boundBus) {
      for (const { type, handler } of boundHandlers) {
        boundBus.off(type, handler);
      }
    }
    boundBus = undefined;
    boundHandlers.length = 0;
    buildBgFadeTriggered = false;
    buildBgLastPhase = undefined;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    boundBus = bus;

    const bind = <K extends EventKey>(
      type: K,
      handler: GameEventHandler<K>,
    ): void => {
      bus.on(type, handler);
      boundHandlers.push({
        type,
        handler: handler as GameEventHandler<EventKey>,
      });
    };

    // Stop the title track the moment any player confirms their starting
    // castle. Ignore `isReselect` — after a mid-game castle reselect the
    // title isn't playing anyway.
    bind(GAME_EVENT.CASTLE_PLACED, (event) => {
      if (event.isReselect) return;
      wantsTitle = false;
      stopBg(STOP_REASON_PHASE);
    });

    // Cannon-phase bg music: starts when the CANNON_PLACE banner begins
    // sweeping and stops when the BATTLE banner takes over. If the upgrade
    // flow started cannon-bg early (upgrade-pick banner), the Build
    // banner's sweep-start stops it — giving us silence during the
    // actual banner sweep before build-bg picks up at bannerSweepEnd.
    bind(GAME_EVENT.BANNER_START, (event) => {
      if (event.bannerKind === "cannon-place") {
        void playBg(BG_TRACK_CANNON);
      } else if (
        event.bannerKind === "battle" ||
        event.bannerKind === "modifier-reveal"
      ) {
        stopBg(STOP_REASON_PHASE);
      } else if (
        event.bannerKind === "build" &&
        bgPlaying === BG_TRACK_CANNON
      ) {
        // Upgrade-pick flow started cannon-bg early to cover the dialog;
        // stop it here so build-bg can take over at bannerSweepEnd.
        stopBg(STOP_REASON_PHASE);
      }
    });

    // Build-phase bg music starts AFTER the "Build & Repair" banner
    // finishes sweeping. The "Choose Upgrade" banner also runs under
    // phase=WALL_BUILD but carries bannerKind="upgrade-pick", so
    // discriminating on kind keeps the cue exclusive to the actual
    // build banner. Fade-out is state-derived, see tickPresentation.
    bind(GAME_EVENT.BANNER_SWEEP_END, (event) => {
      if (event.bannerKind === "build") {
        void playBg(BG_TRACK_BUILD);
      }
    });

    // Between-rounds score-delta overlay: looped bg music for as long as
    // the overlay is displayed.
    bind(GAME_EVENT.SCORE_OVERLAY_START, () => {
      void playBg(BG_TRACK_SCORE);
    });
    bind(GAME_EVENT.SCORE_OVERLAY_END, () => {
      stopBg(STOP_REASON_PHASE);
    });

    // Life-lost popup: one-shot track. Plays through the dialog and into
    // reselect naturally (no loop flag). The next phase's playBg (usually
    // build-bg after a reselect+banner sweep) will cut the tail if it's
    // still ringing — reselect's timer is normally long enough for the
    // stinger to finish first.
    bind(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, () => {
      void playBg(BG_TRACK_LIFE_LOST);
    });

    // Balloon-capture jaws theme: one-shot. Start on animation start, stop
    // on animation end — the track is pinned to exactly BALLOON_FLIGHT_DURATION
    // so natural playback finish and the end event land on the same frame.
    bind(GAME_EVENT.BALLOON_ANIM_START, () => {
      void playBg(BG_TRACK_JAWS);
    });
    bind(GAME_EVENT.BALLOON_ANIM_END, () => {
      stopBg(STOP_REASON_PHASE);
    });

    // Upgrade-pick dialog: play cannon-bg through the whole screen —
    // starts at UPGRADE_PICK_SHOW, keeps playing across the dialog and
    // the following "Build & Repair" banner sweep. The bannerStart
    // handler (kind === "build") stops it; bannerSweepEnd
    // (kind === "build") starts build-bg.
    bind(GAME_EVENT.UPGRADE_PICK_SHOW, () => {
      void playBg(BG_TRACK_CANNON);
    });
  }

  async function activate(): Promise<void> {
    await activateOnce();
  }

  async function setPaused(nextPaused: boolean): Promise<void> {
    paused = nextPaused;
    const ctx = audioContext;
    if (ctx) {
      if (nextPaused && ctx.state === AUDIO_CONTEXT_RUNNING) {
        await ctx.suspend().catch(() => {});
      } else if (!nextPaused && ctx.state === AUDIO_CONTEXT_SUSPENDED) {
        await ctx.resume().catch(() => {});
      }
    }
    // Deferred start: if we were asked to play title while paused, kick it off
    // now that the tab is visible again.
    if (!nextPaused && wantsTitle && bgPlaying !== BG_TRACK_TITLE) {
      await playBg(BG_TRACK_TITLE);
    }
  }

  async function dispose(): Promise<void> {
    unbindCurrentBus();
    stopBg(STOP_REASON_DISPOSE);
    wantsTitle = false;
    if (audioContext) {
      await audioContext.close().catch(() => {});
      audioContext = undefined;
    }
    bgBuffers.clear();
    bgAudioBuffers.clear();
    fanfareBuffers.clear();
    activatingPromise = undefined;
  }

  return {
    activate,
    startTitle: playTitle,
    stopTitle,
    playFanfare,
    subscribeBus,
    tickPresentation,
    setPaused,
    dispose,
  };
}
