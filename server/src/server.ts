import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CloseCode, LIMITS } from "@webdrop/shared/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { clientIp, createNetworkKeyer } from "./client-ip.ts";
import type { Config } from "./config.ts";
import { Hub, type Transport } from "./hub.ts";
import { createIceProvider, type IceProvider } from "./ice.ts";
import { createLogger, type Logger } from "./log.ts";
import { applySecurityHeaders, createStaticHandler } from "./static.ts";

export interface AppServer {
  readonly server: http.Server;
  readonly hub: Hub;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

/** Browsers always send Origin on WebSocket upgrades; require it to match. */
export function originAllowed(req: IncomingMessage, config: Pick<Config, "allowedOrigins">): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  const url = URL.parse(origin);
  const host = req.headers.host;
  return url !== null && host !== undefined && (url.protocol === "https:" || url.protocol === "http:") && url.host === host;
}

const pathOf = (req: IncomingMessage) => URL.parse(req.url ?? "/", "http://x")?.pathname ?? "/";

export function createAppServer(config: Config, deps: { log?: Logger; iceProvider?: IceProvider } = {}): AppServer {
  const log = deps.log ?? createLogger(config.logLevel);
  const hub = new Hub({
    limits: config.limits,
    iceProvider: deps.iceProvider ?? createIceProvider(config, log),
    networkKey: createNetworkKeyer(),
    log,
  });
  const statics = createStaticHandler(config.staticDir);

  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    applySecurityHeaders(res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = pathOf(req);
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"ok"}');
      return;
    }
    if (pathname === "/ws") {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" }).end("Upgrade Required");
      return;
    }
    if (!statics.serve(req, res)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Not found");
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxFrameBytes,
    // Signaling frames are small; compression costs CPU/memory per socket.
    perMessageDeflate: false,
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const reject = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (pathOf(req) !== "/ws") return reject(socket, 404);
    if (!originAllowed(req, config)) {
      log.debug("ws origin rejected", { origin: req.headers.origin });
      return reject(socket, 403);
    }
    const ip = clientIp(req, config);
    const admission = hub.admit(ip);
    if (!admission.ok) {
      log.debug("ws rejected", { reason: admission.reason });
      return reject(socket, admission.status);
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, ip));
  });

  function onSocket(ws: WebSocket, ip: string) {
    const transport: Transport = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
    const conn = hub.connect(transport, ip);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      alive.set(ws, true);
      if (isBinary) return ws.close(CloseCode.policy, "text frames only");
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      conn.onMessage(text).catch((err: unknown) => log.error("message handler failed", { error: String(err) }));
    });
    ws.on("close", () => conn.onClose());
    ws.on("error", () => ws.terminate());
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, config.limits.heartbeatMs);
  heartbeat.unref();

  return {
    server,
    hub,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          log.info("listening", { port: (server.address() as AddressInfo).port, staticFiles: statics.size });
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        // Tell clients to reconnect (they resume their identity), then give the
        // close frames a moment to flush before dropping remaining sockets.
        for (const ws of wss.clients) ws.close(CloseCode.goingAway, "server restarting");
        hub.close();
        wss.close();
        server.close(() => resolve());
        setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          server.closeAllConnections();
        }, 250).unref();
      }),
  };
}
