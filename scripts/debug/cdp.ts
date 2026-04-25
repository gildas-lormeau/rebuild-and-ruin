/**
 * Minimal Chrome DevTools Protocol client over WebSocket.
 *
 * Speaks raw CDP — works against any V8 inspector (Node `--inspect`, Deno
 * `--inspect`, Chrome). No npm deps; uses Deno's built-in WebSocket.
 *
 * Usage:
 *   const cdp = await CdpClient.connect("ws://127.0.0.1:9229/...");
 *   await cdp.send("Debugger.enable");
 *   cdp.on("Debugger.paused", (params) => { ... });
 *   await cdp.send("Debugger.resume");
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

export class CdpClient {
  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (e: Event) => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        reject(
          new Error(
            `WebSocket connect failed: ${url} (${(e as ErrorEvent).message ?? "error"})`,
          ),
        );
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    return new CdpClient(ws);
  }

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => this.handleMessage(e.data as string));
    ws.addEventListener("close", () => this.handleClose());
  }

  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  private closed = false;

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error(`CDP closed; cannot send ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(data: string): void {
    const msg = JSON.parse(data) as
      | { id: number; result?: unknown; error?: { message: string } }
      | { method: string; params: Record<string, unknown> };
    if ("id" in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    const ls = this.listeners.get(msg.method);
    if (!ls) return;
    for (const l of ls) l(msg.params);
  }

  private handleClose(): void {
    this.closed = true;
    const err = new Error("CDP connection closed");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
