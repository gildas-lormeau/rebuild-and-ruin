/**
 * Online lobby bootstrapping.
 *
 * Owns the lobby DOM elements, initializes the lobby UI, and exports
 * `lobbyReady` — the single public API consumed by entry.ts.
 */

import { loadAtlas } from "../render/render-sprites.ts";
import {
  btnCreateConfirm,
  btnJoinConfirm,
  createError,
  createGameMode,
  createHp,
  createRounds,
  createSeed,
  createWait,
  joinCodeInput,
  joinError,
  pageOnline,
} from "./online-dom.ts";
import { initLobbyUi } from "./online-lobby-ui.ts";
import { defaultClient } from "./online-stores.ts";
import { connect } from "./runtime-online-ws.ts";

const lobbyElements = {
  btnCreateConfirm,
  btnJoinConfirm,
  rounds: createRounds,
  hp: createHp,
  wait: createWait,
  gameMode: createGameMode,
  seed: createSeed,
  joinCodeInput,
  createError,
  joinError,
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
    send: defaultClient.send,
    getSocket: () => defaultClient.ctx.session.socket,
    setIsHost: (value) => {
      defaultClient.ctx.session.isHost = value; // eslint-disable-line no-restricted-syntax -- lobby host assignment
    },
    isVisible: () => !pageOnline.hidden,
  });
export const lobbyReady = loadAtlas()
  .then(initDomLobby, initDomLobby)
  .then((lobby) => {
    pageOnline.setAttribute("data-ready", "1");
    return lobby;
  });
