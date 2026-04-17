/**
 * Generate src/shared/platform/phase-music.ts — parses the four phase
 * MIDI files once at build time and emits tempo-resolved event arrays
 * in a human-editable TypeScript format.
 *
 * Re-run whenever the source MIDIs change or you want to regenerate
 * after hand-editing phase-music.ts:
 *   deno run -A scripts/gen-phase-music.ts
 *
 * Output format (see PhaseMusicEvent in phase-music.ts):
 *   { t: 123, ch: 2, note: 60, vel: 100, dur: 200 }  — note event
 *   { t: 0,   ch: 2, program: 10 }                    — program change
 *
 * `t` is milliseconds from song start (tempo already resolved), `dur`
 * is milliseconds. No ticks, no tempo meta — just flat events editable
 * by hand or regenerated from source.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface NoteEvent {
  t: number;
  ch: number;
  note: number;
  vel: number;
  dur: number;
}

interface ProgramEvent {
  t: number;
  ch: number;
  program: number;
}

type Event = NoteEvent | ProgramEvent;

interface ParsedMidi {
  durationMs: number;
  events: Event[];
}

const SRC_DIR = "tmp/midi-split";
const OUT_FILE = "src/shared/platform/phase-music.ts";
const MIDIS = [
  { key: "title", file: "RXMI_TITLE_song01.mid" },
  { key: "build", file: "RXMI_TETRIS_song01.mid" },
  { key: "cannon", file: "RXMI_CANNON_song01.mid" },
  { key: "battle", file: "RXMI_BATTLE_song07.mid" },
];
const parsed = MIDIS.map(({ key, file }) => {
  const bytes = readFileSync(`${SRC_DIR}/${file}`);
  return { key, file, ...parseMidi(new Uint8Array(bytes)) };
});
const body = `/**
 * Phase music — pre-parsed, tempo-resolved event arrays for each
 * phase's background track. Human-editable: tweak any \`t\`, \`dur\`,
 * \`note\`, \`vel\`, or \`program\` field and the change takes effect
 * on next build. Regenerate from source MIDIs with:
 *   deno run -A scripts/gen-phase-music.ts
 *
 * Sources (AUTO-GENERATED \u2014 do not hand-edit the event arrays if
 * you intend to re-run the generator; it will overwrite them):
${parsed.map((p) => ` *   - ${p.key}: tmp/midi-split/${p.file} (${p.events.length} events, ${p.durationMs}ms)`).join("\n")}
 *
 * Event shape:
 *   NoteEvent:    { t: ms, ch: 1-16, note: 0-127, vel: 0-127, dur: ms }
 *   ProgramEvent: { t: ms, ch: 1-16, program: 0-127 (GM number) }
 *
 * Channel 10 is the drum channel (GM convention). Program changes on
 * ch10 are ignored by the runtime (drums always use RAMP.AD snare).
 */

export interface NoteEvent {
  readonly t: number;
  readonly ch: number;
  readonly note: number;
  readonly vel: number;
  readonly dur: number;
}

export interface ProgramEvent {
  readonly t: number;
  readonly ch: number;
  readonly program: number;
}

export type PhaseMusicEvent = NoteEvent | ProgramEvent;

export interface PhaseMusic {
  readonly durationMs: number;
  readonly events: readonly PhaseMusicEvent[];
}

export const PHASE_MUSIC: {
  readonly title: PhaseMusic;
  readonly build: PhaseMusic;
  readonly cannon: PhaseMusic;
  readonly battle: PhaseMusic;
} = {
${parsed.map((p) => formatSong(p.key, p)).join("\n")}
};
`;

function parseMidi(bytes: Uint8Array): ParsedMidi {
  if (
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x54 ||
    bytes[2] !== 0x68 ||
    bytes[3] !== 0x64
  ) {
    throw new Error("not a MIDI file (missing MThd)");
  }
  const division = (bytes[12]! << 8) | bytes[13]!;
  const events: Event[] = [];
  const pendingOff = new Map<string, { startMs: number; vel: number }>();
  let pos = 22; // MThd(14) + MTrk header(8)
  let ticks = 0;
  let running = 0;
  let tempoUs = 1_000_000; // our normalized tempo (60 BPM with div=120)
  let accumMs = 0;
  let lastTick = 0;

  const tickToMs = () =>
    accumMs + ((ticks - lastTick) * tempoUs) / 1000 / division;

  while (pos < bytes.length) {
    const [delta, nextPos] = readVarlen(bytes, pos);
    pos = nextPos;
    ticks += delta;
    if (pos >= bytes.length) break;
    let status = bytes[pos]!;
    if (status < 0x80) {
      status = running;
    } else {
      running = status;
      pos++;
    }

    if (status === 0xff) {
      const meta = bytes[pos]!;
      pos++;
      const [mlen, afterLen] = readVarlen(bytes, pos);
      pos = afterLen;
      if (meta === 0x51 && mlen === 3) {
        // Tempo change — resolve time up to now, then switch tempoUs
        accumMs += ((ticks - lastTick) * tempoUs) / 1000 / division;
        lastTick = ticks;
        tempoUs =
          (bytes[pos]! << 16) | (bytes[pos + 1]! << 8) | bytes[pos + 2]!;
      }
      pos += mlen;
      if (meta === 0x2f) break;
    } else if (status >= 0x90 && status <= 0x9f) {
      const note = bytes[pos]!;
      const vel = bytes[pos + 1]!;
      const ch = (status & 0x0f) + 1;
      pos += 2;
      const t = Math.round(tickToMs());
      if (vel > 0) {
        pendingOff.set(`${ch}:${note}`, { startMs: t, vel });
      } else {
        emitNoteOff(events, pendingOff, ch, note, t);
      }
    } else if (status >= 0x80 && status <= 0x8f) {
      const note = bytes[pos]!;
      const ch = (status & 0x0f) + 1;
      pos += 2;
      emitNoteOff(events, pendingOff, ch, note, Math.round(tickToMs()));
    } else if (status >= 0xa0 && status <= 0xbf) {
      pos += 2;
    } else if (status >= 0xc0 && status <= 0xcf) {
      const program = bytes[pos]!;
      pos++;
      events.push({
        t: Math.round(tickToMs()),
        ch: (status & 0x0f) + 1,
        program,
      });
    } else if (status >= 0xd0 && status <= 0xdf) {
      pos++;
    } else if (status >= 0xe0 && status <= 0xef) {
      pos += 2;
    }
  }

  events.sort((a, b) => a.t - b.t);
  const durationMs = Math.round(tickToMs());
  return { durationMs, events };
}

function readVarlen(data: Uint8Array, pos: number): [number, number] {
  let val = 0;
  while (pos < data.length) {
    const byte = data[pos]!;
    pos++;
    val = (val << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return [val, pos];
}

function emitNoteOff(
  events: Event[],
  pending: Map<string, { startMs: number; vel: number }>,
  ch: number,
  note: number,
  tMs: number,
): void {
  const key = `${ch}:${note}`;
  const ref = pending.get(key);
  if (!ref) return;
  events.push({
    t: ref.startMs,
    ch,
    note,
    vel: ref.vel,
    dur: tMs - ref.startMs,
  });
  pending.delete(key);
}

function formatSong(name: string, parsed: ParsedMidi): string {
  const eventLines = parsed.events.map((ev) => `    ${formatEvent(ev)},`);
  return `  ${name}: {
    durationMs: ${parsed.durationMs},
    events: [
${eventLines.join("\n")}
    ],
  },`;
}

function formatEvent(ev: Event): string {
  if ("program" in ev) {
    return `{t:${ev.t},ch:${ev.ch},program:${ev.program}}`;
  }
  return `{t:${ev.t},ch:${ev.ch},note:${ev.note},vel:${ev.vel},dur:${ev.dur}}`;
}

writeFileSync(OUT_FILE, body);

console.log(
  `Wrote ${OUT_FILE} (${parsed.length} songs, ${parsed.reduce((sum, p) => sum + p.events.length, 0)} events total)`,
);
