/**
 * Generate src/shared/platform/phase-music.ts — embeds the four phase
 * MIDI files as base64 string constants so the game doesn't ship
 * extra .mid assets or pay a fetch round-trip on phase start.
 *
 * Re-run whenever the source MIDIs change:
 *   deno run -A scripts/gen-phase-music.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

const SRC_DIR = "tmp/midi-split";
const OUT_FILE = "src/shared/platform/phase-music.ts";
const MIDIS = [
  { key: "TITLE", file: "RXMI_TITLE_song01.mid" },
  { key: "BUILD", file: "RXMI_TETRIS_song01.mid" },
  { key: "CANNON", file: "RXMI_CANNON_song01.mid" },
  { key: "BATTLE", file: "RXMI_BATTLE_song07.mid" },
];
const entries = MIDIS.map(({ key, file }) => {
  const bytes = readFileSync(`${SRC_DIR}/${file}`);
  const b64 = bytes.toString("base64");
  return { key, file, b64, size: bytes.length };
});
const body = `/**
 * Embedded base64-encoded MIDI files for each phase's background music.
 * Sources (AUTO-GENERATED — do not edit by hand; re-run
 * \`deno run -A scripts/gen-phase-music.ts\` to regenerate):
${entries.map((e) => ` *   - ${e.key}: tmp/midi-split/${e.file} (${e.size} bytes)`).join("\n")}
 *
 * Decoded to Uint8Array at module load so callers pay the base64 cost
 * once per page load, not per note.
 */

${entries.map((e) => `const ${e.key}_MIDI_BASE64 = "${e.b64}";`).join("\n")}

function decodeBase64(encoded: string): Uint8Array {
  const bin = atob(encoded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const PHASE_MUSIC_MIDI: {
  readonly title: Uint8Array;
  readonly build: Uint8Array;
  readonly cannon: Uint8Array;
  readonly battle: Uint8Array;
} = {
  title: decodeBase64(TITLE_MIDI_BASE64),
  build: decodeBase64(BUILD_MIDI_BASE64),
  cannon: decodeBase64(CANNON_MIDI_BASE64),
  battle: decodeBase64(BATTLE_MIDI_BASE64),
};
`;

writeFileSync(OUT_FILE, body);

console.log(
  `Wrote ${OUT_FILE} (${entries.length} MIDIs, total ${entries.reduce((sum, e) => sum + e.size, 0)} bytes)`,
);
