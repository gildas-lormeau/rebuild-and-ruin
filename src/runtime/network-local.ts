/**
 * `NetworkApi` factory for the "no peers" wiring shape shared by local
 * play (src/main.ts) and the headless test runtime
 * (test/runtime-headless.ts). Online play (src/online/runtime/game.ts)
 * does NOT use this — it builds its own `NetworkApi` backed by the
 * WebSocket client session. Base shape: `amHost=true`,
 * `myPlayerId=SPECTATOR_SLOT`, empty remotes, no-op `onMessage`.
 */

import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import {
  SPECTATOR_SLOT,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import type { NetworkApi } from "./types.ts";

/** Singleton empty set so repeated calls with no remotes return the same
 *  instance — runtime sub-systems read this through the `NetworkApi.remotePlayerSlots`
 *  seam, which is `ReadonlySet<ValidPlayerId>`, so the shared instance is
 *  immutable from every caller's perspective. */
const EMPTY_REMOTE_SLOTS: ReadonlySet<ValidPlayerId> = new Set();
/** Explicit no-op sender for pure-local play (no peers to notify).
 *  Named so call sites communicate intent rather than silently swallow
 *  messages via a default. */
export const noopNetworkSend: (msg: GameMessage) => void = () => {};

export function createLocalNetworkApi(opts: {
  /** REQUIRED — pass an explicit sender (or the named `noopNetworkSend`
   *  for pure-local play) so a test that forgets to wire the network
   *  seam fails loudly instead of silently dropping every message. */
  send: (msg: GameMessage) => void;
  /** Override for headless in-memory loopback delivery. */
  onMessage?: (
    handler: (msg: ServerMessage) => void | Promise<void>,
  ) => () => void;
  /** Override for headless tests simulating a peer machine. */
  remotePlayerSlots?: ReadonlySet<ValidPlayerId>;
  /** Optional override — defaults to `true` to match local/test "no peers"
   *  play where the runtime is the only authority. Network tests that
   *  build a host + watcher pair set `false` on the watcher side; this
   *  flips the broadcast gate in `buildPhaseCtx` (no `ctx.broadcast`
   *  on watchers) so transitions don't emit wire messages even though
   *  every peer runs the same `tickGame`. */
  amHost?: () => boolean;
}): NetworkApi {
  const remotes = opts.remotePlayerSlots ?? EMPTY_REMOTE_SLOTS;
  return {
    send: opts.send,
    onMessage: opts.onMessage ?? (() => () => {}),
    amHost: opts.amHost ?? (() => true),
    myPlayerId: () => SPECTATOR_SLOT,
    remotePlayerSlots: () => remotes,
  };
}
