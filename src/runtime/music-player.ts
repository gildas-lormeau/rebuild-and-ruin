/**
 * Music sub-system — libadlmidi-js-driven OPL3 playback of player-supplied
 * Rampart music files.
 *
 * Plays RXMI_TITLE.xmi from the moment the subsystem is bound to a game bus
 * (first launch + rematch) until the first WALL_BUILD phase starts. Silent if
 * `MusicAssets` is null (player hasn't dropped in their Rampart files). Mirrors
 * the observer+bus pattern used by [runtime-haptics.ts](./runtime-haptics.ts).
 *
 * ### Autoplay policy
 *
 * Browsers suspend a fresh AudioContext until a user gesture. The first
 * `synth.init()` call therefore may hang pending a click/tap. We don't try to
 * start music at construction time; instead the composition root wires it to
 * the first UI_TAP on each new bus.
 *
 * ### libadlmidi-js
 *
 * Bundled as an npm dep, lazy-loaded on the first `activate()` so the main
 * entry chunk stays small. The processor.js + core.wasm files ship as
 * `new URL(..., import.meta.url)` asset references that Vite emits into
 * dist/ at build time — no CDN at runtime.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` that captures `onPlay(track)` / `onStop`
 * intents, so a scenario can assert "binding this bus would trigger title
 * music" without booting an AudioContext or fetching WASM.
 */

import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
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
  xmiContainerBlocks,
  xmidToSmf,
} from "../shared/platform/xmi-to-smf.ts";
import type { MusicAssets } from "./music-assets.ts";
import type { SynthHandle } from "./music-synth-loader.ts";

interface MusicSubsystem {
  /** Pre-warm the AudioContext + WASM inside a user-gesture handler (the
   *  home-page "Play" button click). Pure side-effect: kicks off synth init
   *  and returns when WOPL is loaded. No playback yet. Safe to call repeatedly;
   *  subsequent calls are no-ops. */
  activate(): Promise<void>;
  /** Start the RXMI_TITLE.xmi track. Called from the lobby entry point so
   *  music covers the pre-game screen. Idempotent per instance. */
  startTitle(): Promise<void>;
  /** Stop any active playback. Idempotent. */
  stopTitle(): Promise<void>;
  /** Play the one-shot tower-enclosure fanfare for a player. Picks a
   *  TETRIS sub-song by player slot (5/6/7 cycle). Interrupts any
   *  currently-loaded MIDI — safe because title has already stopped by
   *  the time the first enclosure happens. */
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
   *  so music doesn't keep looping in a backgrounded tab. No-op until the
   *  synth has been initialized. */
  setPaused(paused: boolean): Promise<void>;
  /** Release the bus listener and stop playback. */
  dispose(): Promise<void>;
}

interface MusicSubsystemDeps {
  /** Live getter so the composition root can construct the subsystem once and
   *  let the settings dialog populate IDB later — the first `activate()` or
   *  bus subscription after files are loaded will pick them up. */
  readonly getAssets: () => MusicAssets | undefined;
  /** Optional promise the subsystem awaits inside `activate()` so the
   *  home-page click handler can race ahead of the initial IDB read without
   *  silently getting null assets. */
  readonly assetsReady?: Promise<void>;
  readonly observer?: MusicObserver;
}

// Global +25 % boost applied on top of each track's base gain. MIDI
// output from libADLMIDI sat noticeably below the PCM SFX layer; lifting
// every synth uniformly keeps the relative mix intact while raising the
// overall music level.
const MIDI_VOLUME_BOOST = 1.25;
const TITLE_TRACK = "RXMI_TITLE.xmi";
const TITLE_SONG_INDEX = 0;
const TITLE_VOLUME = MIDI_VOLUME_BOOST;
const FANFARE_TRACK = "RXMI_TETRIS.xmi";
// Tower-enclosure fanfares live at 0-indexed sub-songs 4/5/6 of
// RXMI_TETRIS.xmi (mapping.txt lists them 1-indexed as 5/6/7). One
// variant per player slot; a hypothetical 4th player reuses slot 0's.
const FANFARE_SONG_BY_SLOT: readonly number[] = [4, 5, 6, 4];
const FANFARE_VOLUME = MIDI_VOLUME_BOOST;
const CANNON_BG_TRACK = "RXMI_CANNON.xmi";
const CANNON_BG_SONG_INDEX = 0;
// RXMI_CANNON is mixed noticeably quieter than RXMI_TETRIS / RXMI_TITLE in
// the original assets. Boost the per-synth gain so cannon-phase bg matches
// the perceived loudness of fanfares and title music.
const CANNON_BG_VOLUME = 4.5 * MIDI_VOLUME_BOOST;
const BUILD_BG_TRACK = "RXMI_TETRIS.xmi";
const BUILD_BG_SONG_INDEX = 0;
// RXMI_TETRIS bg music mix — tune by ear; starting point before audition.
const BUILD_BG_VOLUME = MIDI_VOLUME_BOOST;
// Build bg decrescendo runs on the same 1 s window as the snare's
// crescendo in sfx-player.ts (SNARE_CRESCENDO_SEC): fade STARTS at
// timer = 6.72 s (same instant the snare loop kicks in at 0 gain) and
// ends at timer = 5.72 s (snare at full gain, bg silent). Clean
// cross-fade with mirrored ramps.
const BUILD_BG_FADE_START_SEC = 6.72;
const BUILD_BG_FADE_DURATION_SEC = 1;
// Score-overlay bg music — 0-indexed sub-song 4 of RXMI_SCORE.xmi
// (mapping.txt lists it 1-indexed as "5 -> bg music score"). Loops for
// the duration of the between-rounds score-delta overlay.
const SCORE_BG_TRACK = "RXMI_SCORE.xmi";
const SCORE_BG_SONG_INDEX = 4;
const SCORE_BG_VOLUME = MIDI_VOLUME_BOOST;
// Life-lost popup one-shot — 0-indexed sub-song 1 of RXMI_TETRIS.xmi
// (mapping.txt "2 -> life lost music"). No loop: plays once as the
// dialog appears, finishing naturally during the subsequent reselect.
const LIFE_LOST_TRACK = "RXMI_TETRIS.xmi";
const LIFE_LOST_SONG_INDEX = 1;
const LIFE_LOST_VOLUME = MIDI_VOLUME_BOOST;
const STOP_REASON_PHASE = "phase" as const;
const STOP_REASON_DISPOSE = "dispose" as const;

export function createMusicSubsystem(deps: MusicSubsystemDeps): MusicSubsystem {
  let synthPromise: Promise<SynthHandle> | undefined;
  // One synth per fanfare slot. Each synth owns its own AudioContext +
  // WASM instance, so four fanfares can ring simultaneously when
  // enclosures land within the same ~second (parallel prebuilds). Lazy
  // init on first request per slot; stored by index to match
  // FANFARE_SONG_BY_SLOT.
  const fanfareSynths = new Map<number, Promise<SynthHandle | undefined>>();
  // Cannon-phase background music. One dedicated synth so it doesn't fight
  // the title synth (still loaded but stopped by the time cannon phase hits)
  // or the fanfare pool (can overlap if enclosures happen mid-cannon-phase).
  let cannonBgSynth: Promise<SynthHandle | undefined> | undefined;
  // Build-phase background music. Separate from the fanfare pool (same XMI
  // container, different sub-song) so fanfares landing mid-build don't
  // interrupt the bg loop.
  let buildBgSynth: Promise<SynthHandle | undefined> | undefined;
  // Tracks whether the tick-derived fade signal has already fired in the
  // current WALL_BUILD phase — prevents re-triggering the ramp every frame
  // past the threshold.
  let buildBgFadeTriggered = false;
  // Previous-tick phase for leave-WALL_BUILD edge detection.
  let buildBgLastPhase: Phase | undefined;
  // Score-overlay bg (looped, start/stop on scoreOverlayStart/End).
  let scoreBgSynth: Promise<SynthHandle | undefined> | undefined;
  // Life-lost popup one-shot (no loop, natural end).
  let lifeLostSynth: Promise<SynthHandle | undefined> | undefined;
  let boundBus: GameEventBus | undefined;
  let boundCastleHandler: GameEventHandler<"castlePlaced"> | undefined;
  let boundBannerStartHandler: GameEventHandler<"bannerStart"> | undefined;
  let boundBannerEndHandler: GameEventHandler<"bannerEnd"> | undefined;
  let boundScoreStartHandler: GameEventHandler<"scoreOverlayStart"> | undefined;
  let boundScoreEndHandler: GameEventHandler<"scoreOverlayEnd"> | undefined;
  let boundLifeLostHandler: GameEventHandler<"lifeLostDialogShow"> | undefined;
  // `wantsTitle` is the caller's intent (lobby said "play title"). `playing`
  // is the actual synth state. `paused` means the composition told us the
  // host tab is hidden / externally quieted — we honor wantsTitle but defer
  // the play call until un-paused.
  let wantsTitle = false;
  let playing = false;
  let paused = false;

  async function ensureSynth(): Promise<SynthHandle | undefined> {
    const assets = deps.getAssets();
    if (!assets) return undefined;
    if (!synthPromise) {
      synthPromise = (async () => {
        const loader = await import("./music-synth-loader.ts");
        return loader.loadSynth(assets);
      })().catch((error) => {
        console.error("[music] synth init failed:", error);
        synthPromise = undefined;
        deps.observer?.onInitError?.(error);
        throw error;
      });
    }
    try {
      return await synthPromise;
    } catch {
      return undefined;
    }
  }

  async function playTitle(): Promise<void> {
    wantsTitle = true;
    // Wait for the initial IDB read — the lobby's startTitle() can race ahead.
    if (deps.assetsReady) await deps.assetsReady;
    if (paused) return; // will start when setPaused(false) fires
    await startPlaybackNow();
  }

  async function startPlaybackNow(): Promise<void> {
    if (playing || !wantsTitle || paused) return;
    const assets = deps.getAssets();
    if (!assets) return;
    const synth = await ensureSynth();
    if (!synth || !wantsTitle || paused) return;
    try {
      // Convert XMI sub-song → SMF in memory before handing to libADLMIDI.
      // Its native XMI parser reorders same-tick note-offs and retriggers
      // percussion voices on the "wrong" cleanups, which is catastrophic for
      // drum-channel SFX (verified by `tmp/music-player/scripts/
      // render-and-compare.mjs`; SMF path produces bit-identical PCM to the
      // Python reference tool). Title = sub-song 0 of RXMI_TITLE.xmi.
      const blocks = xmiContainerBlocks(assets.xmi[TITLE_TRACK]);
      const smf = xmidToSmf(blocks[TITLE_SONG_INDEX]!.block);
      if (!smf) {
        console.error("[music] title sub-song has no EVNT chunk");
        return;
      }
      await synth.loadMidi(copyBuffer(smf));
      // Lobby can sit on the title screen indefinitely — loop the ~30s track
      // instead of dropping to silence. Must be set after loadMidi (the flag
      // applies to the currently loaded file).
      synth.setLoopEnabled(true);
      synth.setVolume(TITLE_VOLUME);
      await logLoopInfo(synth);
      await synth.play();
      playing = true;
      deps.observer?.onPlay?.(TITLE_TRACK);
    } catch (error) {
      console.error("[music] startPlaybackNow failed:", error);
    }
  }

  function ensureFanfareSynth(
    playerId: ValidPlayerSlot,
  ): Promise<SynthHandle | undefined> {
    const cached = fanfareSynths.get(playerId);
    if (cached) return cached;
    const songIdx = FANFARE_SONG_BY_SLOT[playerId] ?? FANFARE_SONG_BY_SLOT[0]!;
    const promise = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      const synth = await loader.loadSynth(assets);
      const blocks = xmiContainerBlocks(assets.xmi[FANFARE_TRACK]);
      const block = blocks[songIdx]?.block;
      if (!block) {
        console.warn(`[music] fanfare song ${songIdx} missing in TETRIS.xmi`);
        return undefined;
      }
      const smf = xmidToSmf(block);
      if (!smf) {
        console.warn(`[music] fanfare song ${songIdx} has no EVNT chunk`);
        return undefined;
      }
      await synth.loadMidi(copyBuffer(smf));
      synth.setLoopEnabled(false);
      synth.setVolume(FANFARE_VOLUME);
      return synth;
    })().catch((error) => {
      console.error(
        `[music] fanfare synth init failed for slot ${playerId}:`,
        error,
      );
      fanfareSynths.delete(playerId);
      return undefined;
    });
    fanfareSynths.set(playerId, promise);
    return promise;
  }

  async function playFanfare(playerId: ValidPlayerSlot): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureFanfareSynth(playerId);
    if (!synth) return;
    try {
      // stop() then play() rewinds so a repeat enclosure (next phase)
      // replays the fanfare from the top instead of idling at the tail.
      await synth.stop();
      await synth.play();
      deps.observer?.onPlay?.(`${FANFARE_TRACK}#slot${playerId}`);
    } catch (error) {
      console.error(
        `[music] fanfare playback failed for slot ${playerId}:`,
        error,
      );
    }
  }

  function ensureCannonBgSynth(): Promise<SynthHandle | undefined> {
    if (cannonBgSynth) return cannonBgSynth;
    cannonBgSynth = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      const synth = await loader.loadSynth(assets);
      const blocks = xmiContainerBlocks(assets.xmi[CANNON_BG_TRACK]);
      const block = blocks[CANNON_BG_SONG_INDEX]?.block;
      if (!block) {
        console.warn(`[music] cannon bg song missing in CANNON.xmi`);
        return undefined;
      }
      const smf = xmidToSmf(block);
      if (!smf) {
        console.warn(`[music] cannon bg song has no EVNT chunk`);
        return undefined;
      }
      await synth.loadMidi(copyBuffer(smf));
      // Cannon phase runs ~15 s but the XMI track is shorter; loop so the
      // music covers the whole placement window until BATTLE banner stops it.
      synth.setLoopEnabled(true);
      synth.setVolume(CANNON_BG_VOLUME);
      return synth;
    })().catch((error) => {
      console.error("[music] cannon bg synth init failed:", error);
      cannonBgSynth = undefined;
      return undefined;
    });
    return cannonBgSynth;
  }

  async function playCannonBg(): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureCannonBgSynth();
    if (!synth || paused) return;
    try {
      // stop() then play() rewinds so each round's cannon phase starts the
      // loop from the top instead of resuming mid-track from a prior round.
      await synth.stop();
      await synth.play();
      deps.observer?.onPlay?.(CANNON_BG_TRACK);
    } catch (error) {
      console.error("[music] cannon bg playback failed:", error);
    }
  }

  async function stopCannonBg(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    if (!cannonBgSynth) return;
    try {
      const synth = await cannonBgSynth;
      await synth?.stop();
      deps.observer?.onStop?.(reason);
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
  }

  function ensureBuildBgSynth(): Promise<SynthHandle | undefined> {
    if (buildBgSynth) return buildBgSynth;
    buildBgSynth = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      const synth = await loader.loadSynth(assets);
      const blocks = xmiContainerBlocks(assets.xmi[BUILD_BG_TRACK]);
      const block = blocks[BUILD_BG_SONG_INDEX]?.block;
      if (!block) {
        console.warn("[music] build bg song missing in TETRIS.xmi");
        return undefined;
      }
      const smf = xmidToSmf(block);
      if (!smf) {
        console.warn("[music] build bg song has no EVNT chunk");
        return undefined;
      }
      await synth.loadMidi(copyBuffer(smf));
      synth.setLoopEnabled(true);
      return synth;
    })().catch((error) => {
      console.error("[music] build bg synth init failed:", error);
      buildBgSynth = undefined;
      return undefined;
    });
    return buildBgSynth;
  }

  async function playBuildBg(): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureBuildBgSynth();
    if (!synth || paused) return;
    try {
      // Reset gain to nominal — the previous round's fade ramped it to 0,
      // and cancelScheduledValues won't retroactively undo the ramp target.
      synth.setVolume(BUILD_BG_VOLUME);
      await synth.stop();
      await synth.play();
      buildBgFadeTriggered = false;
      deps.observer?.onPlay?.(BUILD_BG_TRACK);
    } catch (error) {
      console.error("[music] build bg playback failed:", error);
    }
  }

  async function stopBuildBg(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    if (!buildBgSynth) return;
    try {
      const synth = await buildBgSynth;
      await synth?.stop();
      deps.observer?.onStop?.(reason);
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
  }

  async function fadeOutBuildBg(): Promise<void> {
    if (!buildBgSynth) return;
    const synth = await buildBgSynth;
    synth?.fadeTo(0, BUILD_BG_FADE_DURATION_SEC);
  }

  function ensureScoreBgSynth(): Promise<SynthHandle | undefined> {
    if (scoreBgSynth) return scoreBgSynth;
    scoreBgSynth = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      const synth = await loader.loadSynth(assets);
      const blocks = xmiContainerBlocks(assets.xmi[SCORE_BG_TRACK]);
      const block = blocks[SCORE_BG_SONG_INDEX]?.block;
      if (!block) {
        console.warn("[music] score bg song missing in SCORE.xmi");
        return undefined;
      }
      const smf = xmidToSmf(block);
      if (!smf) {
        console.warn("[music] score bg song has no EVNT chunk");
        return undefined;
      }
      await synth.loadMidi(copyBuffer(smf));
      synth.setLoopEnabled(true);
      synth.setVolume(SCORE_BG_VOLUME);
      return synth;
    })().catch((error) => {
      console.error("[music] score bg synth init failed:", error);
      scoreBgSynth = undefined;
      return undefined;
    });
    return scoreBgSynth;
  }

  async function playScoreBg(): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureScoreBgSynth();
    if (!synth || paused) return;
    try {
      await synth.stop();
      await synth.play();
      deps.observer?.onPlay?.(SCORE_BG_TRACK);
    } catch (error) {
      console.error("[music] score bg playback failed:", error);
    }
  }

  async function stopScoreBg(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    if (!scoreBgSynth) return;
    try {
      const synth = await scoreBgSynth;
      await synth?.stop();
      deps.observer?.onStop?.(reason);
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
  }

  function ensureLifeLostSynth(): Promise<SynthHandle | undefined> {
    if (lifeLostSynth) return lifeLostSynth;
    lifeLostSynth = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      const synth = await loader.loadSynth(assets);
      const blocks = xmiContainerBlocks(assets.xmi[LIFE_LOST_TRACK]);
      const block = blocks[LIFE_LOST_SONG_INDEX]?.block;
      if (!block) {
        console.warn("[music] life-lost song missing in TETRIS.xmi");
        return undefined;
      }
      const smf = xmidToSmf(block);
      if (!smf) {
        console.warn("[music] life-lost song has no EVNT chunk");
        return undefined;
      }
      await synth.loadMidi(copyBuffer(smf));
      // One-shot — no loop. Playback ends naturally; next lifeLost replays
      // via stop()+play() rewind in playLifeLost.
      synth.setLoopEnabled(false);
      synth.setVolume(LIFE_LOST_VOLUME);
      return synth;
    })().catch((error) => {
      console.error("[music] life-lost synth init failed:", error);
      lifeLostSynth = undefined;
      return undefined;
    });
    return lifeLostSynth;
  }

  async function playLifeLost(): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureLifeLostSynth();
    if (!synth || paused) return;
    try {
      await synth.stop();
      await synth.play();
      deps.observer?.onPlay?.(LIFE_LOST_TRACK);
    } catch (error) {
      console.error("[music] life-lost playback failed:", error);
    }
  }

  function tickPresentation(state: GameState): void {
    const phase = state.phase;
    // Edge: just left WALL_BUILD — hard-stop the synth (safety net in case
    // the fade signal never crossed, e.g. build phase cut short by a rule
    // we don't know about yet).
    if (buildBgLastPhase === Phase.WALL_BUILD && phase !== Phase.WALL_BUILD) {
      void stopBuildBg(STOP_REASON_PHASE);
      buildBgFadeTriggered = false;
    }
    buildBgLastPhase = phase;

    if (phase !== Phase.WALL_BUILD) return;
    if (buildBgFadeTriggered) return;
    if (state.timer <= 0 || state.timer > BUILD_BG_FADE_START_SEC) return;
    buildBgFadeTriggered = true;
    void fadeOutBuildBg();
  }

  async function stopPlayback(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    wantsTitle = false;
    playing = false;
    if (!synthPromise) return;
    try {
      const synth = await synthPromise;
      await synth.stop();
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
    deps.observer?.onStop?.(reason);
  }

  function unbindCurrentBus(): void {
    if (boundBus) {
      if (boundCastleHandler)
        boundBus.off(GAME_EVENT.CASTLE_PLACED, boundCastleHandler);
      if (boundBannerStartHandler)
        boundBus.off(GAME_EVENT.BANNER_START, boundBannerStartHandler);
      if (boundBannerEndHandler)
        boundBus.off(GAME_EVENT.BANNER_END, boundBannerEndHandler);
      if (boundScoreStartHandler)
        boundBus.off(GAME_EVENT.SCORE_OVERLAY_START, boundScoreStartHandler);
      if (boundScoreEndHandler)
        boundBus.off(GAME_EVENT.SCORE_OVERLAY_END, boundScoreEndHandler);
      if (boundLifeLostHandler)
        boundBus.off(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, boundLifeLostHandler);
    }
    boundBus = undefined;
    boundCastleHandler = undefined;
    boundBannerStartHandler = undefined;
    boundBannerEndHandler = undefined;
    boundScoreStartHandler = undefined;
    boundScoreEndHandler = undefined;
    boundLifeLostHandler = undefined;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    // Stop the title track the moment any player confirms their starting
    // castle. Ignore `isReselect` — after a mid-game castle reselect the
    // title isn't playing anyway.
    const castleHandler: GameEventHandler<"castlePlaced"> = (event) => {
      if (!event.isReselect) void stopPlayback(STOP_REASON_PHASE);
    };
    // Cannon-phase bg music: starts when the CANNON_PLACE banner begins
    // sweeping and stops when the BATTLE banner takes over. The handler
    // fires every round, so stop+play rewinds the loop each cycle.
    const bannerStartHandler: GameEventHandler<"bannerStart"> = (event) => {
      if (event.phase === Phase.CANNON_PLACE) void playCannonBg();
      else if (event.phase === Phase.BATTLE)
        void stopCannonBg(STOP_REASON_PHASE);
    };
    // Build-phase bg music starts AFTER the WALL_BUILD banner finishes
    // sweeping — bannerEnd gives us that post-sweep edge. Fade-out is
    // state-derived, see tickPresentation.
    const bannerEndHandler: GameEventHandler<"bannerEnd"> = (event) => {
      if (event.phase === Phase.WALL_BUILD) void playBuildBg();
    };
    // Between-rounds score-delta overlay: looped bg music for as long as
    // the overlay is displayed.
    const scoreStartHandler: GameEventHandler<"scoreOverlayStart"> = () => {
      void playScoreBg();
    };
    const scoreEndHandler: GameEventHandler<"scoreOverlayEnd"> = () => {
      void stopScoreBg(STOP_REASON_PHASE);
    };
    // Life-lost popup: one-shot track. Continues to play naturally into
    // the reselect phase (no looped bg music runs during reselect).
    const lifeLostHandler: GameEventHandler<"lifeLostDialogShow"> = () => {
      void playLifeLost();
    };
    bus.on(GAME_EVENT.CASTLE_PLACED, castleHandler);
    bus.on(GAME_EVENT.BANNER_START, bannerStartHandler);
    bus.on(GAME_EVENT.BANNER_END, bannerEndHandler);
    bus.on(GAME_EVENT.SCORE_OVERLAY_START, scoreStartHandler);
    bus.on(GAME_EVENT.SCORE_OVERLAY_END, scoreEndHandler);
    bus.on(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, lifeLostHandler);
    boundBus = bus;
    boundCastleHandler = castleHandler;
    boundBannerStartHandler = bannerStartHandler;
    boundBannerEndHandler = bannerEndHandler;
    boundScoreStartHandler = scoreStartHandler;
    boundScoreEndHandler = scoreEndHandler;
    boundLifeLostHandler = lifeLostHandler;
  }

  async function activate(): Promise<void> {
    if (deps.assetsReady) await deps.assetsReady;
    await ensureSynth();
  }

  async function suspendContext(context: AudioContext | null): Promise<void> {
    if (!context || context.state !== AUDIO_CONTEXT_RUNNING) return;
    await context.suspend().catch(() => {});
  }

  async function resumeContext(context: AudioContext | null): Promise<void> {
    if (!context || context.state !== AUDIO_CONTEXT_SUSPENDED) return;
    await context.resume().catch(() => {});
  }

  async function setPaused(nextPaused: boolean): Promise<void> {
    paused = nextPaused;
    const mainSynth = synthPromise
      ? await synthPromise.catch(() => undefined)
      : undefined;
    // Suspend/resume every synth — the fanfare pool holds its own
    // AudioContexts, so backgrounding the tab needs to quiet them too
    // (otherwise a fanfare started just before visibility-change keeps
    // ringing).
    const fanfareSnapshots = await Promise.all(
      Array.from(fanfareSynths.values()).map((pending) =>
        pending.catch(() => undefined),
      ),
    );
    const cannonBg = cannonBgSynth
      ? await cannonBgSynth.catch(() => undefined)
      : undefined;
    const buildBg = buildBgSynth
      ? await buildBgSynth.catch(() => undefined)
      : undefined;
    const scoreBg = scoreBgSynth
      ? await scoreBgSynth.catch(() => undefined)
      : undefined;
    const lifeLost = lifeLostSynth
      ? await lifeLostSynth.catch(() => undefined)
      : undefined;
    for (const synth of [
      mainSynth,
      cannonBg,
      buildBg,
      scoreBg,
      lifeLost,
      ...fanfareSnapshots,
    ]) {
      if (nextPaused) await suspendContext(synth?.audioContext ?? null);
      else await resumeContext(synth?.audioContext ?? null);
    }
    // Deferred start: if we were asked to play title while paused, kick it off
    // now that the tab is visible again.
    if (!nextPaused && wantsTitle && !playing) {
      await startPlaybackNow();
    }
  }

  async function dispose(): Promise<void> {
    unbindCurrentBus();
    await stopPlayback(STOP_REASON_DISPOSE);
    await stopCannonBg(STOP_REASON_DISPOSE);
    await stopBuildBg(STOP_REASON_DISPOSE);
    await stopScoreBg(STOP_REASON_DISPOSE);
    // Shut down the fanfare synth pool — each owns an AudioContext we
    // must explicitly close, otherwise rematches stack new ones on top
    // (browsers cap the total and will refuse new contexts eventually).
    for (const [, fanfarePromise] of fanfareSynths) {
      const synth = await fanfarePromise.catch(() => undefined);
      if (!synth) continue;
      await synth.stop().catch(() => {});
      await synth.audioContext?.close().catch(() => {});
    }
    fanfareSynths.clear();
    // Same teardown for the cannon bg synth.
    if (cannonBgSynth) {
      const synth = await cannonBgSynth.catch(() => undefined);
      await synth?.audioContext?.close().catch(() => {});
      cannonBgSynth = undefined;
    }
    // Same teardown for the build bg synth.
    if (buildBgSynth) {
      const synth = await buildBgSynth.catch(() => undefined);
      await synth?.audioContext?.close().catch(() => {});
      buildBgSynth = undefined;
    }
    // Same teardown for the score bg synth.
    if (scoreBgSynth) {
      const synth = await scoreBgSynth.catch(() => undefined);
      await synth?.audioContext?.close().catch(() => {});
      scoreBgSynth = undefined;
    }
    // Life-lost synth (one-shot, no explicit stop in the normal flow).
    if (lifeLostSynth) {
      const synth = await lifeLostSynth.catch(() => undefined);
      await synth?.stop().catch(() => {});
      await synth?.audioContext?.close().catch(() => {});
      lifeLostSynth = undefined;
    }
  }

  return {
    activate,
    startTitle: playTitle,
    stopTitle: () => stopPlayback(STOP_REASON_PHASE),
    playFanfare,
    subscribeBus,
    tickPresentation,
    setPaused,
    dispose,
  };
}

async function logLoopInfo(synth: SynthHandle): Promise<void> {
  try {
    const [start, end, title, markers, songs] = await Promise.all([
      synth.getLoopStartTime(),
      synth.getLoopEndTime(),
      synth.getMusicTitle(),
      synth.getMarkerCount(),
      synth.getSongsCount(),
    ]);
    const startStr = start < 0 ? "—" : `${start.toFixed(3)}s`;
    const endStr = end < 0 ? "—" : `${end.toFixed(3)}s`;
    console.log(
      `[music] title="${title}" songs=${songs} markers=${markers} loop=${startStr}→${endStr}`,
    );
  } catch (error) {
    console.warn("[music] loop info query failed:", error);
  }
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  // AudioWorklet messaging transfers ownership — always hand over a copy so the
  // caller's view of MusicAssets stays intact after postMessage.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
