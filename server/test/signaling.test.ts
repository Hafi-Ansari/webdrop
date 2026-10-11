import { CloseCode, LIMITS, type SignalPayload } from "@webdrop/shared/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { sleep, startServer, TestClient, type Started } from "./helpers.ts";

let s: Started;
afterEach(async () => {
  await s?.close();
});

const offer: SignalPayload = {
  kind: "description",
  sid: "AAAAAAAAAAAAAAAA",
  description: { type: "offer", sdp: "v=0\r\n" },
};

describe("discovery", () => {
  it("welcomes a client with a server-assigned identity and ICE servers", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    const { welcome, peers } = await a.hello();
    expect(welcome.self.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(welcome.self.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+/);
    expect(welcome.resumed).toBe(false);
    expect(welcome.iceServers).toEqual([{ urls: ["stun:stun.example.org:3478"] }]);
    expect(peers.peers).toEqual([]);
  });

  it("shows peers on the same network to each other and announces joins and leaves", async () => {
    s = await startServer({ limits: { resumeGraceMs: 50 } });
    const a = await TestClient.connect(s, { ip: "203.0.113.5" });
    const { welcome: wa } = await a.hello();
    const b = await TestClient.connect(s, { ip: "203.0.113.5" });
    const { welcome: wb, peers } = await b.hello();

    expect(peers.peers).toEqual([wa.self]);
    const joined = await a.next("peer-joined");
    expect(joined).toEqual({ t: "peer-joined", room: "net", peer: wb.self });

    b.ws.close();
    const left = await a.next("peer-left");
    expect(left).toEqual({ t: "peer-left", room: "net", id: wb.self.id });
  });

  it("isolates different public networks", async () => {
    s = await startServer();
    const a = await TestClient.connect(s, { ip: "203.0.113.5" });
    await a.hello();
    const b = await TestClient.connect(s, { ip: "198.51.100.7" });
    const { peers } = await b.hello();
    expect(peers.peers).toEqual([]);
    await a.expectNone("peer-joined");
  });

  it("groups IPv6 clients by /64 prefix", async () => {
    s = await startServer();
    const a = await TestClient.connect(s, { ip: "2001:db8:1:2::10" });
    await a.hello();
    const b = await TestClient.connect(s, { ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" });
    expect((await b.hello()).peers.peers).toHaveLength(1);
    const c = await TestClient.connect(s, { ip: "2001:db8:1:3::10" });
    expect((await c.hello()).peers.peers).toHaveLength(0);
  });

  it("assigns distinct names within a network", async () => {
    s = await startServer();
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const c = await TestClient.connect(s, { ip: "203.0.113.9" });
      names.add((await c.hello()).welcome.self.name);
    }
    expect(names.size).toBe(20);
  });
});

describe("relay", () => {
  it("relays signals between peers that share a room, stamped with the sender id", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    const { welcome: wa } = await a.hello();
    const b = await TestClient.connect(s);
    const { welcome: wb } = await b.hello();

    a.send({ t: "signal", to: wb.self.id, payload: offer });
    expect(await b.next("signal")).toEqual({ t: "signal", from: wa.self.id, payload: offer });
  });

  it("refuses to relay across networks or to unknown peers", async () => {
    s = await startServer();
    const a = await TestClient.connect(s, { ip: "203.0.113.5" });
    await a.hello();
    const b = await TestClient.connect(s, { ip: "198.51.100.7" });
    const { welcome: wb } = await b.hello();

    a.send({ t: "signal", to: wb.self.id, payload: offer });
    expect(await a.next("error")).toEqual({ t: "error", code: "peer-unavailable", ref: wb.self.id });
    await b.expectNone("signal");

    a.send({ t: "signal", to: "B".repeat(22), payload: offer });
    expect((await a.next("error")).code).toBe("peer-unavailable");
  });

  it("refuses to relay a signal to yourself", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    const { welcome } = await a.hello();
    a.send({ t: "signal", to: welcome.self.id, payload: offer });
    expect((await a.next("error")).code).toBe("peer-unavailable");
  });
});

describe("validation", () => {
  it("requires hello before anything else", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    a.send({ t: "ping" });
    expect((await a.next("error")).code).toBe("hello-required");
    expect((await a.closed).code).toBe(CloseCode.policy);
  });

  it("closes sockets that never say hello", async () => {
    s = await startServer({ limits: { helloTimeoutMs: 100 } });
    const a = await TestClient.connect(s);
    expect((await a.closed).code).toBe(CloseCode.helloTimeout);
  });

  it.each([
    ["not json", "{nope"],
    ["unknown type", JSON.stringify({ t: "admin" })],
    ["extra keys", JSON.stringify({ t: "ping", x: 1 })],
    ["bad peer id", JSON.stringify({ t: "signal", to: "../../etc", payload: { kind: "connect" } })],
    ["oversized sdp", JSON.stringify({ t: "signal", to: "A".repeat(22), payload: { ...offer, description: { type: "offer", sdp: "x".repeat(LIMITS.maxSdpLength + 1) } } })],
    ["prototype pollution", '{"t":"ping","__proto__":{"admin":true}}'],
  ])("rejects %s", async (_name, raw) => {
    s = await startServer();
    const a = await TestClient.connect(s);
    await a.hello();
    a.sendRaw(raw);
    expect((await a.next("error")).code).toBe("bad-message");
    a.send({ t: "ping" });
    await a.next("pong");
  });

  it("rejects a second hello", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    await a.hello();
    a.send({ t: "hello", v: 1, device: { os: "linux", browser: "firefox", form: "desktop" } });
    expect((await a.next("error")).code).toBe("bad-message");
  });

  it("closes the socket on frames above the size limit", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    a.sendRaw("x".repeat(LIMITS.maxFrameBytes + 1));
    expect((await a.closed).code).toBe(CloseCode.tooBig);
  });

  it("closes the socket on binary frames", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    a.sendRaw(Buffer.from([1, 2, 3]));
    expect((await a.closed).code).toBe(CloseCode.policy);
  });
});

describe("origin and admission", () => {
  it("rejects cross-origin and origin-less upgrades", async () => {
    s = await startServer();
    await expect(TestClient.connect(s, { origin: "https://evil.example" })).rejects.toThrow("HTTP 403");
    await expect(TestClient.connect(s, { origin: null })).rejects.toThrow("HTTP 403");
  });

  it("honours an explicit origin allow-list", async () => {
    s = await startServer({ config: { allowedOrigins: ["https://drop.example"] } });
    await expect(TestClient.connect(s)).rejects.toThrow("HTTP 403");
    const ok = await TestClient.connect(s, { origin: "https://drop.example" });
    await ok.hello();
  });

  it("caps concurrent connections per IP", async () => {
    s = await startServer({ limits: { maxConnectionsPerIp: 2 } });
    await TestClient.connect(s, { ip: "203.0.113.1" });
    await TestClient.connect(s, { ip: "203.0.113.1" });
    await expect(TestClient.connect(s, { ip: "203.0.113.1" })).rejects.toThrow("HTTP 429");
    await TestClient.connect(s, { ip: "203.0.113.2" });
  });

  it("rate-limits connection attempts per IP", async () => {
    s = await startServer({ limits: { connectBurst: 3, connectPerSecond: 0.001 } });
    for (let i = 0; i < 3; i++) (await TestClient.connect(s, { ip: "203.0.113.3" })).ws.close();
    await expect(TestClient.connect(s, { ip: "203.0.113.3" })).rejects.toThrow("HTTP 429");
  });

  it("rate-limits messages and eventually disconnects abusers", async () => {
    s = await startServer({ limits: { messageBurst: 5, messagesPerSecond: 0.001, maxViolations: 3 } });
    const a = await TestClient.connect(s);
    await a.hello();
    for (let i = 0; i < 20; i++) a.send({ t: "ping" });
    expect((await a.next("error")).code).toBe("rate-limited");
    expect((await a.closed).code).toBe(CloseCode.rateLimited);
  });
});

describe("flood protection", () => {
  it("caps signals delivered to one victim across many attacker sockets", async () => {
    s = await startServer({ limits: { messageBurst: 5, messagesPerSecond: 0.001, maxViolations: 100 } });
    const victim = await TestClient.connect(s);
    const { welcome } = await victim.hello();
    // Inbound budget is 2x the per-connection burst: 10 signals.
    const attackers = [];
    for (let i = 0; i < 3; i++) {
      const a = await TestClient.connect(s);
      await a.hello();
      attackers.push(a);
    }
    for (const a of attackers) for (let i = 0; i < 4; i++) a.send({ t: "signal", to: welcome.self.id, payload: { kind: "connect" } });
    let delivered = 0;
    try {
      for (;;) {
        await victim.next("signal", () => true, 300);
        delivered++;
      }
    } catch {
      // drained
    }
    expect(delivered).toBe(10);
  });
});

describe("pair rooms", () => {
  it("lets devices on different networks pair with a code", async () => {
    s = await startServer();
    const a = await TestClient.connect(s, { ip: "203.0.113.5" });
    const { welcome: wa } = await a.hello();
    a.send({ t: "room-create" });
    const created = await a.next("peers", (m) => m.room.startsWith("pair:"));
    expect(created.peers).toEqual([]);
    const code = created.room.slice(5);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    const b = await TestClient.connect(s, { ip: "198.51.100.7" });
    const { welcome: wb } = await b.hello();
    b.send({ t: "room-join", code });
    expect((await b.next("peers", (m) => m.room === created.room)).peers).toEqual([wa.self]);
    expect((await a.next("peer-joined")).peer).toEqual(wb.self);

    a.send({ t: "signal", to: wb.self.id, payload: offer });
    expect((await b.next("signal")).from).toBe(wa.self.id);

    b.send({ t: "room-leave" });
    expect(await b.next("room-left")).toEqual({ t: "room-left", room: created.room });
    expect((await a.next("peer-left")).id).toBe(wb.self.id);
    a.send({ t: "signal", to: wb.self.id, payload: offer });
    expect((await a.next("error")).code).toBe("peer-unavailable");
  });

  it("reports unknown codes and rate-limits guessing per IP", async () => {
    s = await startServer({ limits: { joinBurst: 3, joinPerSecond: 0.001, maxViolations: 100 } });
    const a = await TestClient.connect(s, { ip: "203.0.113.5" });
    await a.hello();
    for (let i = 0; i < 3; i++) {
      a.send({ t: "room-join", code: "ZZZZZ" + i });
      expect((await a.next("error")).code).toBe("room-not-found");
    }
    a.send({ t: "room-join", code: "ZZZZZ9" });
    expect((await a.next("error")).code).toBe("rate-limited");
    // The limit is per IP, so a second socket from the same IP is also limited.
    const b = await TestClient.connect(s, { ip: "203.0.113.5" });
    await b.hello();
    b.send({ t: "room-join", code: "ZZZZZ8" });
    expect((await b.next("error")).code).toBe("rate-limited");
  });

  it("enforces the room size limit", async () => {
    s = await startServer({ limits: { maxRoomSize: 2 } });
    const a = await TestClient.connect(s, { ip: "203.0.113.1" });
    await a.hello();
    a.send({ t: "room-create" });
    const code = (await a.next("peers", (m) => m.room !== "net")).room.slice(5);
    const b = await TestClient.connect(s, { ip: "203.0.113.2" });
    await b.hello();
    b.send({ t: "room-join", code });
    await b.next("peers", (m) => m.room !== "net");
    const c = await TestClient.connect(s, { ip: "203.0.113.3" });
    await c.hello();
    c.send({ t: "room-join", code });
    expect((await c.next("error")).code).toBe("room-full");
  });
});

describe("resume", () => {
  it("keeps identity and rooms across a reconnect within the grace period", async () => {
    s = await startServer({ limits: { resumeGraceMs: 2000 } });
    const a = await TestClient.connect(s);
    const { welcome: wa } = await a.hello();
    const b = await TestClient.connect(s);
    const { welcome: wb } = await b.hello();
    await a.next("peer-joined");

    b.ws.terminate();
    await sleep(50);
    const b2 = await TestClient.connect(s);
    const { welcome: wb2 } = await b2.hello(wb.resume);
    expect(wb2.resumed).toBe(true);
    expect(wb2.self).toEqual(wb.self);
    await a.expectNone("peer-left");
    await a.expectNone("peer-joined");
    // Still reachable under the same id.
    a.send({ t: "signal", to: wb2.self.id, payload: offer });
    expect((await b2.next("signal")).from).toBe(wa.self.id);
  });

  it("rotates the resume token so an old token cannot be replayed", async () => {
    s = await startServer({ limits: { resumeGraceMs: 2000 } });
    const a = await TestClient.connect(s);
    const first = await a.hello();
    a.ws.terminate();
    await sleep(50);
    const a2 = await TestClient.connect(s);
    const second = await a2.hello(first.welcome.resume);
    expect(second.welcome.resumed).toBe(true);
    expect(second.welcome.resume).not.toBe(first.welcome.resume);
    a2.ws.terminate();
    await sleep(50);
    const a3 = await TestClient.connect(s);
    const third = await a3.hello(first.welcome.resume);
    expect(third.welcome.resumed).toBe(false);
    expect(third.welcome.self.id).not.toBe(first.welcome.self.id);
  });

  it("gives a duplicated tab its own identity instead of stealing the live one", async () => {
    s = await startServer();
    const a = await TestClient.connect(s);
    const { welcome } = await a.hello();
    const dup = await TestClient.connect(s);
    const { welcome: w2 } = await dup.hello(welcome.resume);
    expect(w2.resumed).toBe(false);
    expect(w2.self.id).not.toBe(welcome.self.id);
    a.send({ t: "ping" });
    await a.next("pong");
  });

  it("announces the departure once the grace period expires", async () => {
    s = await startServer({ limits: { resumeGraceMs: 100 } });
    const a = await TestClient.connect(s);
    await a.hello();
    const b = await TestClient.connect(s);
    const { welcome: wb } = await b.hello();
    b.ws.terminate();
    await a.expectNone("peer-left", 50);
    expect((await a.next("peer-left")).id).toBe(wb.self.id);
  });
});
