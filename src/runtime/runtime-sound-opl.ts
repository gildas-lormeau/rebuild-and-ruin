/**
 * OPL2 patch → Web Audio renderer.
 *
 * Given a decoded OplPatch from shared/platform/opl2.ts, synthesizes
 * notes using a modulator → carrier FM pair that approximates the
 * Yamaha YM3812 2-op algorithm.
 *
 * Feedback approximation: OPL2's single-sample self-feedback on op1
 * can't be expressed on a Web Audio OscillatorNode (no tight feedback
 * loop), so we substitute a richer modulator waveform (sawtooth at
 * FB=7, triangle at FB 3-5) to produce comparable harmonic content.
 * Non-sine OPL waveforms (wave 1-3) fall back to sine — callers that
 * need them exactly should render off-line to a buffer instead.
 */

import {
  OPL_ATTACK_MS,
  OPL_DECAY_MS,
  OPL_SUSTAIN_DB,
  type OplOperator,
  type OplPatch,
  type OplScore,
} from "../shared/platform/opl2.ts";

/** MIDI → frequency reference (A4 = 440 Hz, MIDI note 69). */
const MIDI_A4_HZ = 440;
const MIDI_A4_NOTE = 69;
const SEMITONES_PER_OCTAVE = 12;
/** MIDI velocity max — used to normalize velocity to 0..1. */
const MIDI_VELOCITY_MAX = 127;
/** TL register step in dB (OPL2 spec). */
const TL_DB_PER_STEP = 0.75;
/** Carrier output scale — tuned so 2-voice fanfare chords sit ~level
 *  with the jsfxr SFX layer (piece-placed, cannon-fired) which peaks
 *  around 0.25-0.3. Each voice peaks at MASTER_SCALE × velocity/127,
 *  so two voices at max velocity hit ~0.16 peak. */
const MASTER_SCALE = 0.05;
/** Modulation index base — higher = more FM sidebands. */
const MOD_INDEX_BASE = 8;
/** Mod-index falloff per TL attenuation step. */
const MOD_INDEX_TL_DIVISOR = 8;
/** Feedback amplifies modulation; FB=7 ≈ 2.75x. */
const FB_BOOST_DIVISOR = 4;
/** Fraction of note duration the attack is allowed to occupy at most. */
const ATTACK_FRACTION_CAP = 0.8;
/** Extra tail time (seconds) past note-off for release ramps. */
const RELEASE_TAIL_SEC = 0.5;
/** Safety padding (seconds) after release before stopping the oscillator. */
const STOP_PADDING_SEC = 0.05;
/** Initial delay from ctx.currentTime so ramps have time to schedule. */
const START_OFFSET_SEC = 0.05;
/** Shorten scheduled note slightly so adjacent notes retrigger audibly. */
const NOTE_DURATION_FRACTION = 0.95;

/** Play an entire OplScore (chord events) on the given context. */
export function playOplScore(
  ctx: AudioContext,
  patch: OplPatch,
  score: OplScore,
  volumeScale = 1,
): void {
  const t0 = ctx.currentTime + START_OFFSET_SEC;
  for (const note of score) {
    const start = t0 + note.startSec;
    const dur = note.durationSec * NOTE_DURATION_FRACTION;
    const velocity = note.velocity * volumeScale;
    for (const midiNote of note.midiNotes) {
      const freq = midiToFreq(midiNote + patch.transposition);
      playOplNote(ctx, patch, freq, start, dur, velocity);
    }
  }
}

/** Schedule a single OPL-synthesized note on the given audio context.
 *  Routes through `destination` if provided (so callers can gate/mute a
 *  group of scheduled notes by disconnecting the gate node), otherwise
 *  straight to ctx.destination. */
export function playOplNote(
  ctx: AudioContext,
  patch: OplPatch,
  freq: number,
  startTime: number,
  durationSec: number,
  velocity: number,
  destination?: AudioNode,
): void {
  const endTime = startTime + durationSec + RELEASE_TAIL_SEC;
  const noteOffTime = startTime + durationSec;
  const velGain = velocity / MIDI_VELOCITY_MAX;

  const modFreq = freq * patch.op1.mult;
  const modOsc = makeOscillator(ctx, patch.op1, patch.feedback);
  modOsc.frequency.value = modFreq;

  const modIndex =
    MOD_INDEX_BASE * 2 ** (-patch.op1.totalLevel / MOD_INDEX_TL_DIVISOR);
  const fbBoost = 1 + patch.feedback / FB_BOOST_DIVISOR;
  const modAmount = modFreq * modIndex * fbBoost;

  const modEnv = ctx.createGain();
  modEnv.gain.value = 0;
  applyEnvelope(modEnv, patch.op1, modAmount, startTime, noteOffTime, endTime);
  modOsc.connect(modEnv);

  const carFreq = freq * patch.op2.mult;
  const carOsc = makeOscillator(ctx, patch.op2, 0);
  carOsc.frequency.value = carFreq;
  modEnv.connect(carOsc.frequency);

  const carEnv = ctx.createGain();
  carEnv.gain.value = 0;
  const carPeak = tlToGain(patch.op2.totalLevel) * velGain * MASTER_SCALE;
  applyEnvelope(carEnv, patch.op2, carPeak, startTime, noteOffTime, endTime);

  carOsc.connect(carEnv).connect(destination ?? ctx.destination);

  modOsc.start(startTime);
  carOsc.start(startTime);
  modOsc.stop(endTime + STOP_PADDING_SEC);
  carOsc.stop(endTime + STOP_PADDING_SEC);
}

function midiToFreq(note: number): number {
  return MIDI_A4_HZ * 2 ** ((note - MIDI_A4_NOTE) / SEMITONES_PER_OCTAVE);
}

function tlToGain(totalLevel: number): number {
  return 10 ** ((-totalLevel * TL_DB_PER_STEP) / 20);
}

function makeOscillator(
  ctx: AudioContext,
  operator: OplOperator,
  feedback: number,
): OscillatorNode {
  const osc = ctx.createOscillator();
  if (operator.wave === 0) {
    osc.type = feedback >= 6 ? "sawtooth" : feedback >= 3 ? "triangle" : "sine";
  } else {
    osc.type = "sine";
  }
  return osc;
}

function applyEnvelope(
  gain: GainNode,
  operator: OplOperator,
  peakGain: number,
  startTime: number,
  noteOffTime: number,
  endTime: number,
): void {
  const atkMs = OPL_ATTACK_MS[operator.ar]!;
  const decMs = OPL_DECAY_MS[operator.dr]!;
  const relMs = OPL_DECAY_MS[operator.rr]!;
  const slGain = peakGain * dbToGain(OPL_SUSTAIN_DB[operator.sustainLevel]!);
  const noteDur = noteOffTime - startTime;
  const atkSec = Math.min(atkMs / 1000, noteDur * ATTACK_FRACTION_CAP);
  const atkEnd = startTime + atkSec;
  const decTarget = operator.envType ? slGain : 0;
  const decEnd = Math.min(atkEnd + decMs / 1000, noteOffTime);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, atkEnd);
  gain.gain.linearRampToValueAtTime(decTarget, decEnd);
  if (operator.envType) {
    gain.gain.setValueAtTime(slGain, noteOffTime);
  }
  gain.gain.linearRampToValueAtTime(
    0,
    Math.min(noteOffTime + relMs / 1000, endTime),
  );
}

function dbToGain(decibels: number): number {
  return 10 ** (decibels / 20);
}
