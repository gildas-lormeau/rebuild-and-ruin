/**
 * Sound effects system using jsfxr for procedural 8-bit audio.
 * Mirrors input-haptics.ts: module-level state, exported functions,
 * processes the same battle event stream.
 *
 * Respects the sound setting: 0=off, 1=phase changes only, 2=all.
 */

import { sfxr } from "jsfxr";
import { MSG } from "../server/protocol.ts";

type SfxKey = keyof typeof SFX_DEFS;

// Wave shapes: SQUARE=0, SAWTOOTH=1, SINE=2, NOISE=3
const RATE = 44100;
const SFX_DEFS = {
  // Battle ─────────────────────────────────────────────────────────────
  cannonFire: {
    wave_type: 3,
    p_env_attack: 0,
    p_env_sustain: 0.15,
    p_env_punch: 0.3,
    p_env_decay: 0.2,
    p_base_freq: 0.2,
    p_freq_ramp: -0.15,
    sound_vol: 0.4,
    sample_rate: RATE,
    sample_size: 8,
  },
  impact: {
    wave_type: 3,
    p_env_attack: 0,
    p_env_sustain: 0.08,
    p_env_punch: 0.4,
    p_env_decay: 0.15,
    p_base_freq: 0.15,
    p_freq_ramp: -0.2,
    sound_vol: 0.3,
    sample_rate: RATE,
    sample_size: 8,
  },
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

  // Build / Cannon ─────────────────────────────────────────────────────
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
  // Phase / UI ─────────────────────────────────────────────────────────
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
/** Minimum ms between consecutive plays of the same SFX key. */
const COOLDOWN_MS = 60;
/** Pre-generated WAV data URIs, keyed by SFX name. Lazily populated. */
const wavCache = new Map<SfxKey, string>();
/** Timestamp of last play per SFX key (for cooldown). */
const lastPlayTime = new Map<SfxKey, number>();
/** Pool of reusable Audio elements per SFX key. */
const POOL_SIZE = 3;
const audioPool = new Map<SfxKey, HTMLAudioElement[]>();
const IMPACT: SfxKey = "impact";

/** Current sound level — 0=off, 1=phase only, 2=all. */
let level = 2;

export function setSoundLevel(l: number): void {
  level = l;
}

// Phase transitions (level 1+)
export function soundPhaseStart(): void {
  play("phaseStart", 1);
}

// Battle events (level 2)
export function soundBattleEvents(
  events: ReadonlyArray<{
    type: string;
    playerId?: number;
    hp?: number;
    newHp?: number;
  }>,
  myPlayerId: number,
): void {
  if (level < 2) return;
  for (const evt of events) {
    const key = battleEventSound(evt, myPlayerId);
    if (key) play(key, 2);
  }
}

// Player actions (level 2)
export function soundPiecePlaced(): void {
  play("piecePlaced", 2);
}

export function soundPieceFailed(): void {
  play("pieceFailed", 2);
}

export function soundPieceRotated(): void {
  play("pieceRotated", 2);
}

export function soundCannonPlaced(): void {
  play("cannonPlaced", 2);
}

// Life events (level 1+)
export function soundLifeLost(): void {
  play("lifeLost", 1);
}

export function soundGameOver(): void {
  play("gameOver", 1);
}

/** Play a sound effect at the given minimum level, respecting cooldown. */
function play(key: SfxKey, minLevel: number): void {
  if (level < minLevel) return;
  const now = performance.now();
  const last = lastPlayTime.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastPlayTime.set(key, now);
  const audio = getPooledAudio(key);
  audio.volume = level === 1 ? 0.5 : 1;
  audio.play().catch(() => {});
}

/** Get a reusable Audio element from the pool (or create one). */
function getPooledAudio(key: SfxKey): HTMLAudioElement {
  let pool = audioPool.get(key);
  if (!pool) {
    pool = [];
    audioPool.set(key, pool);
  }
  // Reuse a finished element
  for (const el of pool) {
    if (el.ended || el.paused) {
      el.currentTime = 0;
      return el;
    }
  }
  // Create a new element if pool isn't full
  if (pool.length < POOL_SIZE) {
    const el = new Audio(getWav(key));
    pool.push(el);
    return el;
  }
  // Pool full and all playing — steal the oldest
  const el = pool[0]!;
  el.currentTime = 0;
  return el;
}

/** Get or create the WAV data URI for a sound. */
function getWav(key: SfxKey): string {
  let uri = wavCache.get(key);
  if (!uri) {
    uri = (sfxr.toWave(SFX_DEFS[key]) as { dataURI: string }).dataURI;
    wavCache.set(key, uri);
  }
  return uri;
}

/** Map a battle event to the SFX key to play (or null to skip). */
function battleEventSound(
  evt: { type: string; playerId?: number; newHp?: number },
  myPlayerId: number,
): SfxKey | null {
  const mine = evt.playerId === myPlayerId;
  if (evt.type === MSG.CANNON_FIRED && mine) return "cannonFire";
  if (evt.type === MSG.WALL_DESTROYED && mine) return IMPACT;
  if (evt.type === MSG.CANNON_DAMAGED && mine)
    return evt.newHp === 0 ? "cannonKilled" : "impact";
  if (evt.type === MSG.GRUNT_SPAWNED) return "gruntSpawned";
  if (evt.type === MSG.GRUNT_KILLED) return "gruntKilled";
  if (evt.type === MSG.TOWER_KILLED) return "towerKilled";
  if (evt.type === MSG.HOUSE_DESTROYED || evt.type === MSG.PIT_CREATED)
    return IMPACT;
  return null;
}
