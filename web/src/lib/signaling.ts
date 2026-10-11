import { PROTOCOL_VERSION, ServerMessage, parseJson, type ClientMessage, type DeviceInfo } from "@webdrop/shared/protocol";

export type SignalingState = "connecting" | "open" | "offline";

const RESUME_KEY = "webdrop:resume";

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reconnecting signaling socket. Keeps the server-issued resume token in
 * sessionStorage (per tab) so a reload or network blip keeps our identity.
 * Leaving the page sends `bye`, so other devices drop us at once instead of
 * after the server's resume grace period.
 */
export class SignalingClient {
  state: SignalingState = "connecting";
  onMessage: (msg: ServerMessage) => void = () => {};
  onState: (state: SignalingState) => void = () => {};

  private readonly url: string;
  private readonly device: DeviceInfo;
  private ws: WebSocket | undefined;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(url: string, device: DeviceInfo) {
    this.url = url;
    this.device = device;
  }

  start(): void {
    this.connect();
    window.addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.ws) this.reconnectNow();
    });
    window.addEventListener("pagehide", () => this.stop());
    // Restored from the back/forward cache: come back (resuming our identity if still in grace).
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      this.stopped = false;
      this.reconnectNow();
    });
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.state !== "open") return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  reconnectNow(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  /** Disconnect for good: the server removes us from our rooms right away. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.send({ t: "bye" });
    this.ws?.close(1000);
  }

  private setState(state: SignalingState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  private connect(): void {
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      const resume = storage()?.getItem(RESUME_KEY) ?? undefined;
      const hello: ClientMessage = { t: "hello", v: PROTOCOL_VERSION, device: this.device };
      if (resume && /^[A-Za-z0-9_-]{43}$/.test(resume)) hello.resume = resume;
      ws.send(JSON.stringify(hello));
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), 25_000);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const parsed = ServerMessage.safeParse(parseJson(e.data));
      if (!parsed.success) {
        console.warn("ignoring invalid server message");
        return;
      }
      const msg = parsed.data;
      if (msg.t === "welcome") {
        this.attempt = 0;
        try {
          storage()?.setItem(RESUME_KEY, msg.resume);
        } catch {
          // Storage full or blocked; we just won't resume after a reload.
        }
        this.onMessage(msg);
        this.setState("open");
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = undefined;
      if (this.stopped) return;
      this.setState("offline");
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() * 0.5);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
