/** Send a pre-serialized JSON string to a socket, guarded by readyState. */
export function safeSendRaw(socket: WebSocket, json: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(json);
}
