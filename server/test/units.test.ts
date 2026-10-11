import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { DisplayName, RoomCode } from "@webdrop/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { clientIp, createNetworkKeyer, isPrivate } from "../src/client-ip.ts";
import { loadConfig } from "../src/config.ts";
import { createIceProvider } from "../src/ice.ts";
import { newPeerId, newResumeToken, newRoomCode } from "../src/ids.ts";
import { createLogger } from "../src/log.ts";
import { nameWords, randomName } from "../src/names.ts";
import { KeyedLimiter, TokenBucket } from "@webdrop/shared/rate-limit";
import { createAppServer } from "../src/server.ts";

const req = (headers: Record<string, string>, remoteAddress = "10.0.0.1") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe("clientIp", () => {
  it("uses the socket address by default and ignores spoofable headers", () => {
    const r = req({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" }, "::ffff:203.0.113.9");
    expect(clientIp(r, { trustProxyHops: 0 })).toBe("203.0.113.9");
  });

  it("counts trusted hops from the right of X-Forwarded-For", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.1.1.1" });
    expect(clientIp(r, { trustProxyHops: 1 })).toBe("10.1.1.1");
    expect(clientIp(r, { trustProxyHops: 2 })).toBe("203.0.113.9");
  });

  it("prefers a configured edge header and falls back when it is invalid", () => {
    expect(clientIp(req({ "cf-connecting-ip": "2001:DB8::1" }), { clientIpHeader: "cf-connecting-ip", trustProxyHops: 0 })).toBe("2001:db8::1");
    expect(clientIp(req({ "cf-connecting-ip": "garbage" }), { clientIpHeader: "cf-connecting-ip", trustProxyHops: 0 })).toBe("10.0.0.1");
  });
});

describe("network keys", () => {
  const key = createNetworkKeyer(Buffer.alloc(32, 7));

  it("treats private/loopback/link-local/ULA as one LAN", () => {
    for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.1.1", "192.168.1.9", "169.254.3.3", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivate(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "100.64.0.1"]) expect(isPrivate(ip), ip).toBe(false);
    expect(key("192.168.1.2")).toBe(key("10.0.0.5"));
  });

  it("groups IPv6 by /64, including compressed and v4-embedded forms", () => {
    expect(key("2001:db8:0:1::1")).toBe(key("2001:0db8:0000:0001:ffff:ffff:ffff:ffff"));
    expect(key("2001:db8:0:1::1")).not.toBe(key("2001:db8:0:2::1"));
    expect(key("64:ff9b::192.0.2.1")).toBe(key("64:ff9b::1"));
  });

  it("separates IPv4 addresses and never exposes the address", () => {
    expect(key("203.0.113.1")).not.toBe(key("203.0.113.2"));
    expect(key("203.0.113.1")).not.toContain("203");
    expect(createNetworkKeyer(Buffer.alloc(32, 8))("203.0.113.1")).not.toBe(key("203.0.113.1"));
  });
});

describe("rate limiting", () => {
  it("token bucket refills over time", () => {
    let t = 0;
    const b = new TokenBucket(2, 1, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t = 999;
    expect(b.take()).toBe(false);
    t = 1001;
    expect(b.take()).toBe(true);
  });

  it("keyed limiter isolates keys and evicts idle buckets", () => {
    let t = 0;
    const l = new KeyedLimiter(1, 1, () => t);
    expect(l.take("a")).toBe(true);
    expect(l.take("a")).toBe(false);
    expect(l.take("b")).toBe(true);
    t = 5000;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe("ids and names", () => {
  it("generates ids, tokens and codes in the protocol formats", () => {
    expect(newPeerId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newResumeToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (let i = 0; i < 200; i++) expect(RoomCode.safeParse(newRoomCode()).success).toBe(true);
  });

  it("every possible name passes the client-side schema", () => {
    for (const a of nameWords.adjectives) for (const n of nameWords.nouns) expect(DisplayName.safeParse(`${a} ${n}`).success).toBe(true);
    expect(DisplayName.safeParse("Rowdy Outlaw 42").success).toBe(true);
    expect(DisplayName.safeParse("<img src=x>").success).toBe(false);
  });

  it("falls back to a numeric suffix when the namespace is exhausted", () => {
    const all = new Set(nameWords.adjectives.flatMap((a) => nameWords.nouns.map((n) => `${a} ${n}`)));
    expect(randomName(all)).toMatch(/ \d+$/);
  });
});

describe("config", () => {
  it("has safe defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.trustProxyHops).toBe(0);
    expect(c.clientIpHeader).toBeUndefined();
    expect(c.allowedOrigins).toEqual([]);
  });

  it.each([
    [{ PORT: "abc" }],
    [{ ALLOWED_ORIGINS: "https://a.example/path" }],
    [{ TURN_SECRET: "s" }],
    [{ CF_TURN_KEY_ID: "k" }],
    [{ STUN_URLS: "http://not-ice" }],
    [{ CLIENT_IP_HEADER: "bad header" }],
  ])("rejects invalid env %j", (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});

describe("ICE provider", () => {
  const log = createLogger("silent");

  it("mints coturn REST credentials without exposing the secret", async () => {
    const config = loadConfig({ STUN_URLS: "", TURN_URLS: "turn:turn.example:3478", TURN_SECRET: "s3cret", TURN_TTL_SECONDS: "600" });
    const servers = await createIceProvider(config, log)("PEER");
    expect(servers).toHaveLength(1);
    const { username, credential } = servers[0]!;
    const [expiry, peer] = username!.split(":");
    expect(peer).toBe("PEER");
    expect(Number(expiry) - Date.now() / 1000).toBeGreaterThan(590);
    expect(credential).toBe(createHmac("sha1", "s3cret").update(username!).digest("base64"));
    expect(JSON.stringify(servers)).not.toContain("s3cret");
  });

  it("fetches and caches Cloudflare TURN credentials, dropping port 53", async () => {
    const config = loadConfig({ STUN_URLS: "", CF_TURN_KEY_ID: "key", CF_TURN_API_TOKEN: "tok" });
    const fetchMock = vi.fn(async () =>
      Response.json({
        iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"], username: "u", credential: "c" }],
      }),
    );
    const provider = createIceProvider(config, log, fetchMock as unknown as typeof fetch);
    const servers = await provider("A");
    await provider("B");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(servers).toEqual([{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("degrades to STUN only when Cloudflare is unreachable", async () => {
    const config = loadConfig({ CF_TURN_KEY_ID: "key", CF_TURN_API_TOKEN: "tok" });
    const provider = createIceProvider(config, log, (async () => new Response("", { status: 500 })) as typeof fetch);
    expect(await provider("A")).toEqual([{ urls: config.stunUrls }]);
  });
});

describe("static files", () => {
  async function serve() {
    const dir = mkdtempSync(path.join(tmpdir(), "webdrop-static-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>x</title>" + " ".repeat(2000));
    writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(path.join(dir, "secret.env"), "TOKEN=1");
    const config = { ...loadConfig({ LOG_LEVEL: "silent", PORT: "0", HOST: "127.0.0.1" }), staticDir: dir };
    const app = createAppServer(config, { log: createLogger("silent") });
    const { port } = await app.listen();
    return { app, base: `http://127.0.0.1:${port}` };
  }

  it("serves the app with security headers, caching and compression", async () => {
    const { app, base } = await serve();
    try {
      const res = await fetch(base + "/", { headers: { "accept-encoding": "br" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("require-trusted-types-for 'script'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const asset = await fetch(base + "/assets/app-abc123.js");
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(asset.headers.get("content-type")).toContain("text/javascript");

      const etag = res.headers.get("etag")!;
      const again = await fetch(base + "/index.html", { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);
    } finally {
      await app.close();
    }
  });

  it("brotli-compresses text assets", async () => {
    const { app, base } = await serve();
    try {
      // Use node:http directly so the body is not transparently decoded.
      const http = await import("node:http");
      const body = await new Promise<Buffer>((resolve) =>
        http.get(base + "/index.html", { headers: { "accept-encoding": "br" } }, (res) => {
          expect(res.headers["content-encoding"]).toBe("br");
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)));
        }),
      );
      expect(brotliDecompressSync(body).toString()).toContain("<title>x</title>");
    } finally {
      await app.close();
    }
  });

  it("serves only indexed file types and never escapes the root", async () => {
    const { app, base } = await serve();
    try {
      const http = await import("node:http");
      // Raw paths (fetch would normalize the dot segments away client-side).
      const status = (p: string) =>
        new Promise<number>((resolve) =>
          http.get({ host: "127.0.0.1", port: new URL(base).port, path: p }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          }),
        );
      for (const p of ["/secret.env", "/../package.json", "/%2e%2e/package.json", "/assets/../../package.json", "//etc/passwd", "/nope"]) {
        expect(await status(p), p).toBe(404);
      }
      expect((await fetch(base + "/", { method: "POST" })).status).toBe(405);
    } finally {
      await app.close();
    }
  });
});
