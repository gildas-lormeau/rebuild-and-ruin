/**
 * Online lobby bootstrapping.
 *
 * Owns the lobby DOM elements, initializes the lobby UI, and exports
 * `lobbyReady` — the single public API consumed by entry.ts.
 */

import { pageOnline } from "./online-client-runtime.ts";
import { connect } from "./online-client-ws.ts";
import { initLobbyUi } from "./online-lobby-ui.ts";
import { loadAtlas } from "./runtime-bootstrap.ts";
import { send, session } from "./runtime-online-stores.ts";

const lobbyElements = {
  btnCreateConfirm: document.getElementById("btn-create-confirm")!,
  btnJoinConfirm: document.getElementById("btn-join-confirm")!,
  rounds: document.getElementById("create-rounds") as HTMLSelectElement,
  hp: document.getElementById("create-hp") as HTMLSelectElement,
  wait: document.getElementById("create-wait") as HTMLSelectElement,
  seed: document.getElementById("create-seed") as HTMLInputElement,
  joinCodeInput: document.getElementById("join-code") as HTMLInputElement,
  createError: document.getElementById("create-error")!,
  joinError: document.getElementById("join-error")!,
};
const initDomLobby = () =>
  initLobbyUi({
    elements: lobbyElements,
    connect: () =>
      connect(() => {
        const msg = "Connection failed \u2014 is the server running?";
        lobbyElements.createError.textContent = msg;
        lobbyElements.joinError.textContent = msg;
      }),
    send,
    getSocket: () => session.socket,
    setIsHost: (value) => {
      session.isHost = value;
    },
    isVisible: () => !pageOnline.hidden,
  });
export const lobbyReady = loadAtlas()
  .then(initDomLobby, initDomLobby)
  .then((lobby) => {
    pageOnline.setAttribute("data-ready", "1");
    return lobby;
  });
