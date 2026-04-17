/**
 * Player-supplied music assets — IndexedDB persistence + validation.
 *
 * The game doesn't ship original Rampart music; players drop their own
 * RAMP.AD + RXMI_*.xmi from a legitimate DOS install via a file picker.
 * Files are cached in IndexedDB so the picker is a one-time chore per browser.
 *
 * Pure data module: only touches IndexedDB and the File API, no audio/engine
 * dependencies. The music subsystem (separate file) consumes `MusicAssets` to
 * drive libadlmidi-js. If any required file is missing, `loadStoredAssets`
 * returns undefined and the game runs silently.
 */

import { unzipSync } from "fflate";

export type XmiFileKey = (typeof XMI_FILE_KEYS)[number];

export type AssetKey = "RAMP.AD" | XmiFileKey;

export interface MusicAssets {
  readonly rampAd: Uint8Array;
  readonly xmi: Readonly<Record<XmiFileKey, Uint8Array>>;
}

export interface StoredFileStatus {
  readonly key: AssetKey;
  readonly present: boolean;
  readonly size: number | null;
}

export interface StoreResult {
  readonly accepted: AssetKey[];
  readonly rejected: { readonly name: string; readonly reason: string }[];
  readonly missing: AssetKey[];
}

const DB_NAME = "rebuild-and-ruin-music";
const DB_VERSION = 1;
const STORE_NAME = "assets";
/** Expected on-disk sizes from the original DOS install (bytes). Used only as
 *  a sanity check in the validator; libadlmidi rejects malformed content later. */
const EXPECTED_SIZES: Record<AssetKey, { min: number; max: number }> = {
  "RAMP.AD": { min: 2000, max: 6000 },
  "RXMI_TITLE.xmi": { min: 100, max: 80000 },
  "RXMI_BATTLE.xmi": { min: 100, max: 80000 },
  "RXMI_CANNON.xmi": { min: 100, max: 80000 },
  "RXMI_TETRIS.xmi": { min: 100, max: 80000 },
  "RXMI_SCORE.xmi": { min: 100, max: 80000 },
  "RXMI_WINBAT.xmi": { min: 100, max: 80000 },
  "RXMI_GIL.xmi": { min: 100, max: 80000 },
};
/** DOS 8-char name → long XmiFileKey mapping used inside RMUSIC.RSC.
 *  The chunk bodies are byte-identical to the extracted RXMI_*.xmi files the
 *  file picker accepts; only the labels differ. */
const RSC_XMI_NAME_MAP: Readonly<Record<string, XmiFileKey>> = {
  RXMI_BAT: "RXMI_BATTLE.xmi",
  RXMI_CAN: "RXMI_CANNON.xmi",
  RXMI_GIL: "RXMI_GIL.xmi",
  RXMI_SCO: "RXMI_SCORE.xmi",
  RXMI_TET: "RXMI_TETRIS.xmi",
  RXMI_TIT: "RXMI_TITLE.xmi",
  RXMI_WIN: "RXMI_WINBAT.xmi",
};
export const DEFAULT_ARCHIVE_URL =
  "https://cors.archive.org/cors/msdos_Rampart_1992/Rampart_1992.zip";
export const RAMP_AD_KEY = "RAMP.AD" as const;
export const XMI_FILE_KEYS = [
  "RXMI_TITLE.xmi",
  "RXMI_BATTLE.xmi",
  "RXMI_CANNON.xmi",
  "RXMI_TETRIS.xmi",
  "RXMI_SCORE.xmi",
  "RXMI_WINBAT.xmi",
  "RXMI_GIL.xmi",
] as const;

export async function loadStoredAssets(): Promise<MusicAssets | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openDatabase();
  try {
    const rampAd = await readBytes(database, RAMP_AD_KEY);
    if (!rampAd) return undefined;
    const xmi = {} as Record<XmiFileKey, Uint8Array>;
    for (const key of XMI_FILE_KEYS) {
      const bytes = await readBytes(database, key);
      if (!bytes) return undefined;
      xmi[key] = bytes;
    }
    return { rampAd, xmi };
  } finally {
    database.close();
  }
}

export async function storeAssets(files: Iterable<File>): Promise<StoreResult> {
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const file of files) {
    entries.push({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return writeEntries(entries);
}

export async function fetchAndStoreFromArchive(
  url: string,
): Promise<StoreResult> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  const zipBytes = new Uint8Array(await response.arrayBuffer());
  // The IA mirror of the DOS install ships RMUSIC.RSC (a Miles RSC bundle) plus
  // RAMP.AD — there are no standalone RXMI_*.xmi files to match. We extract the
  // XMIs out of RMUSIC.RSC below, so also accept .RSC here (filter=undefined
  // would unzip everything; we include only what we might use to save memory).
  const extracted = unzipSync(zipBytes, {
    filter: (file) =>
      matchAssetKey(file.name) !== null ||
      file.name.toLowerCase().endsWith("rmusic.rsc"),
  });
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const [name, bytes] of Object.entries(extracted)) {
    if (name.toLowerCase().endsWith("rmusic.rsc")) {
      for (const xmi of extractXmiFromRsc(bytes)) entries.push(xmi);
    } else {
      entries.push({ name, bytes });
    }
  }
  return writeEntries(entries);
}

export async function clearStoredAssets(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  try {
    await runTransaction(database, "readwrite", (store) => store.clear());
  } finally {
    database.close();
  }
}

function extractXmiFromRsc(
  data: Uint8Array,
): { name: string; bytes: Uint8Array }[] {
  // Header (32 bytes): byte 0 = chunk count, rest zero-padded.
  // Directory starts at offset 0x14, 20 bytes per entry:
  //   [0..7]   name (NUL-padded, 8 chars)
  //   [8..11]  reserved
  //   [12..15] offset (uint32 LE)
  //   [16..19] size (uint32 LE)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data[0] ?? 0;
  const directoryStart = 0x14;
  const results: { name: string; bytes: Uint8Array }[] = [];
  for (let index = 0; index < count; index++) {
    const entryOffset = directoryStart + index * 20;
    if (entryOffset + 20 > data.byteLength) break;
    const rawName = data
      .subarray(entryOffset, entryOffset + 8)
      .reduce(
        (acc, byte) => (byte === 0 ? acc : acc + String.fromCharCode(byte)),
        "",
      );
    const chunkOffset = view.getUint32(entryOffset + 12, true);
    const chunkSize = view.getUint32(entryOffset + 16, true);
    const longName = RSC_XMI_NAME_MAP[rawName];
    if (!longName) continue;
    if (chunkOffset + chunkSize > data.byteLength) continue;
    // Copy instead of subarray — structured-clone preserves offset+length but
    // clones the full underlying buffer, which would bloat IDB 30-40×.
    const copy = new Uint8Array(chunkSize);
    copy.set(data.subarray(chunkOffset, chunkOffset + chunkSize));
    results.push({ name: longName, bytes: copy });
  }
  return results;
}

async function writeEntries(
  entries: readonly { name: string; bytes: Uint8Array }[],
): Promise<StoreResult> {
  if (typeof indexedDB === "undefined") {
    return {
      accepted: [],
      rejected: [{ name: "(all)", reason: "IndexedDB unavailable" }],
      missing: [RAMP_AD_KEY, ...XMI_FILE_KEYS],
    };
  }
  const database = await openDatabase();
  const accepted: AssetKey[] = [];
  const rejected: { name: string; reason: string }[] = [];
  try {
    for (const entry of entries) {
      const key = matchAssetKey(entry.name);
      if (!key) {
        rejected.push({
          name: entry.name,
          reason: "not a recognized Rampart file",
        });
        continue;
      }
      const bounds = EXPECTED_SIZES[key];
      if (
        entry.bytes.byteLength < bounds.min ||
        entry.bytes.byteLength > bounds.max
      ) {
        rejected.push({
          name: entry.name,
          reason: `size ${entry.bytes.byteLength} outside expected ${bounds.min}–${bounds.max} bytes`,
        });
        continue;
      }
      await writeBytes(database, key, entry.bytes);
      accepted.push(key);
    }
  } finally {
    database.close();
  }
  const missing: AssetKey[] = [];
  const presentKeys = new Set<AssetKey>(accepted);
  const status = await listStoredAssets();
  for (const item of status) {
    if (item.present) presentKeys.add(item.key);
  }
  for (const key of [RAMP_AD_KEY, ...XMI_FILE_KEYS] as const) {
    if (!presentKeys.has(key)) missing.push(key);
  }
  return { accepted, rejected, missing };
}

export async function listStoredAssets(): Promise<StoredFileStatus[]> {
  if (typeof indexedDB === "undefined") {
    return [RAMP_AD_KEY, ...XMI_FILE_KEYS].map((key) => ({
      key,
      present: false,
      size: null,
    }));
  }
  const database = await openDatabase();
  try {
    const result: StoredFileStatus[] = [];
    for (const key of [RAMP_AD_KEY, ...XMI_FILE_KEYS] as const) {
      const bytes = await readBytes(database, key);
      result.push({
        key,
        present: bytes !== null,
        size: bytes?.byteLength ?? null,
      });
    }
    return result;
  } finally {
    database.close();
  }
}

function matchAssetKey(filename: string): AssetKey | null {
  const normalized = filename.split(/[\\/]/).at(-1)?.trim();
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  if (lowered === RAMP_AD_KEY.toLowerCase()) return RAMP_AD_KEY;
  for (const key of XMI_FILE_KEYS) {
    if (lowered === key.toLowerCase()) return key;
  }
  return null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function readBytes(
  database: IDBDatabase,
  key: AssetKey,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const value = request.result;
      if (!value) return resolve(null);
      if (value instanceof Uint8Array) return resolve(value);
      if (value instanceof ArrayBuffer) return resolve(new Uint8Array(value));
      reject(new Error(`stored value for ${key} has unexpected type`));
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

function writeBytes(
  database: IDBDatabase,
  key: AssetKey,
  bytes: Uint8Array,
): Promise<void> {
  return runTransaction(database, "readwrite", (store) =>
    store.put(bytes, key),
  );
}

function runTransaction(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB write failed"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}
