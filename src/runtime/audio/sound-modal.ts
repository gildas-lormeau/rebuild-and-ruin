/**
 * Sound settings modal — HTML overlay opened from the options screen.
 * Manages player-supplied Rampart music files (RAMP.AD + RXMI_*.xmi);
 * named generically ("Sound") so future SFX pickers can land here. DOM
 * nodes live in index.html (Vite rewrites asset paths); this file wires
 * events and proxies to music-assets.ts. The source URL persists in
 * `localStorage` because the binary payload it fetches is in IndexedDB.
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
  /** Register a callback invoked synchronously when the close button is
   *  clicked, before the async `loadStoredAssets` reload. Use this for
   *  gesture-bound work (e.g. constructing an `AudioContext`) that must
   *  happen inside the click's transient activation window — the regular
   *  `onClose` runs after at least one await and may be too late. */
  setOnCloseSync(callback: () => void): void;
}

const MUSIC_URL_STORAGE_KEY = "castles99_music_url";

export function createSoundModal(): SoundModal {
  const modal = requireElement<HTMLDivElement>("#sound-modal");
  const backdrop = requireElement<HTMLDivElement>(
    "#sound-modal .sound-modal-backdrop",
  );
  const urlInput = requireElement<HTMLInputElement>("#music-url");
  const loadUrlButton = requireElement<HTMLButtonElement>(
    "#btn-music-load-url",
  );
  const pickZipButton = requireElement<HTMLButtonElement>(
    "#btn-music-pick-zip",
  );
  const pickFilesButton = requireElement<HTMLButtonElement>(
    "#btn-music-pick-files",
  );
  const zipPicker = requireElement<HTMLInputElement>("#music-zip-picker");
  const filesPicker = requireElement<HTMLInputElement>("#music-files-picker");
  const statusOutput = requireElement<HTMLOutputElement>("#music-status");
  const closeButton = requireElement<HTMLButtonElement>("#btn-sound-close");

  let onClose: (assets: MusicAssets | undefined) => void = () => {};
  let onCloseSync: () => void = () => {};
  // True while an upload (IDB writes + the multi-second WASM render) is
  // running. A close during that window must NOT hand assets back yet:
  // the consumer's refresh would probe IDB mid-write, flag every
  // not-yet-rendered track as missing, and nothing would re-probe until
  // the next modal close — those tracks stay silent for the session.
  let uploadInFlight = false;
  // Close was clicked mid-upload; the reload is owed when the upload ends.
  let pendingCloseReload = false;

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
    // Sync first: lets the consumer construct AudioContext / call resume()
    // inside the close-button gesture. Async second: hand back the reloaded
    // assets once IDB has confirmed them — deferred to the upload's end
    // when one is still writing (see `uploadInFlight`).
    onCloseSync();
    if (uploadInFlight) {
      pendingCloseReload = true;
      return;
    }
    // A failed IDB read must still hand the close back (no assets) —
    // unhandled, the rejection escapes the close gesture entirely.
    void loadStoredAssets()
      .then((assets) => onClose(assets))
      .catch(() => onClose(undefined));
  }

  // Fire the close-reload owed from a close() that landed mid-upload, now
  // that IDB is settled. Skipped if the modal was reopened in the meantime
  // — the next real close reloads.
  function flushDeferredClose(): void {
    if (!pendingCloseReload) return;
    pendingCloseReload = false;
    if (!modal.hidden) return;
    void loadStoredAssets()
      .then((assets) => onClose(assets))
      .catch(() => onClose(undefined));
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
    // Single-flight: the URL button disables itself, but the file pickers
    // stay clickable during a URL load (and vice versa). Two overlapping
    // uploads would let the first `finally` clear `uploadInFlight` while
    // the second is still writing — exactly the mid-write close the flag
    // exists to prevent.
    if (uploadInFlight) {
      statusOutput.textContent = "Another upload is still running …";
      return;
    }
    const url = urlInput.value.trim();
    if (!url) {
      statusOutput.textContent = "Please enter a URL.";
      return;
    }
    statusOutput.textContent = `Fetching ${url} \u2026`;
    loadUrlButton.disabled = true;
    uploadInFlight = true;
    try {
      const result = await fetchAndStoreFromArchive(url);
      reportResult(result);
      await maybeRenderAfterUpload(result);
    } catch (error) {
      statusOutput.textContent = `Load failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      loadUrlButton.disabled = false;
      uploadInFlight = false;
      flushDeferredClose();
    }
  }

  async function handleLoadFromFiles(picker: HTMLInputElement): Promise<void> {
    // Single-flight — see handleLoadFromUrl. Clear the picker so the same
    // file can be re-selected once the running upload finishes.
    if (uploadInFlight) {
      picker.value = "";
      statusOutput.textContent = "Another upload is still running …";
      return;
    }
    const files = picker.files;
    if (!files?.length) return;
    statusOutput.textContent = `Saving ${files.length} file(s) \u2026`;
    uploadInFlight = true;
    try {
      const result = await storeAssets(Array.from(files));
      reportResult(result);
      await maybeRenderAfterUpload(result);
    } catch (error) {
      statusOutput.textContent = `Save failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      picker.value = "";
      uploadInFlight = false;
      flushDeferredClose();
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
    statusOutput.textContent = parts.join(" ");
  }

  // After a successful upload that completed the music set, render every
  // track to PCM and persist it. This pushes the slow synth pass out of
  // the in-game `activate()` path and into the settings flow where the
  // user already expects to wait. `loadStoredAssets` is the gate: it needs
  // RAMP.AD + the XMIs (the render inputs) and tolerates a missing
  // SOUND.RSC \u2014 that file is SFX-only and optional, so it must not block
  // the render (`result.missing` includes it). If the music set is still
  // incomplete this returns undefined and the next upload retries.
  async function maybeRenderAfterUpload(result: StoreResult): Promise<void> {
    if (!result.accepted.length) return;
    const assets = await loadStoredAssets();
    if (!assets) return;
    statusOutput.textContent = "Rendering music \u2026";
    // We need a sample rate but no playback. AudioContext starts suspended
    // outside a user gesture; .sampleRate is readable regardless. Closing
    // it releases the resource immediately.
    let sampleRate = 48000;
    try {
      if (typeof AudioContext !== "undefined") {
        const probe = new AudioContext();
        sampleRate = probe.sampleRate;
        await probe.close().catch(() => {});
      }
    } catch {
      // Probe failed \u2014 fall back to 48 kHz default. Resampling at playback
      // covers any mismatch.
    }
    try {
      // Dynamic import keeps Vite's `?url` suffix out of the Deno test
      // harness's static-resolution path. The renderer module pulls in
      // libadlmidi WASM URLs that Deno can't parse.
      const loader = await import("./music-synth-loader.ts");
      const summary = await loader.renderAllTracksToCache(
        assets,
        sampleRate,
        (done, total) => {
          statusOutput.textContent = `Rendering music \u2026 ${done}/${total}`;
        },
      );
      if (summary.failed.length) {
        statusOutput.textContent =
          `Music ready, but ${summary.failed.length} track(s) failed to ` +
          `render: ${summary.failed.join(", ")}.`;
      } else {
        statusOutput.textContent = `Music ready (${summary.rendered} tracks). Close to hear it.`;
      }
    } catch (error) {
      statusOutput.textContent = `Render failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  return {
    show,
    setOnClose(callback) {
      onClose = callback;
    },
    setOnCloseSync(callback) {
      onCloseSync = callback;
    },
  };
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`sound-modal: missing element ${selector}`);
  return element;
}
