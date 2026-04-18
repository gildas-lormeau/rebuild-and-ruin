/**
 * SFX sub-system — plays PCM samples from Rampart's SOUND.RSC via Web Audio.
 *
 * Parallel to [music-player.ts](./music-player.ts) but for Sound Blaster
 * digital-sample SFX (brick clunks, cannon shots, banner whoosh, voice
 * announcements, firework whistles). The 37 VOC chunks are parsed once from
 * `assets.soundRsc`; each is decoded to an AudioBuffer lazily on first use
 * and cached for re-play. BufferSource per trigger = native polyphony for
 * free (rapid-fire brick hits can overlap).
 *
 * Two signal pathways:
 *   1. **Bus-event mappings (`SFX_EVENT_MAP`)** — one-shot cues tied to
 *      discrete domain events: cannonFired, bannerStart, towerEnclosed, etc.
 *   2. **Presentational derivation (`tickPresentation`)** — continuous
 *      signals computed each frame from `GameState`. The snare-roll loop
 *      is an observation of "we're in the last 6 displayed seconds of a
 *      timed phase", not a discrete transition, so it lives here rather
 *      than on the bus. Adding another continuous cue (e.g. "cannon
 *      charging", "life critically low") = one line in `deriveSfxSignals`.
 *
 * Observer hook mirrors music/haptics so scenario tests can assert
 * "wallPlaced emitted sample 'clunk1'" without needing an AudioContext.
 */

import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
  type GameEventMap,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { SfxObserver } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  AUDIO_CONTEXT_RUNNING,
  AUDIO_CONTEXT_SUSPENDED,
} from "../shared/platform/platform.ts";
import { type PcmSample, parseSoundRsc } from "../shared/platform/sound-rsc.ts";
import type { MusicAssets } from "./music-assets.ts";

interface SfxSubsystem {
  /** Prime the AudioContext inside a user-gesture handler. Safe to call
   *  repeatedly; later calls are no-ops. */
  activate(): Promise<void>;
  /** Play a named SOUND.RSC sample once. Resolves with the
   *  `AudioBufferSourceNode` driving playback (so callers can chain
   *  `onended`) or undefined when the sample or context isn't available.
   *  No-op if assets aren't loaded. */
  playSample(name: string): Promise<AudioBufferSourceNode | undefined>;
  /** Bind to a per-game bus so entity/lifecycle events fire the mapped
   *  sample. Re-binding unsubscribes from the previous bus. */
  subscribeBus(bus: GameEventBus): void;
  /** Discard the cached SOUND.RSC parse + decoded buffers. Call when the
   *  asset bytes have changed (sound modal reloaded a different Rampart
   *  install) so the next `playSample` re-reads from `getAssets()`. */
  refreshSamples(): void;
  /** Compute continuous presentational signals from the current game
   *  state and react to transitions since the last call. Called once per
   *  frame by the runtime after state mutation — pure enough to skip
   *  when paused / disposed. */
  tickPresentation(state: GameState): void;
  /** Suspend/resume the AudioContext — wired to `visibilitychange`. */
  setPaused(paused: boolean): Promise<void>;
  dispose(): Promise<void>;
}

interface SfxSignals {
  /** We're in the snare-worthy tail of a timed drafting phase. */
  readonly countdownActive: boolean;
}

interface SfxSubsystemDeps {
  readonly getAssets: () => MusicAssets | undefined;
  readonly assetsReady?: Promise<void>;
  readonly observer?: SfxObserver;
  /** Called once per player per build/select phase, scheduled to fire right
   *  as the enclosure stinger (elechit1) finishes — the composition root
   *  wires this to the music subsystem's fanfare playback. */
  readonly onFirstEnclosure?: (playerId: ValidPlayerSlot) => void;
}

interface SfxMapping<K extends keyof GameEventMap> {
  readonly sample: string;
  /** Optional predicate — sample only plays when this returns true. Used to
   *  scope per-event-type handlers to specific payload shapes (e.g. the banner
   *  whoosh fires on BATTLE transitions only, not every phase swap). */
  readonly filter?: (event: GameEventMap[K]) => boolean;
  /** Minimum seconds between consecutive plays of this sample — events
   *  firing sooner are silently dropped. Used for rate-limiting rapid
   *  streams (castle prebuild blkhit1: ~30 tile events per castle coalesce
   *  down to ~12 audible hits). Tracked by sample name in wall-clock, so
   *  two parallel castle builds share the same airspace instead of
   *  doubling up. Omit for unconstrained firing. */
  readonly minGapSec?: number;
  /** Symmetric jitter (± seconds) added to the next cooldown after each
   *  play — turns a metronomic stream into a clumsy-worker stream. Only
   *  meaningful with `minGapSec`. */
  readonly minGapJitterSec?: number;
}

type SfxEventMap = {
  readonly [K in keyof GameEventMap]?: SfxMapping<K>;
};

/** Phases whose countdown triggers the snare-roll: initial castle select
 *  and wall-build. Reselect, cannon-place, and battle are skipped. */
const COUNTDOWN_SNARE_PHASES: ReadonlySet<Phase> = new Set([
  Phase.CASTLE_SELECT,
  Phase.WALL_BUILD,
]);
/** Start-time for the snare-roll loop, expressed as raw `state.timer`
 *  seconds. Chosen so that 7 full loops of snarerl1 (7 × 960 ms = 6.72 s)
 *  fit exactly between the trigger and the phase-end — the final loop
 *  ends the instant "0s" disappears. Display still reads "6s" at the
 *  trigger (ceil(6.72 - TIMER_DISPLAY_LAG_SEC) = ceil(5.72) = 6), which
 *  is when the player expects the drum-roll. */
const COUNTDOWN_SNARE_RAW_SEC = 6.72;
/** Phases during which the fanfare rule applies: the player's first
 *  enclosed alive tower in one of these phases triggers the fanfare,
 *  unless they had an enclosed alive tower at phase entry. Other
 *  phases (CANNON_PLACE / BATTLE / UPGRADE_PICK) don't produce new
 *  enclosures, so they're excluded from the pre-seed check. */
const FANFARE_PHASES: ReadonlySet<Phase> = new Set([
  Phase.CASTLE_SELECT,
  Phase.CASTLE_RESELECT,
  Phase.WALL_BUILD,
]);
/** Crescendo applied to the looping snare when it starts — snarerl1 is a
 *  uniform-volume drum roll (peak mid-cycle, no natural ramp-in), so we
 *  ramp the output gain from 0 to 1 over this window for the drum-roll
 *  tension build-up. Mirrors the build-bg decrescendo in music-player.ts
 *  so the two signals cross-fade on the same 1 s window. */
const SNARE_CRESCENDO_SEC = 1;
/** Winner color-end stinger chained after `welldone` at gameEnd. Indexed
 *  by player slot: 0 = Red, 1 = Blue, 2 = Gold (the DOS sample names
 *  abbreviate gold as "org"). A hypothetical 4th slot reuses Red's. */
const WINNER_END_SAMPLE_BY_SLOT: readonly string[] = [
  "redend",
  "bluend",
  "orgend",
  "redend",
];
/** Firework-whistle sample name per variant index. Order MUST match
 *  `WHISTLE_VARIANT_DURATIONS_SEC` in battle-system.ts — the variant id
 *  on `cannonballDescending` events is that array's index. Keeping the
 *  asset names here (not in game state) means renaming a sample or
 *  swapping the SOUND.RSC pack never touches the wire protocol, the
 *  Cannonball shape, or the determinism fixtures. */
const CANNONBALL_WHISTLE_SAMPLES: readonly string[] = [
  "fwwhist1",
  "fwwhist3",
  "fwwhist2",
];
/** Map of bus-event → sample (+ optional filter). Lookup happens at emit
 *  time, so editing an entry only affects subsequent events. */
const SFX_EVENT_MAP: SfxEventMap = {
  cannonPlaced: { sample: "clunk1" },
  cannonFired: { sample: "baboom" },
  battleReady: { sample: "ready" },
  battleAim: { sample: "aim" },
  battleFire: { sample: "fire" },
  battleCease: { sample: "cease" },
  wallPlaced: { sample: "dblclic" },
  castlePlaced: { sample: "clunk2" },
  wallDestroyed: { sample: "exp3" },
  // Large explosion reserved for the destruction hit only — non-destroy
  // damage ticks carry no extra SFX (the ball whistle + impact visual
  // already sell the hit).
  cannonDamaged: {
    sample: "explrg1",
    filter: (event) => event.newHp <= 0,
  },
  // Mid-sized splat — between wall hits (exp3) and cannon destruction
  // (explrg1). Fits a grunt getting crushed by a cannonball.
  gruntKilled: { sample: "exp2" },
  // woodcrus — wooden-crunch sample fires in both phases: build-phase
  // wall-on-top-of-house (via houseCrushed) and battle-phase cannonball
  // destroying a house (via houseDestroyed).
  houseCrushed: { sample: "woodcrus" },
  houseDestroyed: { sample: "woodcrus" },
  bannerStart: {
    sample: "whoosh2",
    filter: (event) => event.phase === Phase.BATTLE,
  },
  castleBuildTile: {
    sample: "blkhit1",
    // 30-tile castle = 4.8s of tile events (one every 160ms). ~400ms
    // average gap collapses to ~12 audible hits per castle; two parallel
    // builds staggered by ~1s cap at ~14-15 total because the rate-limit
    // is per-sample-name. Jitter (±200ms) gives the hits a clumsy-worker
    // rhythm instead of a steady metronome.
    minGapSec: 0.4,
    minGapJitterSec: 0.2,
  },
  // Handled outside this map (subscribeBus ties each to a hand-written
  // handler because the one-sample-per-event-type shape can't express
  // what they need):
  //   - towerEnclosed: plays elechit1, then chains the player's fanfare
  //     on the first enclosure per player per phase.
  //   - gameEnd: plays welldone, then chains the winner's color stinger
  //     (redend / bluend / orgend).
  //   - bannerStart (isFinalBattle branch): layers `final` on top of the
  //     whoosh2 sweep mapped via this event map.
  //   - cannonballDescending: picks a fwwhist variant by payload index
  //     (CANNONBALL_WHISTLE_SAMPLES above).
  //
  // Reserved for future features (no mapping yet):
  //   - placecan, capture, rotate, redbeg, blubeg, orgbeg — cannon tutorial.
  //   - alive, agony2, blade, guill2 — guillotine (defeat) screen.
  //   - zap1 — "enclosed tower highlight" overlay before/after the score screen.
  //   - cannon1, magnum1 — parked as alternate cannon-fire samples for future
  //     variety (e.g. captured-cannon cue). baboom covers all cannons today.
};

export function createSfxSubsystem(deps: SfxSubsystemDeps): SfxSubsystem {
  let audioContext: AudioContext | undefined;
  let samplesByName: Map<string, PcmSample> | undefined;
  const buffers = new Map<string, AudioBuffer>();
  // performance.now() timestamp (ms) the next play of each sample is
  // allowed at — used to enforce `minGapSec` (+ per-play jitter). Plain
  // wall-clock because that's what matters perceptually, and it doesn't
  // depend on AudioContext existing.
  const nextAllowedMsBySample = new Map<string, number>();
  // Players who've already triggered their fanfare in the current build /
  // select phase. Cleared on every `phaseStart` event — CASTLE_SELECT,
  // WALL_BUILD, and CASTLE_RESELECT each get a fresh first-enclosure.
  // When entering WALL_BUILD, players who already hold ≥ 1 enclosed alive
  // tower get pre-added so additional enclosures in that phase stay
  // silent — the fanfare is an intro cue, not a repeat-landmark cue.
  const fanfarePlayedThisPhase = new Set<ValidPlayerSlot>();
  // Phase from the previous tick — used in tickPresentation to detect
  // entries into WALL_BUILD for the fanfare pre-seed.
  let lastPhase: Phase | undefined;
  // Looping snare-roll source while a timed phase is in its last 6
  // seconds. Single source because the player only ever hears one
  // countdown at a time. Started/stopped on derived-signal transitions,
  // not on bus events.
  let snareSource: AudioBufferSourceNode | undefined;
  // Last frame's derived signals — diffed against the next frame to
  // detect transitions (signal rose / signal fell).
  let lastSignals: SfxSignals = { countdownActive: false };
  let boundBus: GameEventBus | undefined;
  type EventKey = keyof GameEventMap;
  const boundHandlers: Array<{
    type: EventKey;
    handler: GameEventHandler<EventKey>;
  }> = [];
  let paused = false;
  let disposed = false;

  function ensureSamples(): Map<string, PcmSample> | undefined {
    if (samplesByName) return samplesByName;
    const assets = deps.getAssets();
    if (!assets?.soundRsc) return undefined;
    const parsed = parseSoundRsc(assets.soundRsc);
    samplesByName = new Map(parsed.map((sample) => [sample.name, sample]));
    return samplesByName;
  }

  function ensureContext(): AudioContext | undefined {
    if (audioContext) return audioContext;
    if (typeof AudioContext === "undefined") return undefined;
    audioContext = new AudioContext();
    return audioContext;
  }

  async function activate(): Promise<void> {
    if (deps.assetsReady) await deps.assetsReady;
    const context = ensureContext();
    if (context && context.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await context.resume();
      } catch {
        // Browser may refuse outside a user gesture — caller handles the retry.
      }
    }
    ensureSamples();
  }

  function decodeSample(sample: PcmSample, context: AudioContext): AudioBuffer {
    const cached = buffers.get(sample.name);
    if (cached) return cached;
    // Creative VOC codec 0 is unsigned 8-bit PCM: 0 → -1, 128 → 0, 255 → ~1.
    const buffer = context.createBuffer(
      1,
      sample.pcm.length,
      sample.sampleRate,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sample.pcm.length; i += 1) {
      channel[i] = (sample.pcm[i]! - 128) / 128;
    }
    buffers.set(sample.name, buffer);
    return buffer;
  }

  async function playSample(
    name: string,
  ): Promise<AudioBufferSourceNode | undefined> {
    if (disposed || paused) return undefined;
    const samples = ensureSamples();
    const sample = samples?.get(name);
    if (!sample) {
      deps.observer?.onMissing?.(name);
      return undefined;
    }
    const context = ensureContext();
    if (!context) return undefined;
    if (context.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await context.resume();
      } catch {
        return undefined;
      }
    }
    const buffer = decodeSample(sample, context);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    deps.observer?.onPlaySample?.(name);
    return source;
  }

  function unbindCurrentBus(): void {
    if (boundBus) {
      for (const { type, handler } of boundHandlers) {
        boundBus.off(type, handler);
      }
    }
    boundBus = undefined;
    boundHandlers.length = 0;
    // Rematch / dispose shouldn't leave a snare loop ringing. Also reset
    // the derived-signal memory so the next game's first critical frame
    // registers as a transition, not a continuation.
    stopSnareLoop();
    lastSignals = { countdownActive: false };
    fanfarePlayedThisPhase.clear();
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    boundBus = bus;
    for (const [eventType, mapping] of Object.entries(SFX_EVENT_MAP) as Array<
      [EventKey, SfxMapping<EventKey>]
    >) {
      const { sample, filter, minGapSec, minGapJitterSec } = mapping;
      const handler: GameEventHandler<EventKey> = (event) => {
        if (filter && !filter(event)) return;
        if (minGapSec !== undefined) {
          const nowMs = performance.now();
          const nextAllowedMs = nextAllowedMsBySample.get(sample) ?? 0;
          if (nowMs < nextAllowedMs) return;
          // Each play schedules its own cooldown: base gap ± jitter.
          // Rolling the jitter at play time (not at event time) means
          // dropped events don't inflate the real cadence.
          const jitterSec = (minGapJitterSec ?? 0) * (Math.random() * 2 - 1);
          const nextGapMs = Math.max(0, (minGapSec + jitterSec) * 1000);
          nextAllowedMsBySample.set(sample, nowMs + nextGapMs);
        }
        void playSample(sample);
      };
      bus.on(eventType, handler);
      boundHandlers.push({ type: eventType, handler });
    }
    // phaseStart — fresh fanfare budget for the new phase.
    const phaseStartHandler: GameEventHandler<"phaseStart"> = () => {
      fanfarePlayedThisPhase.clear();
    };
    bus.on(GAME_EVENT.PHASE_START, phaseStartHandler);
    boundHandlers.push({
      type: GAME_EVENT.PHASE_START,
      handler: phaseStartHandler as GameEventHandler<EventKey>,
    });
    // towerEnclosed — play elechit1, and on the player's first enclosure
    // this phase schedule the fanfare via Web Audio's own clock: stop the
    // BufferSource at +FANFARE_AFTER_SEC so the `ended` event fires
    // exactly there. No setTimeout, no wall-clock math.
    const FANFARE_AFTER_SEC = 0.4;
    const enclosedHandler: GameEventHandler<"towerEnclosed"> = (event) => {
      const isFirst = !fanfarePlayedThisPhase.has(event.playerId);
      const playerId = event.playerId;
      void playSample("elechit1").then((source) => {
        if (!isFirst) return;
        fanfarePlayedThisPhase.add(playerId);
        if (!deps.onFirstEnclosure) return;
        if (!source || !audioContext) {
          deps.onFirstEnclosure(playerId);
          return;
        }
        try {
          source.stop(audioContext.currentTime + FANFARE_AFTER_SEC);
        } catch {
          // Some browsers throw if stop() is scheduled past buffer end —
          // the natural-end `ended` event still fires in that case.
        }
        source.addEventListener("ended", () => {
          if (disposed) return;
          deps.onFirstEnclosure?.(playerId);
        });
      });
    };
    bus.on(GAME_EVENT.TOWER_ENCLOSED, enclosedHandler);
    boundHandlers.push({
      type: GAME_EVENT.TOWER_ENCLOSED,
      handler: enclosedHandler as GameEventHandler<EventKey>,
    });
    // gameEnd — play "well done" then chain the winner's color-end
    // stinger (redend / bluend / orgend) on the `ended` event of the
    // welldone source. Slots: 0 = Red, 1 = Blue, 2 = Gold (org in the
    // DOS sample naming).
    const gameEndHandler: GameEventHandler<"gameEnd"> = (event) => {
      const winnerSample = WINNER_END_SAMPLE_BY_SLOT[event.winner];
      if (!winnerSample) return;
      void playSample("welldone").then((source) => {
        if (!source) {
          void playSample(winnerSample);
          return;
        }
        source.addEventListener("ended", () => {
          if (disposed) return;
          void playSample(winnerSample);
        });
      });
    };
    bus.on(GAME_EVENT.GAME_END, gameEndHandler);
    boundHandlers.push({
      type: GAME_EVENT.GAME_END,
      handler: gameEndHandler as GameEventHandler<EventKey>,
    });
    // Final-battle intro — the BATTLE banner of the last round plays
    // "final" on top of the regular whoosh2 sweep. Out-of-map because
    // bannerStart already maps to whoosh2 via SFX_EVENT_MAP; this is the
    // second, conditional play for the same event. Skip the modifier-
    // reveal banner that precedes the battle banner in modern mode —
    // "final" belongs on the plain "Prepare for Battle" sweep, not on
    // the modifier announcement.
    const finalBattleHandler: GameEventHandler<"bannerStart"> = (event) => {
      if (!event.isFinalBattle) return;
      if (event.modifierId !== undefined) return;
      void playSample("final");
    };
    bus.on(GAME_EVENT.BANNER_START, finalBattleHandler);
    boundHandlers.push({
      type: GAME_EVENT.BANNER_START,
      handler: finalBattleHandler as GameEventHandler<EventKey>,
    });
    // cannonballDescending — variant was picked at launch (in battle-
    // system) so its full sample duration fits in the remaining travel
    // time, putting the built-in pop on impact. The event carries only
    // an index; this file owns the id → sample name mapping so game state
    // and the determinism fixtures stay asset-agnostic. Out-of-map
    // because SFX_EVENT_MAP takes a single sample per event type.
    const descendingHandler: GameEventHandler<"cannonballDescending"> = (
      event,
    ) => {
      const sampleName = CANNONBALL_WHISTLE_SAMPLES[event.variant];
      if (sampleName !== undefined) void playSample(sampleName);
    };
    bus.on(GAME_EVENT.CANNONBALL_DESCENDING, descendingHandler);
    boundHandlers.push({
      type: GAME_EVENT.CANNONBALL_DESCENDING,
      handler: descendingHandler as GameEventHandler<EventKey>,
    });
  }

  function tickPresentation(state: GameState): void {
    if (disposed || paused) return;
    // Entering an enclosure-producing phase (CASTLE_SELECT,
    // CASTLE_RESELECT, WALL_BUILD): pre-add players who already hold at
    // least one enclosed alive tower. This suppresses the fanfare for
    // players who were already established before the phase began. In
    // SELECT/RESELECT the condition naturally evaluates to false for
    // everyone (no enclosed towers yet), so the gate is uniform — no
    // special casing per phase.
    if (state.phase !== lastPhase) {
      if (FANFARE_PHASES.has(state.phase)) {
        for (const player of state.players) {
          const hasEnclosedAlive = player.ownedTowers.some(
            (tower) => state.towerAlive[tower.index] === true,
          );
          if (hasEnclosedAlive) fanfarePlayedThisPhase.add(player.id);
        }
      }
      lastPhase = state.phase;
    }
    const signals = deriveSfxSignals(state);
    if (signals.countdownActive && !lastSignals.countdownActive) {
      startSnareLoop();
    } else if (!signals.countdownActive && lastSignals.countdownActive) {
      stopSnareLoop();
    }
    lastSignals = signals;
  }

  function startSnareLoop(): void {
    if (snareSource || disposed || paused) return;
    const samples = ensureSamples();
    const sample = samples?.get("snarerl1");
    if (!sample) return;
    const context = ensureContext();
    if (!context) return;
    const buffer = decodeSample(sample, context);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Interpose a gain node to apply the crescendo. snarerl1 has no
    // natural ramp-in on its own, so we ramp the output 0 → 1 linearly
    // over SNARE_CRESCENDO_SEC. The build-bg synth is decrescendoing on
    // the same window, yielding a clean cross-fade.
    const gain = context.createGain();
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + SNARE_CRESCENDO_SEC);
    source.connect(gain);
    gain.connect(context.destination);
    source.start(0);
    snareSource = source;
  }

  function stopSnareLoop(): void {
    if (!snareSource) return;
    try {
      snareSource.stop();
    } catch {
      // already ended — fine
    }
    snareSource = undefined;
  }

  async function setPaused(next: boolean): Promise<void> {
    paused = next;
    if (!audioContext) return;
    if (next && audioContext.state === AUDIO_CONTEXT_RUNNING) {
      await audioContext.suspend();
    } else if (!next && audioContext.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await audioContext.resume();
      } catch {
        // user gesture may be required — try again on next play
      }
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    unbindCurrentBus();
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // ignore — context may already be closed
      }
      audioContext = undefined;
    }
    buffers.clear();
    samplesByName = undefined;
    nextAllowedMsBySample.clear();
    fanfarePlayedThisPhase.clear();
  }

  function refreshSamples(): void {
    // Drop the parsed SOUND.RSC directory and the decoded AudioBuffer cache;
    // ensureSamples() will reparse from the current asset bytes on next play.
    // The AudioContext + cooldowns + fanfare-phase tracker stay — they're
    // independent of sample identity.
    samplesByName = undefined;
    buffers.clear();
  }

  return {
    activate,
    playSample,
    subscribeBus,
    refreshSamples,
    tickPresentation,
    setPaused,
    dispose,
  };
}

/** Pure derivation — GameState → presentational signals. No side effects,
 *  safe to call any time. Add a line here for each new continuous cue. */
function deriveSfxSignals(state: GameState): SfxSignals {
  return {
    countdownActive:
      COUNTDOWN_SNARE_PHASES.has(state.phase) &&
      state.timer > 0 &&
      state.timer <= COUNTDOWN_SNARE_RAW_SEC,
  };
}
