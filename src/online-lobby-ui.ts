import type { ClientMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import { getApiUrl } from "./online-config.ts";
import { MAX_PLAYERS } from "./player-config.ts";

interface LobbyElements {
  btnCreateConfirm: HTMLElement;
  btnJoinConfirm: HTMLElement;
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
  isVisible?: () => boolean;
  doc?: Document;
}

const ROOM_CODE_LENGTH = 4;
const ROOM_POLL_INTERVAL_MS = 3000;
const SECS_PER_MIN = 60;
const SECS_PER_HOUR = 3600;

/** Stored interval so repeated setupLobbyUi calls don't leak timers. */
let roomPollTimer: ReturnType<typeof setInterval> | null = null;

export function setupLobbyUi({
  elements,
  connect,
  send,
  getSocket,
  setIsHost,
  isVisible = () => true,
  doc = document,
}: SetupLobbyUiDeps): void {
  // Pending action replaces any previous one so rapid clicks / Create→Join
  // sequences don't stack multiple "open" listeners on the same socket.
  let pendingAction: (() => void) | null = null;

  const scheduleOnOpen = (action: () => void) => {
    pendingAction = action;
    connect();
    const socket = getSocket();
    if (socket?.readyState === WebSocket.OPEN) {
      pendingAction = null;
      action();
    } else {
      socket?.addEventListener("open", () => {
        if (!pendingAction) return;
        const a = pendingAction;
        pendingAction = null;
        a();
      }, { once: true });
    }
  };

  elements.btnCreateConfirm.addEventListener("click", () => {
    elements.createError.textContent = "";
    scheduleOnOpen(() => {
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
    });
  });

  elements.btnJoinConfirm.addEventListener("click", () => {
    elements.joinError.textContent = "";
    const code = elements.joinCodeInput.value.trim().toUpperCase();
    if (code.length !== ROOM_CODE_LENGTH) {
      elements.joinError.textContent = `Enter a ${ROOM_CODE_LENGTH}-letter room code`;
      return;
    }
    scheduleOnOpen(() => send({ type: MSG.JOIN_ROOM, code }));
  });

  // Room list: fetch and render available rooms, poll every 3s while visible
  const roomListEl = doc.getElementById("room-list");
  if (roomListEl) {
    const joinViaCode = (code: string) => {
      elements.joinCodeInput.value = code;
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
      const ageLabel = (sec: number) => sec < SECS_PER_MIN ? "just now" : sec < SECS_PER_HOUR ? `${Math.floor(sec / SECS_PER_MIN)}m ago` : `${Math.floor(sec / SECS_PER_HOUR)}h ago`;
      roomListEl.innerHTML = "";
      for (const r of rooms) {
        const item = el("div", "room-item");
        item.dataset.code = r.code;
        item.appendChild(el("span", "room-code", r.code));
        const info = el("span", "room-info");
        info.append(
          `${r.players}/${MAX_PLAYERS} players · ${ageLabel(r.elapsedSec)}`, doc.createElement("br"),
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

    // Initial fetch + poll while page is visible
    fetchRooms();
    if (roomPollTimer) clearInterval(roomPollTimer);
    roomPollTimer = setInterval(() => {
      if (isVisible()) fetchRooms();
    }, ROOM_POLL_INTERVAL_MS);

    // Stop polling on page unload to avoid leaked timers
    addEventListener("pagehide", () => {
      if (roomPollTimer) { clearInterval(roomPollTimer); roomPollTimer = null; }
    }, { once: true });
  }
}
