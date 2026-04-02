/**
 * Online lobby bootstrapping.
 *
 * Owns the lobby DOM elements, initializes the lobby UI, and exports
 * `lobbyReady` — the single public API consumed by entry.ts.
 */

import { initLobbyUi } from "./online-lobby-ui.ts";
import { loadAtlas } from "./runtime-bootstrap.ts";
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
} from "./runtime-online-dom.ts";
import { ctx, send } from "./runtime-online-stores.ts";
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
    send,
    getSocket: () => ctx.session.socket,
    setIsHost: (value) => {
      ctx.session.isHost = value; // eslint-disable-line no-restricted-syntax -- lobby host assignment
    },
    isVisible: () => !pageOnline.hidden,
  });
export const lobbyReady = loadAtlas()
  .then(initDomLobby, initDomLobby)
  .then((lobby) => {
    pageOnline.setAttribute("data-ready", "1");
    return lobby;
  });
