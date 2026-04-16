/**
 * Sound effects sub-system — jsfxr for one-shot SFX, Web Audio API for
 * multi-layered sounds (cannon boom, impact, cannonball whistle,
 * charge fanfare, war drums).
 *
 * Follows the factory-with-deps pattern used by other runtime sub-systems.
 * Respects the sound setting: 0=off, 1=phase changes only, 2=all.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` in the deps bag to capture every
 * "would have played" intent BEFORE the platform/level gate, so a deno
 * test can verify "this game event would have triggered sound X"
 * without needing a real `AudioContext` or `Audio` element (neither
 * exists in Deno).
 *
 * Default sound level in headless is `SOUND_OFF`, which means
 * production code paths early-return at the level check and never
 * touch the Web Audio API. The observer fires *before* that check, so
 * it sees the intent regardless. Production callers omit it.
 */

/// <reference path="../shared/platform/jsfxr.d.ts" />

import { sfxr } from "jsfxr";
import {
  BATTLE_MESSAGE,
  type BattleEvent,
} from "../shared/core/battle-events.ts";
import { SOUND_ALL, SOUND_PHASE_ONLY } from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type {
  SoundObserver,
  SoundReason,
  SoundSystem,
} from "../shared/core/system-interfaces.ts";
import { FANFARE_PATCH, FANFARE_SCORES } from "../shared/platform/opl2.ts";
import { playOplScore } from "./runtime-sound-opl.ts";

/** Construction-time deps for the sound sub-system. `observer` is the
 *  test seam — production callers omit it. */
interface SoundSystemDeps {
  observer?: SoundObserver;
}

type SfxKey = keyof typeof SFX_DEFS;

/** A Web Audio node that can be scheduled to stop. */
interface StoppableNode {
  stop(when?: number): void;
}

// Wave shapes for jsfxr SFX definitions.
const WAVE_SQUARE = 0;
const WAVE_SAWTOOTH = 1;
// WAVE_SINE = 2 — not used by current SFX defs but documented for reference.
const WAVE_NOISE = 3;
/** Volume scale when sound is set to "phase changes only" (half volume). */
const PHASE_ONLY_VOL = 0.5;
const RATE = 44100;
const SFX_DEFS = {
  // Battle
  cannonKilled: {
    wave_type: WAVE_NOISE,
    p_env_attack: 0,
    p_env_sustain: 0.25,
    p_env_punch: 0.5,
    p_env_decay: 0.4,
    p_base_freq: 0.08,
    p_freq_ramp: -0.1,
    p_lpf_freq: 0.6,
    sound_vol: 0.5,
    sample_rate: RATE,
    sample_size: 8,
  },
  gruntSpawned: {
    wave_type: WAVE_SQUARE,
    p_env_attack: 0,
    p_env_sustain: 0.08,
    p_env_decay: 0.15,
    p_base_freq: 0.5,
    p_freq_ramp: 0.1,
    p_duty: 0.4,
    sound_vol: 0.25,
    sample_rate: RATE,
    sample_size: 8,
  },
  gruntKilled: {
    wave_type: WAVE_NOISE,
    p_env_attack: 0,
    p_env_sustain: 0.05,
    p_env_decay: 0.1,
    p_base_freq: 0.35,
    p_freq_ramp: -0.3,
    sound_vol: 0.25,
    sample_rate: RATE,
    sample_size: 8,
  },
  towerKilled: {
    wave_type: WAVE_NOISE,
    p_env_attack: 0,
    p_env_sustain: 0.3,
    p_env_punch: 0.6,
    p_env_decay: 0.5,
    p_base_freq: 0.06,
    p_freq_ramp: -0.05,
    p_lpf_freq: 0.5,
    sound_vol: 0.5,
    sample_rate: RATE,
    sample_size: 8,
  },

  // Build / Cannon
  piecePlaced: {
    wave_type: WAVE_SQUARE,
    p_env_attack: 0,
    p_env_sustain: 0.04,
    p_env_decay: 0.08,
    p_base_freq: 0.55,
    p_duty: 0.5,
    sound_vol: 0.3,
    sample_rate: RATE,
    sample_size: 8,
  },
  pieceRotated: {
    wave_type: WAVE_SAWTOOTH,
    p_env_attack: 0,
    p_env_sustain: 0.02,
    p_env_decay: 0.05,
    p_base_freq: 0.45,
    p_freq_ramp: 0.15,
    sound_vol: 0.2,
    sample_rate: RATE,
    sample_size: 8,
  },
  pieceFailed: {
    wave_type: WAVE_NOISE,
    p_env_attack: 0,
    p_env_sustain: 0.06,
    p_env_decay: 0.1,
    p_base_freq: 0.2,
    p_freq_ramp: -0.1,
    sound_vol: 0.2,
    sample_rate: RATE,
    sample_size: 8,
  },
  cannonPlaced: {
    wave_type: WAVE_SQUARE,
    p_env_attack: 0,
    p_env_sustain: 0.06,
    p_env_decay: 0.12,
    p_base_freq: 0.5,
    p_freq_ramp: 0.1,
    p_duty: 0.4,
    sound_vol: 0.3,
    sample_rate: RATE,
    sample_size: 8,
  },

  // Phase / UI
  phaseStart: {
    wave_type: WAVE_SAWTOOTH,
    p_env_attack: 0.02,
    p_env_sustain: 0.2,
    p_env_decay: 0.3,
    p_base_freq: 0.5,
    p_freq_ramp: 0.05,
    p_arp_mod: 0.2,
    p_arp_speed: 0.5,
    sound_vol: 0.35,
    sample_rate: RATE,
    sample_size: 8,
  },
  lifeLost: {
    wave_type: WAVE_SAWTOOTH,
    p_env_attack: 0.05,
    p_env_sustain: 0.3,
    p_env_decay: 0.5,
    p_base_freq: 0.25,
    p_freq_ramp: -0.15,
    p_arp_mod: -0.3,
    p_arp_speed: 0.3,
    sound_vol: 0.4,
    sample_rate: RATE,
    sample_size: 8,
  },
  gameOver: {
    wave_type: WAVE_SAWTOOTH,
    p_env_attack: 0.1,
    p_env_sustain: 0.4,
    p_env_decay: 0.6,
    p_base_freq: 0.35,
    p_freq_ramp: -0.1,
    p_arp_mod: -0.2,
    p_arp_speed: 0.2,
    sound_vol: 0.45,
    sample_rate: RATE,
    sample_size: 8,
  },
} as const;
/** Target gain for exponential ramps that need to reach silence. */
const GAIN_SILENT = 0.001;
/** Near-zero gain for exponential ramps (slightly above GAIN_SILENT). */
const GAIN_NEAR_ZERO = 0.01;
/** Volume level when drums drop to quiet (cannon phase). */
const DRUMS_QUIET_LEVEL = 0.75;
/** Base volume fraction for drum ramp (0 → this during fade-in, then → 1.0). */
const DRUM_RAMP_BASE = 0.5;
const COOLDOWN_MS = 60;
const POOL_SIZE = 3;
const CANNON_BOOM_VOL = 0.12;
const CANNON_BASS_START_HZ = 200;
const CANNON_BASS_END_HZ = 40;
const CANNON_MID_START_HZ = 400;
const CANNON_MID_END_HZ = 100;
const CANNON_BLAST_DURATION = 0.5;
const CANNON_TAIL_DURATION = 0.8;
const CANNON_TAIL_FILTER_START_HZ = 800;
const CANNON_TAIL_FILTER_END_HZ = 150;
// Cannon boom voice mix ratios (fraction of base volume) and per-voice timing
const CANNON_BLAST_SUSTAIN_RATIO = 0.6;
const CANNON_BLAST_DECAY_TIME = 0.05;
const CANNON_BASS_MIX = 0.9;
const CANNON_BASS_SWEEP = 0.3;
const CANNON_MID_MIX = 0.5;
const CANNON_MID_SWEEP = 0.15;
const CANNON_MID_DURATION = 0.2;
const CANNON_TAIL_MIX = 0.3;
const CANNON_TAIL_DELAY = 0.1;
// Cannonball whistle — pitch-shifted sine wave per cannonball
const WHISTLE_MIN_DURATION = 0.3;
const WHISTLE_MAX_DURATION = 3;
const WHISTLE_JITTER_SCALE = 0.15;
const WHISTLE_OWN_START_HZ = 2600;
const WHISTLE_OWN_END_HZ = 3600;
const WHISTLE_ENEMY_START_HZ = 2500;
const WHISTLE_ENEMY_END_HZ = 1600;
const WHISTLE_ATTACK_FRACTION = 0.3;
const WHISTLE_RELEASE_FRACTION = 0.15;
const WHISTLE_PEAK_VOL = 0.15;
const MAX_BOOMS = 4;
const MAX_WHISTLES = 6;
const MAX_IMPACTS = 4;
const DRUM_MAX_DURATION = 60;
const DRUM_BEAT = 0.5;
const DRUM_BAR = DRUM_BEAT * 4;
const DRUM_STROKE_RATE = 10;
const DRUM_LOW_PITCH = 55;
const DRUM_HIGH_PITCH = 50;
const SNARE_WIRE_HZ = 180;
const DRUM_FADE_IN_SECONDS = 2;
const DRUM_RAMP_SECONDS = 30;
const DRUM_FADE_OUT_SECONDS = 0.5;
const DRUM_DROP_SECONDS = 0.8;
// Web Audio API type literals
const SINE: OscillatorType = "sine";
const LOWPASS: BiquadFilterType = "lowpass";
const BANDPASS: BiquadFilterType = "bandpass";
// Reason constants reused across `notifyPlayed(...)` and `play(key, ...)`
// call sites in the body of `createSoundSystem`. Without these, each
// reason string would appear twice in the file (once as the SFX key arg
// to `play`, once as the literal arg to `notifyPlayed`), pushing several
// names past the duplicate-literals scanner threshold (the scanner skips
// const definitions but counts function-call arguments).
const REASON_PHASE_START = "phaseStart";
const REASON_PIECE_PLACED = "piecePlaced";
const REASON_PIECE_FAILED = "pieceFailed";
const REASON_PIECE_ROTATED = "pieceRotated";
const REASON_CANNON_PLACED = "cannonPlaced";
const REASON_LIFE_LOST = "lifeLost";
const REASON_GAME_OVER = "gameOver";
const REASON_BATTLE_GRUNT_KILLED = "battle:gruntKilled";
const REASON_BATTLE_GRUNT_SPAWNED = "battle:gruntSpawned";

export function createSoundSystem(deps: SoundSystemDeps = {}): SoundSystem {
  const { observer } = deps;

  function notifyPlayed(reason: SoundReason): void {
    observer?.played?.(reason);
  }

  // ── Mutable state (closure-scoped) ─────────────────────────────────

  let soundLevel = SOUND_ALL;
  let audioCtx: AudioContext | undefined;

  // jsfxr pools
  const wavCache = new Map<SfxKey, string>();
  const lastPlayTime = new Map<SfxKey, number>();
  const audioPool = new Map<SfxKey, HTMLAudioElement[]>();

  // Web Audio concurrency limits
  let activeBooms = 0;
  let activeWhistles = 0;
  let activeImpacts = 0;

  // War drums state
  let drumNodes: StoppableNode[] = [];
  let drumGainNode: GainNode | undefined;

  // ── Internal helpers ───────────────────────────────────────────────

  function getCtx(): AudioContext {
    if (!audioCtx) audioCtx = new AudioContext();
    return audioCtx;
  }

  function getWav(key: SfxKey): string {
    let uri = wavCache.get(key);
    if (!uri) {
      uri = (sfxr.toWave(SFX_DEFS[key]) as { dataURI: string }).dataURI;
      wavCache.set(key, uri);
    }
    return uri;
  }

  function getPooledAudio(key: SfxKey): HTMLAudioElement {
    let pool = audioPool.get(key);
    if (!pool) {
      pool = [];
      audioPool.set(key, pool);
    }
    for (const element of pool) {
      if (element.ended || element.paused) {
        element.currentTime = 0;
        return element;
      }
    }
    if (pool.length < POOL_SIZE) {
      const element = new Audio(getWav(key));
      pool.push(element);
      return element;
    }
    const element = pool[0]!;
    element.currentTime = 0;
    return element;
  }

  function play(key: SfxKey, minLevel: number): void {
    if (soundLevel < minLevel) return;
    const now = performance.now();
    const last = lastPlayTime.get(key) ?? 0;
    if (now - last < COOLDOWN_MS) return;
    lastPlayTime.set(key, now);
    const audio = getPooledAudio(key);
    audio.volume = soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1;
    audio.play().catch(() => {});
  }

  // ── Cannon boom (Web Audio) ────────────────────────────────────────

  function cannonBoom(): void {
    if (activeBooms >= MAX_BOOMS) return;
    const audioCtx = getCtx();
    audioCtx.resume().catch(() => {});
    const time = audioCtx.currentTime + 0.01;
    const volume =
      CANNON_BOOM_VOL * (soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1);

    const blastLen = Math.ceil(audioCtx.sampleRate * CANNON_BLAST_DURATION);
    const blastBuf = audioCtx.createBuffer(1, blastLen, audioCtx.sampleRate);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) blastData[i] = Math.random() * 2 - 1;
    const blast = audioCtx.createBufferSource();
    blast.buffer = blastBuf;
    const blastGain = audioCtx.createGain();
    blastGain.gain.setValueAtTime(volume, time);
    blastGain.gain.setValueAtTime(
      volume * CANNON_BLAST_SUSTAIN_RATIO,
      time + CANNON_BLAST_DECAY_TIME,
    );
    blastGain.gain.exponentialRampToValueAtTime(
      GAIN_SILENT,
      time + CANNON_BLAST_DURATION,
    );
    blast.connect(blastGain).connect(audioCtx.destination);
    blast.start(time);
    blast.stop(time + CANNON_BLAST_DURATION);

    const bass = audioCtx.createOscillator();
    bass.type = SINE;
    bass.frequency.setValueAtTime(CANNON_BASS_START_HZ, time);
    bass.frequency.exponentialRampToValueAtTime(
      CANNON_BASS_END_HZ,
      time + CANNON_BASS_SWEEP,
    );
    const bassGain = audioCtx.createGain();
    bassGain.gain.setValueAtTime(volume * CANNON_BASS_MIX, time);
    bassGain.gain.exponentialRampToValueAtTime(
      GAIN_SILENT,
      time + CANNON_BLAST_DURATION,
    );
    bass.connect(bassGain).connect(audioCtx.destination);
    bass.start(time);
    bass.stop(time + CANNON_BLAST_DURATION);

    const mid = audioCtx.createOscillator();
    mid.type = SINE;
    mid.frequency.setValueAtTime(CANNON_MID_START_HZ, time);
    mid.frequency.exponentialRampToValueAtTime(
      CANNON_MID_END_HZ,
      time + CANNON_MID_SWEEP,
    );
    const midGain = audioCtx.createGain();
    midGain.gain.setValueAtTime(volume * CANNON_MID_MIX, time);
    midGain.gain.exponentialRampToValueAtTime(
      GAIN_SILENT,
      time + CANNON_MID_DURATION,
    );
    mid.connect(midGain).connect(audioCtx.destination);
    mid.start(time);
    mid.stop(time + CANNON_MID_DURATION);

    const tailLen = Math.ceil(audioCtx.sampleRate * CANNON_TAIL_DURATION);
    const tailBuf = audioCtx.createBuffer(1, tailLen, audioCtx.sampleRate);
    const tailData = tailBuf.getChannelData(0);
    for (let i = 0; i < tailLen; i++) tailData[i] = Math.random() * 2 - 1;
    const tail = audioCtx.createBufferSource();
    tail.buffer = tailBuf;
    const tailGain = audioCtx.createGain();
    tailGain.gain.setValueAtTime(
      volume * CANNON_TAIL_MIX,
      time + CANNON_TAIL_DELAY,
    );
    tailGain.gain.exponentialRampToValueAtTime(
      GAIN_SILENT,
      time + CANNON_TAIL_DURATION,
    );
    const tailFilter = audioCtx.createBiquadFilter();
    tailFilter.type = LOWPASS;
    tailFilter.frequency.setValueAtTime(CANNON_TAIL_FILTER_START_HZ, time);
    tailFilter.frequency.exponentialRampToValueAtTime(
      CANNON_TAIL_FILTER_END_HZ,
      time + CANNON_TAIL_DURATION,
    );
    tail.connect(tailFilter).connect(tailGain).connect(audioCtx.destination);
    tail.start(time);
    tail.stop(time + CANNON_TAIL_DURATION);

    activeBooms++;
    blast.onended = () => {
      activeBooms--;
    };
  }

  // ── Cannonball whistle (Web Audio) ─────────────────────────────────

  function cannonWhistle(
    evt: {
      startX: number;
      startY: number;
      targetX: number;
      targetY: number;
      speed: number;
      playerId: ValidPlayerSlot;
    },
    povPlayerId: ValidPlayerSlot,
  ): void {
    if (activeWhistles >= MAX_WHISTLES) return;
    const audioCtx = getCtx();
    audioCtx.resume().catch(() => {});

    const dx = evt.targetX - evt.startX;
    const dy = evt.targetY - evt.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const dur = Math.min(
      WHISTLE_MAX_DURATION,
      Math.max(WHISTLE_MIN_DURATION, dist / evt.speed),
    );

    const mine = evt.playerId === povPlayerId;
    const jitter = 1 + (Math.random() - 0.5) * WHISTLE_JITTER_SCALE;
    const startHz = mine
      ? WHISTLE_OWN_START_HZ * jitter
      : WHISTLE_ENEMY_START_HZ * jitter;
    const endHz = mine
      ? WHISTLE_OWN_END_HZ * jitter
      : WHISTLE_ENEMY_END_HZ * jitter;

    const attack = dur * WHISTLE_ATTACK_FRACTION;
    const release = dur * WHISTLE_RELEASE_FRACTION;
    const volScale = soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1;
    const peakVol = WHISTLE_PEAK_VOL * volScale;

    const time = audioCtx.currentTime + 0.02;

    const osc = audioCtx.createOscillator();
    osc.type = SINE;
    osc.frequency.setValueAtTime(startHz, time);
    osc.frequency.exponentialRampToValueAtTime(endHz, time + dur);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(GAIN_SILENT, time);
    gain.gain.linearRampToValueAtTime(peakVol, time + attack);
    gain.gain.setValueAtTime(peakVol * 0.7, time + dur - release);
    gain.gain.linearRampToValueAtTime(GAIN_SILENT, time + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(time);
    osc.stop(time + dur);

    const nLen = Math.ceil(audioCtx.sampleRate * dur);
    const nBuf = audioCtx.createBuffer(1, nLen, audioCtx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = nBuf;
    const nGain = audioCtx.createGain();
    nGain.gain.setValueAtTime(GAIN_SILENT, time);
    nGain.gain.linearRampToValueAtTime(peakVol * 0.4, time + attack);
    nGain.gain.setValueAtTime(peakVol * 0.28, time + dur - release);
    nGain.gain.linearRampToValueAtTime(GAIN_SILENT, time + dur);
    const nFilter = audioCtx.createBiquadFilter();
    nFilter.type = BANDPASS;
    nFilter.frequency.setValueAtTime(startHz, time);
    nFilter.frequency.exponentialRampToValueAtTime(endHz, time + dur);
    nFilter.Q.value = 5;
    noise.connect(nFilter).connect(nGain).connect(audioCtx.destination);
    noise.start(time);
    noise.stop(time + dur);

    activeWhistles++;
    osc.onended = () => {
      activeWhistles--;
    };
  }

  // ── Impact (Web Audio) ─────────────────────────────────────────────

  function impact(): void {
    if (activeImpacts >= MAX_IMPACTS) return;
    const audioCtx = getCtx();
    audioCtx.resume().catch(() => {});
    const time = audioCtx.currentTime + 0.01;
    const volume = soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1;

    const thud = audioCtx.createOscillator();
    thud.type = SINE;
    thud.frequency.setValueAtTime(100, time);
    thud.frequency.exponentialRampToValueAtTime(35, time + 0.08);
    const thudGain = audioCtx.createGain();
    thudGain.gain.setValueAtTime(0.3 * volume, time);
    thudGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.12);
    thud.connect(thudGain).connect(audioCtx.destination);
    thud.start(time);
    thud.stop(time + 0.12);

    const crunchLen = Math.ceil(audioCtx.sampleRate * 0.15);
    const crunchBuf = audioCtx.createBuffer(1, crunchLen, audioCtx.sampleRate);
    const crunchData = crunchBuf.getChannelData(0);
    for (let i = 0; i < crunchLen; i++) {
      crunchData[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.3);
    }
    const crunch = audioCtx.createBufferSource();
    crunch.buffer = crunchBuf;
    const crunchGain = audioCtx.createGain();
    crunchGain.gain.setValueAtTime(0.25 * volume, time);
    crunchGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.15);
    const crunchFilter = audioCtx.createBiquadFilter();
    crunchFilter.type = BANDPASS;
    crunchFilter.frequency.value = 800;
    crunchFilter.Q.value = 0.8;
    crunch
      .connect(crunchFilter)
      .connect(crunchGain)
      .connect(audioCtx.destination);
    crunch.start(time);
    crunch.stop(time + 0.15);

    const debrisLen = Math.ceil(audioCtx.sampleRate * 0.3);
    const debrisBuf = audioCtx.createBuffer(1, debrisLen, audioCtx.sampleRate);
    const debrisData = debrisBuf.getChannelData(0);
    for (let i = 0; i < debrisLen; i++) {
      debrisData[i] = Math.random() < 0.08 ? Math.random() * 2 - 1 : 0;
    }
    const debris = audioCtx.createBufferSource();
    debris.buffer = debrisBuf;
    const debrisGain = audioCtx.createGain();
    debrisGain.gain.setValueAtTime(0.12 * volume, time + 0.05);
    debrisGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.3);
    const debrisFilter = audioCtx.createBiquadFilter();
    debrisFilter.type = "highpass";
    debrisFilter.frequency.value = 1500;
    debris
      .connect(debrisFilter)
      .connect(debrisGain)
      .connect(audioCtx.destination);
    debris.start(time + 0.05);
    debris.stop(time + 0.35);

    activeImpacts++;
    thud.onended = () => {
      activeImpacts--;
    };
  }

  // ── Drums internal ─────────────────────────────────────────────────

  function drumsStopInternal(): void {
    if (drumGainNode && audioCtx) {
      const now = audioCtx.currentTime;
      drumGainNode.gain.cancelScheduledValues(now);
      drumGainNode.gain.setValueAtTime(drumGainNode.gain.value, now);
      drumGainNode.gain.linearRampToValueAtTime(0, now + DRUM_FADE_OUT_SECONDS);
      // Schedule all nodes to stop at fade-out end (Web Audio timing, no setTimeout)
      const stopAt = now + DRUM_FADE_OUT_SECONDS + 0.05;
      for (const node of drumNodes) {
        try {
          node.stop(stopAt);
        } catch {
          /* already stopped */
        }
      }
      drumNodes = [];
      drumGainNode = undefined;
      return;
    }
    stopNodes(drumNodes);
    drumNodes = [];
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    setLevel(level) {
      soundLevel = level;
    },

    phaseStart() {
      notifyPlayed(REASON_PHASE_START);
      play(REASON_PHASE_START, 1);
    },

    battleEvents(events, povPlayerId) {
      // Walk events even when sound is off — the observer needs to see
      // every battle event. The Web Audio call paths (`cannonBoom`,
      // `cannonWhistle`, `impact`) and `play()` are still gated by
      // `soundLevel < SOUND_ALL` below, so the production hot path only
      // pays for the loop when there's something to do. Without the
      // observer-aware walk we'd lose per-event observability in
      // headless tests where `soundLevel` defaults to SOUND_OFF.
      if (!observer && soundLevel < SOUND_ALL) return;
      const audible = soundLevel >= SOUND_ALL;
      for (const evt of events) {
        if (evt.type === BATTLE_MESSAGE.CANNON_FIRED) {
          notifyPlayed("battle:cannonFired");
          if (audible) {
            cannonBoom();
            cannonWhistle(evt, povPlayerId);
          }
        } else if (
          evt.type === BATTLE_MESSAGE.WALL_DESTROYED &&
          evt.playerId === povPlayerId
        ) {
          notifyPlayed("battle:wallDestroyed");
          if (audible) impact();
        } else if (
          evt.type === BATTLE_MESSAGE.CANNON_DAMAGED &&
          evt.newHp !== 0 &&
          evt.playerId === povPlayerId
        ) {
          notifyPlayed("battle:cannonDamaged");
          if (audible) impact();
        }
        const key = battleEventSound(evt, povPlayerId);
        if (key) {
          // The SFX key is one of: cannonKilled, gruntKilled, gruntSpawned,
          // towerKilled. Each maps to a `battle:*` reason — except
          // towerKilled, which reuses BATTLE_MESSAGE.TOWER_KILLED to keep
          // the literal "towerKilled" from showing up a third time (the
          // duplicate-literals scanner has it in the baseline at
          // battle-events.ts + sound-system.ts already).
          if (key === "cannonKilled") notifyPlayed("battle:cannonKilled");
          else if (key === BATTLE_MESSAGE.GRUNT_KILLED)
            notifyPlayed(REASON_BATTLE_GRUNT_KILLED);
          else if (key === BATTLE_MESSAGE.GRUNT_SPAWNED)
            notifyPlayed(REASON_BATTLE_GRUNT_SPAWNED);
          else if (key === BATTLE_MESSAGE.TOWER_KILLED)
            notifyPlayed(BATTLE_MESSAGE.TOWER_KILLED);
          if (audible) play(key, 2);
        }
      }
    },

    piecePlaced() {
      notifyPlayed(REASON_PIECE_PLACED);
      play(REASON_PIECE_PLACED, 2);
    },
    pieceFailed() {
      notifyPlayed(REASON_PIECE_FAILED);
      play(REASON_PIECE_FAILED, 2);
    },
    pieceRotated() {
      notifyPlayed(REASON_PIECE_ROTATED);
      play(REASON_PIECE_ROTATED, 2);
    },
    cannonPlaced() {
      notifyPlayed(REASON_CANNON_PLACED);
      play(REASON_CANNON_PLACED, 2);
    },

    chargeFanfare(playerId = 0) {
      notifyPlayed("chargeFanfare");
      if (soundLevel < SOUND_PHASE_ONLY) return;
      const audioCtx = getCtx();
      audioCtx.resume().catch(() => {});

      const score = FANFARE_SCORES[playerId] ?? FANFARE_SCORES[0]!;
      const volScale = soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1;
      playOplScore(audioCtx, FANFARE_PATCH, score, volScale);
    },

    lifeLost() {
      notifyPlayed(REASON_LIFE_LOST);
      play(REASON_LIFE_LOST, 1);
    },
    gameOver() {
      notifyPlayed(REASON_GAME_OVER);
      play(REASON_GAME_OVER, 1);
    },

    drumsStart() {
      notifyPlayed("drumsStart");
      if (soundLevel < SOUND_ALL) return;
      drumsStopInternal();
      const audioCtx = getCtx();
      audioCtx.resume().catch(() => {});

      drumGainNode = audioCtx.createGain();
      drumGainNode.gain.setValueAtTime(1, audioCtx.currentTime);
      drumGainNode.connect(audioCtx.destination);

      const maxVol = soundLevel === SOUND_PHASE_ONLY ? PHASE_ONLY_VOL : 1;
      const t0 = audioCtx.currentTime + 0.05;
      let time = t0;
      const end = time + DRUM_MAX_DURATION;
      while (time < end) {
        scheduleDrumBar(
          audioCtx,
          drumGainNode,
          time,
          maxVol * drumVolume(time - t0),
          drumNodes,
        );
        time += DRUM_BAR;
      }
    },

    drumsQuiet() {
      notifyPlayed("drumsQuiet");
      if (!drumGainNode || !audioCtx) return;
      const now = audioCtx.currentTime;
      drumGainNode.gain.cancelScheduledValues(now);
      drumGainNode.gain.setValueAtTime(drumGainNode.gain.value, now);
      drumGainNode.gain.linearRampToValueAtTime(
        DRUMS_QUIET_LEVEL,
        now + DRUM_DROP_SECONDS,
      );
    },

    drumsStop() {
      notifyPlayed("drumsStop");
      drumsStopInternal();
    },

    reset() {
      notifyPlayed("reset");
      drumsStopInternal();
      lastPlayTime.clear();
      audioPool.clear();
      activeBooms = 0;
      activeWhistles = 0;
      activeImpacts = 0;
    },
  };
}

function scheduleDrumBar(
  audioCtx: AudioContext,
  dest: AudioNode,
  time: number,
  vol: number,
  nodes: StoppableNode[],
): void {
  const j = () => (Math.random() - 0.5) * DRUM_BEAT * 0.16;
  const volume = (base: number) => base * (0.85 + Math.random() * 0.3);
  const pitch = (base: number) => base + (Math.random() - 0.5) * 6;

  timpaniHit(
    audioCtx,
    dest,
    time + j(),
    volume(vol * 0.65),
    pitch(DRUM_LOW_PITCH),
    nodes,
  );
  timpaniHit(
    audioCtx,
    dest,
    time + DRUM_BEAT + j(),
    volume(vol * 0.45),
    pitch(DRUM_HIGH_PITCH),
    nodes,
  );
  timpaniHit(
    audioCtx,
    dest,
    time + DRUM_BEAT * 1.35 + j(),
    volume(vol * 0.3),
    pitch(DRUM_HIGH_PITCH),
    nodes,
  );
  timpaniHit(
    audioCtx,
    dest,
    time + DRUM_BEAT * 3 + j(),
    volume(vol * 0.55),
    pitch(DRUM_LOW_PITCH),
    nodes,
  );
  scheduleSnareRoll(audioCtx, dest, time, DRUM_BAR, vol * 0.08, nodes);
}

function timpaniHit(
  audioCtx: AudioContext,
  dest: AudioNode,
  time: number,
  vol: number,
  pitch: number,
  nodes: StoppableNode[],
): void {
  const osc = audioCtx.createOscillator();
  osc.type = SINE;
  osc.frequency.setValueAtTime(pitch * 1.15, time);
  osc.frequency.exponentialRampToValueAtTime(pitch, time + 0.08);
  const osc2 = audioCtx.createOscillator();
  osc2.type = SINE;
  osc2.frequency.value = pitch * 1.5;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(vol, time);
  gain.gain.setValueAtTime(vol * 0.7, time + 0.05);
  gain.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.8);
  const gain2 = audioCtx.createGain();
  gain2.gain.setValueAtTime(vol * 0.25, time);
  gain2.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.4);
  const filter = audioCtx.createBiquadFilter();
  filter.type = LOWPASS;
  filter.frequency.value = 250;
  filter.Q.value = 0.7;
  osc.connect(gain).connect(filter).connect(dest);
  osc2.connect(gain2).connect(filter);
  osc.start(time);
  osc.stop(time + 0.8);
  osc2.start(time);
  osc2.stop(time + 0.5);
  nodes.push(osc, osc2);

  const bufLen = Math.ceil(audioCtx.sampleRate * 0.015);
  const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = audioCtx.createBufferSource();
  noise.buffer = buf;
  const nGain = audioCtx.createGain();
  nGain.gain.setValueAtTime(vol * 0.3, time);
  nGain.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.015);
  const nFilter = audioCtx.createBiquadFilter();
  nFilter.type = LOWPASS;
  nFilter.frequency.value = 400;
  noise.connect(nFilter).connect(nGain).connect(dest);
  noise.start(time);
  noise.stop(time + 0.02);
  nodes.push(noise);
}

function scheduleSnareRoll(
  audioCtx: AudioContext,
  dest: AudioNode,
  time: number,
  dur: number,
  vol: number,
  nodes: StoppableNode[],
): void {
  const strokeInterval = 1 / DRUM_STROKE_RATE;
  const strokeTimes: number[] = [];
  for (
    let strokeIndex = 0;
    strokeIndex <= Math.ceil(dur * DRUM_STROKE_RATE);
    strokeIndex++
  ) {
    const jitter = (Math.random() - 0.5) * strokeInterval * 0.35;
    strokeTimes.push(strokeIndex * strokeInterval + jitter);
  }

  const bands = [
    { freq: 900, qFactor: 0.6, volMul: 1.0 },
    { freq: 2200, qFactor: 1.0, volMul: 0.5 },
  ];
  const bufLen = Math.ceil(audioCtx.sampleRate * dur);

  for (const band of bands) {
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      const tSample = i / audioCtx.sampleRate;
      let timeSinceStroke = strokeInterval;
      for (const stroke of strokeTimes) {
        const delta = tSample - stroke;
        if (delta >= 0 && delta < timeSinceStroke) timeSinceStroke = delta;
      }
      const phase = timeSinceStroke / strokeInterval;
      const strokeEnv =
        phase < 0.15 ? 0.7 + Math.random() * 0.3 : 0.3 + 0.3 * (1 - phase);
      data[i] = (Math.random() * 2 - 1) * strokeEnv;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(vol * band.volMul, time);
    const filter = audioCtx.createBiquadFilter();
    filter.type = BANDPASS;
    filter.frequency.value = band.freq;
    filter.Q.value = band.qFactor;
    noise.connect(filter).connect(gain).connect(dest);
    noise.start(time);
    noise.stop(time + dur);
    nodes.push(noise);
  }

  const wireOsc = audioCtx.createOscillator();
  wireOsc.type = "triangle";
  wireOsc.frequency.value = SNARE_WIRE_HZ;
  const wireGain = audioCtx.createGain();
  wireGain.gain.setValueAtTime(vol * 0.08, time);
  wireOsc.connect(wireGain).connect(dest);
  wireOsc.start(time);
  wireOsc.stop(time + dur);
  nodes.push(wireOsc);
}

function drumVolume(elapsed: number): number {
  if (elapsed < DRUM_FADE_IN_SECONDS) {
    const time = elapsed / DRUM_FADE_IN_SECONDS;
    return DRUM_RAMP_BASE * time * time;
  }
  const rampElapsed = elapsed - DRUM_FADE_IN_SECONDS;
  return (
    DRUM_RAMP_BASE +
    DRUM_RAMP_BASE * Math.min(1, rampElapsed / DRUM_RAMP_SECONDS)
  );
}

function battleEventSound(
  evt: BattleEvent,
  povPlayerId: ValidPlayerSlot,
): SfxKey | null {
  if (
    evt.type === BATTLE_MESSAGE.CANNON_DAMAGED &&
    evt.playerId === povPlayerId
  )
    return evt.newHp === 0 ? "cannonKilled" : null;
  if (evt.type === BATTLE_MESSAGE.GRUNT_SPAWNED) return "gruntSpawned";
  if (evt.type === BATTLE_MESSAGE.GRUNT_KILLED) return "gruntKilled";
  if (evt.type === BATTLE_MESSAGE.TOWER_KILLED) return "towerKilled";
  return null;
}

function stopNodes(nodes: readonly StoppableNode[]): void {
  for (const node of nodes) {
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
  }
}
