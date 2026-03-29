/**
 * Sound effects sub-system — jsfxr for one-shot SFX, Web Audio API for
 * multi-layered sounds (cannon boom, impact, cannonball whistle,
 * charge fanfare, war drums).
 *
 * Follows the factory-with-deps pattern used by other runtime sub-systems.
 * Respects the sound setting: 0=off, 1=phase changes only, 2=all.
 */

import { sfxr } from "jsfxr";
import { MESSAGE } from "../server/protocol.ts";

/** Shape of battle events consumed by the sound system. */
interface BattleAudioEvent {
  type: string;
  playerId?: number;
  hp?: number;
  newHp?: number;
  startX?: number;
  startY?: number;
  targetX?: number;
  targetY?: number;
  speed?: number;
}

export interface SoundSystem {
  setLevel: (level: number) => void;

  // Phase transitions (level 1+)
  phaseStart: () => void;

  // Battle (level 2)
  battleEvents: (
    events: ReadonlyArray<BattleAudioEvent>,
    myPlayerId: number,
  ) => void;

  // Player actions (level 2)
  piecePlaced: () => void;
  pieceFailed: () => void;
  pieceRotated: () => void;
  cannonPlaced: () => void;

  // Castle enclosure (level 1+)
  chargeFanfare: (playerId?: number) => void;

  // Life events (level 1+)
  lifeLost: () => void;
  gameOver: () => void;

  // War drums lifecycle
  drumsStart: () => void;
  drumsQuiet: () => void;
  drumsStop: () => void;

  /** Stop all playing audio and reset internal state (rematch). */
  reset: () => void;
}

type SfxKey = keyof typeof SFX_DEFS;

/** A Web Audio node that can be scheduled to stop. */
interface StoppableNode {
  stop(when?: number): void;
}

// Wave shapes: SQUARE=0, SAWTOOTH=1, SINE=2, NOISE=3
const RATE = 44100;
const SFX_DEFS = {
  // Battle
  cannonKilled: {
    wave_type: 3,
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
    wave_type: 0,
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
    wave_type: 3,
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
    wave_type: 3,
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
    wave_type: 0,
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
    wave_type: 1,
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
    wave_type: 3,
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
    wave_type: 0,
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
    wave_type: 1,
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
    wave_type: 1,
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
    wave_type: 1,
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
const FANFARE_PITCH = [1.0, 1.122, 0.794];
const CANNON_BOOM_VOL = 0.12;
const CANNON_BASS_START_HZ = 200;
const CANNON_DEFAULT_SPEED = 200;
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

export function createSoundSystem(): SoundSystem {
  // ── Mutable state (closure-scoped) ─────────────────────────────────

  let soundLevel = 2;
  let audioCtx: AudioContext | null = null;

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
  let drumGainNode: GainNode | null = null;

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
    for (const el of pool) {
      if (el.ended || el.paused) {
        el.currentTime = 0;
        return el;
      }
    }
    if (pool.length < POOL_SIZE) {
      const el = new Audio(getWav(key));
      pool.push(el);
      return el;
    }
    const el = pool[0]!;
    el.currentTime = 0;
    return el;
  }

  function play(key: SfxKey, minLevel: number): void {
    if (soundLevel < minLevel) return;
    const now = performance.now();
    const last = lastPlayTime.get(key) ?? 0;
    if (now - last < COOLDOWN_MS) return;
    lastPlayTime.set(key, now);
    const audio = getPooledAudio(key);
    audio.volume = soundLevel === 1 ? 0.5 : 1;
    audio.play().catch(() => {});
  }

  // ── Cannon boom (Web Audio) ────────────────────────────────────────

  function cannonBoom(): void {
    if (activeBooms >= MAX_BOOMS) return;
    const ctx = getCtx();
    ctx.resume().catch(() => {});
    const time = ctx.currentTime + 0.01;
    const volume = CANNON_BOOM_VOL * (soundLevel === 1 ? 0.5 : 1);

    const blastLen = Math.ceil(ctx.sampleRate * 0.5);
    const blastBuf = ctx.createBuffer(1, blastLen, ctx.sampleRate);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) blastData[i] = Math.random() * 2 - 1;
    const blast = ctx.createBufferSource();
    blast.buffer = blastBuf;
    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(volume, time);
    blastGain.gain.setValueAtTime(volume * 0.6, time + 0.05);
    blastGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.5);
    blast.connect(blastGain).connect(ctx.destination);
    blast.start(time);
    blast.stop(time + 0.5);

    const bass = ctx.createOscillator();
    bass.type = SINE;
    bass.frequency.setValueAtTime(CANNON_BASS_START_HZ, time);
    bass.frequency.exponentialRampToValueAtTime(40, time + 0.3);
    const bassGain = ctx.createGain();
    bassGain.gain.setValueAtTime(volume * 0.9, time);
    bassGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.5);
    bass.connect(bassGain).connect(ctx.destination);
    bass.start(time);
    bass.stop(time + 0.5);

    const mid = ctx.createOscillator();
    mid.type = SINE;
    mid.frequency.setValueAtTime(400, time);
    mid.frequency.exponentialRampToValueAtTime(100, time + 0.15);
    const midGain = ctx.createGain();
    midGain.gain.setValueAtTime(volume * 0.5, time);
    midGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.2);
    mid.connect(midGain).connect(ctx.destination);
    mid.start(time);
    mid.stop(time + 0.2);

    const tailLen = Math.ceil(ctx.sampleRate * 0.8);
    const tailBuf = ctx.createBuffer(1, tailLen, ctx.sampleRate);
    const tailData = tailBuf.getChannelData(0);
    for (let i = 0; i < tailLen; i++) tailData[i] = Math.random() * 2 - 1;
    const tail = ctx.createBufferSource();
    tail.buffer = tailBuf;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(volume * 0.3, time + 0.1);
    tailGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.8);
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = LOWPASS;
    tailFilter.frequency.setValueAtTime(800, time);
    tailFilter.frequency.exponentialRampToValueAtTime(150, time + 0.8);
    tail.connect(tailFilter).connect(tailGain).connect(ctx.destination);
    tail.start(time);
    tail.stop(time + 0.8);

    activeBooms++;
    blast.onended = () => {
      activeBooms--;
    };
  }

  // ── Cannonball whistle (Web Audio) ─────────────────────────────────

  function cannonWhistle(evt: BattleAudioEvent, myPlayerId: number): void {
    if (activeWhistles >= MAX_WHISTLES) return;
    const ctx = getCtx();
    ctx.resume().catch(() => {});

    const dx = (evt.targetX ?? 0) - (evt.startX ?? 0);
    const dy = (evt.targetY ?? 0) - (evt.startY ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const dur = Math.min(
      3,
      Math.max(0.3, dist / (evt.speed ?? CANNON_DEFAULT_SPEED)),
    );

    const mine = evt.playerId === myPlayerId;
    const jitter = 1 + (Math.random() - 0.5) * 0.15;
    const startHz = mine ? 2600 * jitter : 2500 * jitter;
    const endHz = mine ? 3600 * jitter : 1600 * jitter;

    const attack = dur * 0.3;
    const release = dur * 0.15;
    const volScale = soundLevel === 1 ? 0.5 : 1;
    const peakVol = 0.15 * volScale;

    const time = ctx.currentTime + 0.02;

    const osc = ctx.createOscillator();
    osc.type = SINE;
    osc.frequency.setValueAtTime(startHz, time);
    osc.frequency.exponentialRampToValueAtTime(endHz, time + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(GAIN_SILENT, time);
    gain.gain.linearRampToValueAtTime(peakVol, time + attack);
    gain.gain.setValueAtTime(peakVol * 0.7, time + dur - release);
    gain.gain.linearRampToValueAtTime(GAIN_SILENT, time + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur);

    const nLen = Math.ceil(ctx.sampleRate * dur);
    const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(GAIN_SILENT, time);
    nGain.gain.linearRampToValueAtTime(peakVol * 0.4, time + attack);
    nGain.gain.setValueAtTime(peakVol * 0.28, time + dur - release);
    nGain.gain.linearRampToValueAtTime(GAIN_SILENT, time + dur);
    const nFilter = ctx.createBiquadFilter();
    nFilter.type = BANDPASS;
    nFilter.frequency.setValueAtTime(startHz, time);
    nFilter.frequency.exponentialRampToValueAtTime(endHz, time + dur);
    nFilter.Q.value = 5;
    noise.connect(nFilter).connect(nGain).connect(ctx.destination);
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
    const ctx = getCtx();
    ctx.resume().catch(() => {});
    const time = ctx.currentTime + 0.01;
    const volume = soundLevel === 1 ? 0.5 : 1;

    const thud = ctx.createOscillator();
    thud.type = SINE;
    thud.frequency.setValueAtTime(100, time);
    thud.frequency.exponentialRampToValueAtTime(35, time + 0.08);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.3 * volume, time);
    thudGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.12);
    thud.connect(thudGain).connect(ctx.destination);
    thud.start(time);
    thud.stop(time + 0.12);

    const crunchLen = Math.ceil(ctx.sampleRate * 0.15);
    const crunchBuf = ctx.createBuffer(1, crunchLen, ctx.sampleRate);
    const crunchData = crunchBuf.getChannelData(0);
    for (let i = 0; i < crunchLen; i++) {
      crunchData[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.3);
    }
    const crunch = ctx.createBufferSource();
    crunch.buffer = crunchBuf;
    const crunchGain = ctx.createGain();
    crunchGain.gain.setValueAtTime(0.25 * volume, time);
    crunchGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.15);
    const crunchFilter = ctx.createBiquadFilter();
    crunchFilter.type = BANDPASS;
    crunchFilter.frequency.value = 800;
    crunchFilter.Q.value = 0.8;
    crunch.connect(crunchFilter).connect(crunchGain).connect(ctx.destination);
    crunch.start(time);
    crunch.stop(time + 0.15);

    const debrisLen = Math.ceil(ctx.sampleRate * 0.3);
    const debrisBuf = ctx.createBuffer(1, debrisLen, ctx.sampleRate);
    const debrisData = debrisBuf.getChannelData(0);
    for (let i = 0; i < debrisLen; i++) {
      debrisData[i] = Math.random() < 0.08 ? Math.random() * 2 - 1 : 0;
    }
    const debris = ctx.createBufferSource();
    debris.buffer = debrisBuf;
    const debrisGain = ctx.createGain();
    debrisGain.gain.setValueAtTime(0.12 * volume, time + 0.05);
    debrisGain.gain.exponentialRampToValueAtTime(GAIN_SILENT, time + 0.3);
    const debrisFilter = ctx.createBiquadFilter();
    debrisFilter.type = "highpass";
    debrisFilter.frequency.value = 1500;
    debris.connect(debrisFilter).connect(debrisGain).connect(ctx.destination);
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
      drumGainNode = null;
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
      play("phaseStart", 1);
    },

    battleEvents(events, myPlayerId) {
      if (soundLevel < 2) return;
      for (const evt of events) {
        if (evt.type === MESSAGE.CANNON_FIRED) {
          cannonBoom();
          if (evt.speed && evt.startX !== undefined) {
            cannonWhistle(evt, myPlayerId);
          }
        } else if (
          evt.type === MESSAGE.WALL_DESTROYED ||
          evt.type === MESSAGE.HOUSE_DESTROYED ||
          evt.type === MESSAGE.PIT_CREATED ||
          (evt.type === MESSAGE.CANNON_DAMAGED && evt.newHp !== 0)
        ) {
          if (evt.playerId === myPlayerId) impact();
        }
        const key = battleEventSound(evt, myPlayerId);
        if (key) play(key, 2);
      }
    },

    piecePlaced() {
      play("piecePlaced", 2);
    },
    pieceFailed() {
      play("pieceFailed", 2);
    },
    pieceRotated() {
      play("pieceRotated", 2);
    },
    cannonPlaced() {
      play("cannonPlaced", 2);
    },

    chargeFanfare(playerId = 0) {
      if (soundLevel < 1) return;
      const ctx = getCtx();
      ctx.resume().catch(() => {});

      const pitch = FANFARE_PITCH[playerId] ?? 1;
      const G4 = 392 * pitch;
      const C5 = 523 * pitch;
      const E5 = 659 * pitch;
      const G5 = 784 * pitch;
      const noteStep = 0.147;
      const volScale = soundLevel === 1 ? 0.5 : 1;

      const score: [number, number, number, boolean][] = [
        [G4, noteStep, 0.28, false],
        [C5, noteStep, 0.32, false],
        [E5, noteStep, 0.36, false],
        [G5, noteStep, 0.4, true],
        [E5, noteStep, 0.36, false],
        [G5, noteStep * 6, 0.45, true],
      ];

      let time = ctx.currentTime + 0.05;
      for (const [freq, dur, vol, accent] of score) {
        fanfareNote(ctx, freq, time, dur * 0.92, vol * volScale, accent);
        time += dur;
      }
    },

    lifeLost() {
      play("lifeLost", 1);
    },
    gameOver() {
      play("gameOver", 1);
    },

    drumsStart() {
      if (soundLevel < 2) return;
      drumsStopInternal();
      const ctx = getCtx();
      ctx.resume().catch(() => {});

      drumGainNode = ctx.createGain();
      drumGainNode.gain.setValueAtTime(1, ctx.currentTime);
      drumGainNode.connect(ctx.destination);

      const maxVol = soundLevel === 1 ? 0.5 : 1;
      const t0 = ctx.currentTime + 0.05;
      let time = t0;
      const end = time + DRUM_MAX_DURATION;
      while (time < end) {
        scheduleDrumBar(
          ctx,
          drumGainNode,
          time,
          maxVol * drumVolume(time - t0),
          drumNodes,
        );
        time += DRUM_BAR;
      }
    },

    drumsQuiet() {
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
      drumsStopInternal();
    },

    reset() {
      drumsStopInternal();
      lastPlayTime.clear();
      audioPool.clear();
      activeBooms = 0;
      activeWhistles = 0;
      activeImpacts = 0;
    },
  };
}

function fanfareNote(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  vol: number,
  accent: boolean,
): void {
  const volume = accent ? vol * 1.3 : vol;

  for (const detune of [-6, 6]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const gain = ctx.createGain();
    const attackEnd = startTime + 0.006;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume * 1.4, attackEnd);
    gain.gain.exponentialRampToValueAtTime(volume, attackEnd + 0.03);
    gain.gain.setValueAtTime(volume * 0.85, startTime + duration - 0.02);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    const filter = ctx.createBiquadFilter();
    filter.type = LOWPASS;
    filter.frequency.setValueAtTime(3500, startTime);
    filter.frequency.exponentialRampToValueAtTime(1800, startTime + 0.06);
    filter.Q.value = 2;
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  const sub = ctx.createOscillator();
  sub.type = "square";
  sub.frequency.value = freq / 2;
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0, startTime);
  subGain.gain.linearRampToValueAtTime(volume * 0.15, startTime + 0.01);
  subGain.gain.setValueAtTime(volume * 0.12, startTime + duration - 0.02);
  subGain.gain.linearRampToValueAtTime(0, startTime + duration);
  sub.connect(subGain).connect(ctx.destination);
  sub.start(startTime);
  sub.stop(startTime + duration);
}

function scheduleDrumBar(
  ctx: AudioContext,
  dest: AudioNode,
  time: number,
  vol: number,
  nodes: StoppableNode[],
): void {
  const j = () => (Math.random() - 0.5) * DRUM_BEAT * 0.16;
  const volume = (base: number) => base * (0.85 + Math.random() * 0.3);
  const pitch = (base: number) => base + (Math.random() - 0.5) * 6;

  timpaniHit(
    ctx,
    dest,
    time + j(),
    volume(vol * 0.65),
    pitch(DRUM_LOW_PITCH),
    nodes,
  );
  timpaniHit(
    ctx,
    dest,
    time + DRUM_BEAT + j(),
    volume(vol * 0.45),
    pitch(DRUM_HIGH_PITCH),
    nodes,
  );
  timpaniHit(
    ctx,
    dest,
    time + DRUM_BEAT * 1.35 + j(),
    volume(vol * 0.3),
    pitch(DRUM_HIGH_PITCH),
    nodes,
  );
  timpaniHit(
    ctx,
    dest,
    time + DRUM_BEAT * 3 + j(),
    volume(vol * 0.55),
    pitch(DRUM_LOW_PITCH),
    nodes,
  );
  scheduleSnareRoll(ctx, dest, time, DRUM_BAR, vol * 0.08, nodes);
}

function timpaniHit(
  ctx: AudioContext,
  dest: AudioNode,
  time: number,
  vol: number,
  pitch: number,
  nodes: StoppableNode[],
): void {
  const osc = ctx.createOscillator();
  osc.type = SINE;
  osc.frequency.setValueAtTime(pitch * 1.15, time);
  osc.frequency.exponentialRampToValueAtTime(pitch, time + 0.08);
  const osc2 = ctx.createOscillator();
  osc2.type = SINE;
  osc2.frequency.value = pitch * 1.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, time);
  gain.gain.setValueAtTime(vol * 0.7, time + 0.05);
  gain.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.8);
  const gain2 = ctx.createGain();
  gain2.gain.setValueAtTime(vol * 0.25, time);
  gain2.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.4);
  const filter = ctx.createBiquadFilter();
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

  const bufLen = Math.ceil(ctx.sampleRate * 0.015);
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(vol * 0.3, time);
  nGain.gain.exponentialRampToValueAtTime(GAIN_NEAR_ZERO, time + 0.015);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = LOWPASS;
  nFilter.frequency.value = 400;
  noise.connect(nFilter).connect(nGain).connect(dest);
  noise.start(time);
  noise.stop(time + 0.02);
  nodes.push(noise);
}

function scheduleSnareRoll(
  ctx: AudioContext,
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
  const bufLen = Math.ceil(ctx.sampleRate * dur);

  for (const band of bands) {
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      const tSample = i / ctx.sampleRate;
      let timeSinceStroke = strokeInterval;
      for (const st of strokeTimes) {
        const delta = tSample - st;
        if (delta >= 0 && delta < timeSinceStroke) timeSinceStroke = delta;
      }
      const phase = timeSinceStroke / strokeInterval;
      const strokeEnv =
        phase < 0.15 ? 0.7 + Math.random() * 0.3 : 0.3 + 0.3 * (1 - phase);
      data[i] = (Math.random() * 2 - 1) * strokeEnv;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol * band.volMul, time);
    const filter = ctx.createBiquadFilter();
    filter.type = BANDPASS;
    filter.frequency.value = band.freq;
    filter.Q.value = band.qFactor;
    noise.connect(filter).connect(gain).connect(dest);
    noise.start(time);
    noise.stop(time + dur);
    nodes.push(noise);
  }

  const wireOsc = ctx.createOscillator();
  wireOsc.type = "triangle";
  wireOsc.frequency.value = SNARE_WIRE_HZ;
  const wireGain = ctx.createGain();
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
  evt: { type: string; playerId?: number; newHp?: number },
  myPlayerId: number,
): SfxKey | null {
  const mine = evt.playerId === myPlayerId;
  if (evt.type === MESSAGE.CANNON_DAMAGED && mine)
    return evt.newHp === 0 ? "cannonKilled" : null;
  if (evt.type === MESSAGE.GRUNT_SPAWNED) return "gruntSpawned";
  if (evt.type === MESSAGE.GRUNT_KILLED) return "gruntKilled";
  if (evt.type === MESSAGE.TOWER_KILLED) return "towerKilled";
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
