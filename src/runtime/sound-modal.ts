/**
 * Sound settings modal — HTML overlay opened from the in-game options screen.
 *
 * Currently manages player-supplied Rampart music files (RAMP.AD + RXMI_*.xmi).
 * Future sound-mode selection (off / music / music+sfx) and SFX pickers will
 * live in the same modal — SFX samples are sourced from the same Rampart files
 * — so the entry point is named generically ("Sound") even while today's UI
 * is music-only.
 *
 * The DOM nodes live in index.html so Vite can rewrite asset paths at build
 * time; this file only wires events and proxies to [music-assets.ts](./music-assets.ts).
 *
 * The source URL is persisted in `localStorage` (not GameSettings) because the
 * binary payload it fetches is stored in IndexedDB — a single box labeled
 * "where to re-fetch from" that lives next to the data it points at.
 */

import {
  DEFAULT_ARCHIVE_URL,
  fetchAndStoreFromArchive,
  listStoredAssets,
  loadStoredAssets,
  type MusicAssets,
  type StoreResult,
  storeAssets,
} from "./music-assets.ts";

interface SoundModal {
  show(): void;
  /** Register a callback invoked when the modal closes. Receives the reloaded
   *  `MusicAssets` (undefined if any required file is still missing). */
  setOnClose(callback: (assets: MusicAssets | undefined) => void): void;
}

const MUSIC_URL_STORAGE_KEY = "castles99_music_url";

export function createSoundModal(): SoundModal {
  const modal = document.getElementById("sound-modal") as HTMLDivElement;
  const backdrop = modal.querySelector(
    ".sound-modal-backdrop",
  ) as HTMLDivElement;
  const urlInput = document.getElementById("music-url") as HTMLInputElement;
  const loadUrlButton = document.getElementById(
    "btn-music-load-url",
  ) as HTMLButtonElement;
  const pickZipButton = document.getElementById(
    "btn-music-pick-zip",
  ) as HTMLButtonElement;
  const pickFilesButton = document.getElementById(
    "btn-music-pick-files",
  ) as HTMLButtonElement;
  const zipPicker = document.getElementById(
    "music-zip-picker",
  ) as HTMLInputElement;
  const filesPicker = document.getElementById(
    "music-files-picker",
  ) as HTMLInputElement;
  const statusOutput = document.getElementById(
    "music-status",
  ) as HTMLOutputElement;
  const closeButton = document.getElementById(
    "btn-sound-close",
  ) as HTMLButtonElement;

  let onClose: (assets: MusicAssets | undefined) => void = () => {};

  urlInput.value =
    localStorage.getItem(MUSIC_URL_STORAGE_KEY) || DEFAULT_ARCHIVE_URL;
  urlInput.addEventListener("change", () => {
    const value = urlInput.value.trim();
    if (value) localStorage.setItem(MUSIC_URL_STORAGE_KEY, value);
    else localStorage.removeItem(MUSIC_URL_STORAGE_KEY);
  });
  loadUrlButton.addEventListener("click", () => {
    void handleLoadFromUrl();
  });
  pickZipButton.addEventListener("click", () => zipPicker.click());
  pickFilesButton.addEventListener("click", () => filesPicker.click());
  zipPicker.addEventListener("change", () => {
    void handleLoadFromFiles(zipPicker);
  });
  filesPicker.addEventListener("change", () => {
    void handleLoadFromFiles(filesPicker);
  });
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  function show(): void {
    modal.hidden = false;
    void refreshStatus();
  }

  function close(): void {
    modal.hidden = true;
    void loadStoredAssets().then((assets) => onClose(assets));
  }

  async function refreshStatus(): Promise<void> {
    const status = await listStoredAssets();
    const missing = status.filter((entry) => !entry.present).length;
    statusOutput.textContent =
      missing === 0
        ? `Music ready (${status.length} files in browser storage).`
        : `Not loaded — ${missing} of ${status.length} files missing.`;
  }

  async function handleLoadFromUrl(): Promise<void> {
    const url = urlInput.value.trim();
    if (!url) {
      statusOutput.textContent = "Please enter a URL.";
      return;
    }
    statusOutput.textContent = `Fetching ${url} \u2026`;
    loadUrlButton.disabled = true;
    try {
      reportResult(await fetchAndStoreFromArchive(url));
    } catch (error) {
      statusOutput.textContent = `Load failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      loadUrlButton.disabled = false;
    }
  }

  async function handleLoadFromFiles(picker: HTMLInputElement): Promise<void> {
    const files = picker.files;
    if (!files?.length) return;
    statusOutput.textContent = `Saving ${files.length} file(s) \u2026`;
    try {
      reportResult(await storeAssets(Array.from(files)));
    } catch (error) {
      statusOutput.textContent = `Save failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      picker.value = "";
    }
  }

  function reportResult(result: StoreResult): void {
    const parts: string[] = [];
    if (result.accepted.length) {
      parts.push(`Saved ${result.accepted.length} file(s).`);
    }
    if (result.missing.length) {
      parts.push(`Still missing: ${result.missing.join(", ")}.`);
    }
    if (result.rejected.length) {
      parts.push(
        `Rejected: ${result.rejected.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}.`,
      );
    }
    if (!result.missing.length && !result.rejected.length) {
      parts.push("Music is ready \u2014 close to hear it.");
    }
    statusOutput.textContent = parts.join(" ");
  }

  return {
    show,
    setOnClose(callback) {
      onClose = callback;
    },
  };
}
