import { ServerMessage, type ClientMessage, type DeviceInfo } from "@webdrop/shared/protocol";
import WebSocket from "ws";
import { loadConfig, type Config, type Limits } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createAppServer, type AppServer } from "../src/server.ts";

export const device: DeviceInfo = { os: "macos", browser: "chrome", form: "desktop" };

export interface Started {
  app: AppServer;
  url: string;
  origin: string;
  close(): Promise<void>;
}

const open = new Set<TestClient>();

export async function startServer(
  opts: { limits?: Partial<Limits>; env?: Record<string, string>; config?: Partial<Config> } = {},
): Promise<Started> {
  const base = loadConfig({
    LOG_LEVEL: "silent",
    PORT: "0",
    HOST: "127.0.0.1",
    STUN_URLS: "stun:stun.example.org:3478",
    // Lets tests place clients on different "networks".
    CLIENT_IP_HEADER: "x-test-ip",
    STATIC_DIR: "/nonexistent",
    ...opts.env,
  });
  const config: Config = { ...base, ...opts.config, limits: { ...base.limits, ...opts.limits } };
  const app = createAppServer(config, { log: createLogger("silent") });
  const addr = await app.listen();
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    app,
    url: `ws://127.0.0.1:${addr.port}/ws`,
    origin,
    close: async () => {
      for (const c of open) c.ws.terminate();
      open.clear();
      await app.close();
    },
  };
}

export class TestClient {
  readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    open.add(this);
    ws.on("message", (data) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(data)));
      if (!parsed.success) throw new Error("server sent invalid message: " + String(data));
      const msg = parsed.data;
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  }

  static connect(s: Started, opts: { ip?: string; origin?: string | null } = {}): Promise<TestClient> {
    const headers: Record<string, string> = {};
    if (opts.ip) headers["x-test-ip"] = opts.ip;
    const origin = opts.origin === undefined ? s.origin : opts.origin;
    const ws = new WebSocket(s.url, { headers, ...(origin === null ? {} : { origin }) });
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  next<T extends ServerMessage["t"]>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeoutMs = 2000) {
    const match = (m: ServerMessage) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>);
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0] as Extract<ServerMessage, { t: T }>);
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const waiter = { pred: match, resolve: resolve as (m: ServerMessage) => void };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for "${t}"`));
      }, timeoutMs).unref();
    });
  }

  /** Assert nothing matching arrives within `ms`. */
  async expectNone(t: ServerMessage["t"], ms = 200): Promise<void> {
    try {
      const m = await this.next(t, () => true, ms);
      throw new Error(`unexpected "${t}": ${JSON.stringify(m)}`);
    } catch (err) {
      if (!String(err).includes("timed out")) throw err;
    }
  }

  async hello(resume?: string) {
    this.send(resume ? { t: "hello", v: 1, device, resume } : { t: "hello", v: 1, device });
    const welcome = await this.next("welcome");
    const peers = await this.next("peers", (m) => m.room === "net");
    return { welcome, peers };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
