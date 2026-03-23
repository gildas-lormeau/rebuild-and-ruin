import type { ClientMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import { getApiUrl } from "./online-client.ts";

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

    const renderRoomList = (rooms: { code: string; players: number; settings: { battleLength: number; cannonMaxHp: number }; elapsedSec: number }[]) => {
      if (rooms.length === 0) {
        roomListEl.innerHTML = `<div class="room-list-empty">No rooms available</div>`;
        return;
      }
      const roundsLabel = (v: number) => v > 0 ? `${v} rounds` : "To The Death";
      roomListEl.innerHTML = `<div class="room-list-title">Available Rooms</div>` +
        rooms.map(r => `
          <div class="room-item" data-code="${r.code}">
            <span class="room-code">${r.code}</span>
            <span class="room-info">${r.players}/3 players<br>${roundsLabel(r.settings.battleLength)} · ${r.settings.cannonMaxHp} HP</span>
          </div>
        `).join("");
      for (const item of roomListEl.querySelectorAll(".room-item")) {
        item.addEventListener("click", () => {
          const code = (item as HTMLElement).dataset.code;
          if (code) joinViaCode(code);
        });
      }
    };

    const fetchRooms = () => {
      fetch(getApiUrl("/api/rooms"))
        .then(r => r.json())
        .then(renderRoomList)
        .catch(() => {
          roomListEl.innerHTML = `<div class="room-list-empty">Server unavailable</div>`;
        });
    };

    // Initial fetch + poll while lobby-menu is visible
    fetchRooms();
    setInterval(() => {
      if (elements.lobbyMenu.classList.contains("active")) fetchRooms();
    }, 3000);
  }
}
