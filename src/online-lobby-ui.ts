import type { ClientMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import { getApiUrl } from "./online-config.ts";

interface LobbyElements {
  lobbyMenu: HTMLElement;
  lobbyCreate: HTMLElement;
  lobbyJoin: HTMLElement;
  btnCreate: HTMLElement;
  btnJoinShow: HTMLElement;
  btnCreateConfirm: HTMLElement;
  btnJoinConfirm: HTMLElement;
  btnCreateBack: HTMLElement;
  btnJoinBack: HTMLElement;
  setRounds: HTMLSelectElement;
  setHp: HTMLSelectElement;
  setWait: HTMLSelectElement;
  joinCodeInput: HTMLInputElement;
  createError: HTMLElement;
  joinError: HTMLElement;
}

interface SetupLobbyUiDeps {
  elements: LobbyElements;
  connect: () => void;
  send: (msg: ClientMessage) => void;
  getSocket: () => WebSocket | null;
  setIsHost: (value: boolean) => void;
  doc?: Document;
}

export function showLobbySection(
  id: string,
  sections: Pick<LobbyElements, "lobbyMenu" | "lobbyCreate" | "lobbyJoin">,
  doc: Document = document,
): void {
  for (const el of [
    sections.lobbyMenu,
    sections.lobbyCreate,
    sections.lobbyJoin,
  ]) {
    el.classList.remove("active");
  }
  doc.getElementById(id)?.classList.add("active");
}

export function setupLobbyUi({
  elements,
  connect,
  send,
  getSocket,
  setIsHost,
  doc = document,
}: SetupLobbyUiDeps): void {
  const sections = {
    lobbyMenu: elements.lobbyMenu,
    lobbyCreate: elements.lobbyCreate,
    lobbyJoin: elements.lobbyJoin,
  };

  elements.btnCreate.addEventListener("click", () =>
    showLobbySection("lobby-create", sections, doc),
  );
  elements.btnJoinShow.addEventListener("click", () =>
    showLobbySection("lobby-join", sections, doc),
  );
  elements.btnCreateBack.addEventListener("click", () =>
    showLobbySection("lobby-menu", sections, doc),
  );
  elements.btnJoinBack.addEventListener("click", () =>
    showLobbySection("lobby-menu", sections, doc),
  );

  elements.btnCreateConfirm.addEventListener("click", () => {
    elements.createError.textContent = "";
    const doCreate = () => {
      const roundsVal = Number(elements.setRounds.value);
      const battleLength = roundsVal > 0 ? roundsVal : 0;
      send({
        type: MSG.CREATE_ROOM,
        settings: {
          battleLength,
          cannonMaxHp: Number(elements.setHp.value),
          waitTimerSec: Number(elements.setWait.value),
        },
      });
      setIsHost(true);
    };

    connect();
    const socket = getSocket();
    if (socket?.readyState === WebSocket.OPEN) doCreate();
    else socket?.addEventListener("open", doCreate, { once: true });
  });

  elements.btnJoinConfirm.addEventListener("click", () => {
    elements.joinError.textContent = "";
    const code = elements.joinCodeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      elements.joinError.textContent = "Enter a 4-letter room code";
      return;
    }
    connect();
    const doJoin = () => send({ type: MSG.JOIN_ROOM, code });
    const socket = getSocket();
    if (socket?.readyState === WebSocket.OPEN) {
      doJoin();
    } else {
      socket?.addEventListener("open", doJoin, { once: true });
    }
  });

  // Room list: fetch and render available rooms, poll every 3s while menu is visible
  const roomListEl = doc.getElementById("room-list");
  if (roomListEl) {
    const joinViaCode = (code: string) => {
      elements.joinCodeInput.value = code;
      showLobbySection("lobby-join", sections, doc);
      elements.btnJoinConfirm.click();
    };

    const el = (tag: string, cls: string, text?: string) => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };

    const setMessage = (cls: string, text: string) => {
      roomListEl.innerHTML = "";
      roomListEl.appendChild(el("div", cls, text));
    };

    const renderRoomList = (rooms: { code: string; players: number; settings: { battleLength: number; cannonMaxHp: number }; elapsedSec: number }[]) => {
      if (rooms.length === 0) { setMessage("room-list-empty", "No rooms available"); return; }
      const roundsLabel = (v: number) => v > 0 ? `${v} rounds` : "To The Death";
      roomListEl.innerHTML = "";
      roomListEl.appendChild(el("div", "room-list-title", "Available Rooms"));
      for (const r of rooms) {
        const item = el("div", "room-item");
        item.dataset.code = r.code;
        item.appendChild(el("span", "room-code", r.code));
        const info = el("span", "room-info");
        info.append(
          `${r.players}/3 players`, doc.createElement("br"),
          `${roundsLabel(r.settings.battleLength)} · ${r.settings.cannonMaxHp} HP`,
        );
        item.appendChild(info);
        item.addEventListener("click", () => joinViaCode(r.code));
        roomListEl.appendChild(item);
      }
    };

    const fetchRooms = () => {
      fetch(getApiUrl("/api/rooms"))
        .then(r => r.json())
        .then(renderRoomList)
        .catch(() => {
          setMessage("room-list-empty", "Server unavailable");
        });
    };

    // Initial fetch + poll while lobby-menu is visible
    fetchRooms();
    if (roomPollTimer) clearInterval(roomPollTimer);
    roomPollTimer = setInterval(() => {
      if (elements.lobbyMenu.classList.contains("active")) fetchRooms();
    }, 3000);
  }
}

/** Stored interval so repeated setupLobbyUi calls don't leak timers. */
let roomPollTimer: ReturnType<typeof setInterval> | null = null;
