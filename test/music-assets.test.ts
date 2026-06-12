/**
 * music-assets IndexedDB failure handling.
 *
 * An aborted transaction must REJECT the wrapping promise, never leave it
 * pending: uploads run behind sound-modal's `uploadInFlight` flag, cleared
 * in a `finally` — a promise that never settles skips the `finally` and
 * wedges every later upload for the session. The trap is spec-shaped:
 * IndexedDB aborts fire the "abort" event, NOT "error", so commit-time
 * failures (QuotaExceededError is the realistic one) reach only
 * `transaction.onabort` — a transaction promise wired with onerror alone
 * still hangs.
 *
 * Headless Deno has no indexedDB, so this drives the real upload path
 * (`storeAssets` → writeEntries → clearPcmCache) against a minimal fake
 * that completes the asset write and ABORTS the PCM-cache clear.
 */

import { assertEquals } from "@std/assert";
import { storeAssets } from "../src/runtime/audio/music-assets.ts";

type Handler = (() => void) | null;

interface FakeRequest {
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded: Handler;
  onblocked: Handler;
  result: unknown;
  error: unknown;
}

interface FakeTransaction {
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
  error: unknown;
  objectStore: (name: string) => unknown;
}

Deno.test(
  "music-assets: an aborted PCM-cache clear rejects the upload instead of hanging",
  async () => {
    const globals = globalThis as { indexedDB?: unknown };
    globals.indexedDB = fakeIndexedDb();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // RAMP.AD (a music input) within its expected 2000–6000 byte bounds —
      // accepting it makes writeEntries invalidate the PCM cache.
      const file = new File([new Uint8Array(3000)], "RAMP.AD");
      const outcome = await Promise.race([
        storeAssets([file]).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("hung"), 1500);
        }),
      ]);
      assertEquals(
        outcome,
        "rejected",
        "an aborted PCM-cache transaction must reject the upload promise — " +
          "a hang skips sound-modal's `finally` and wedges uploadInFlight " +
          "for the session",
      );
    } finally {
      clearTimeout(timer);
      delete globals.indexedDB;
    }
  },
);

/** Fake `indexedDB` global: asset-store writes complete normally; the
 *  "pcm" store's clear() ABORTS its transaction (quota-style commit
 *  failure — no request-level error event first). All events fire on a
 *  microtask so the code under test wires its handlers first, like the
 *  real event loop. */
function fakeIndexedDb(): { open: (name: string, version: number) => unknown } {
  function makeTransaction(storeName: string): FakeTransaction {
    const transaction: FakeTransaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: undefined,
      objectStore: () => ({
        put: () => {
          const request = makeRequest();
          queueMicrotask(() => transaction.oncomplete?.());
          return request;
        },
        get: () => {
          const request = makeRequest();
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        clear: () => {
          const request = makeRequest();
          queueMicrotask(() => {
            if (storeName === "pcm") {
              transaction.error = new DOMException(
                "Quota exceeded at commit",
                "QuotaExceededError",
              );
              transaction.onabort?.();
            } else {
              transaction.oncomplete?.();
            }
          });
          return request;
        },
      }),
    };
    return transaction;
  }
  return {
    open: () => {
      const request = makeRequest();
      request.result = {
        objectStoreNames: { contains: () => true },
        close: () => {},
        transaction: (storeName: string) => makeTransaction(storeName),
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}

function makeRequest(): FakeRequest {
  return {
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
    result: undefined,
    error: undefined,
  };
}
