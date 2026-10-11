import { describe, expect, it } from "vitest";
import { fromB64u, randomBytes, toB64u } from "../src/lib/bytes.ts";
import { deriveFileKey } from "../src/lib/crypto.ts";
import { sealFrame } from "../src/lib/framing.ts";
import type { SealedMessage } from "../src/lib/peer-protocol.ts";
import type { Sink } from "../src/lib/sinks.ts";
import { TransferManager } from "../src/lib/transfer-manager.ts";
import { tuning } from "../src/lib/tuning.ts";
import { linkPair, until } from "./fakes.ts";

/** A receiver ("bob") whose disk never finishes a write, facing a hand-driven sender. */
async function setup(opts: { autoAccept?: boolean; maxPendingPerPeer?: number } = {}) {
  const stuck: Sink = { write: () => new Promise(() => {}), finish: async () => new File([], "x"), abort: async () => {} };
  const bob = new TransferManager({
    createSink: async () => stuck,
    getLink: () => Promise.reject(new Error("n/a")),
    onOffer: (t) => {
      if (opts.autoAccept !== false) void t.accept();
    },
    onFile: () => {},
    onChange: () => {},
    nameOf: () => "Mallory",
    maxPendingPerPeer: opts.maxPendingPerPeer ?? 3,
  });
  const pair = linkPair({ bytesPerTick: 1 << 24 });
  bob.attach("mallory", pair.b);
  await Promise.all([pair.a.ready, pair.b.ready]);
  const inbox: SealedMessage[] = [];
  pair.a.onMessage = (m) => inbox.push(m);
  return { bob, mallory: pair.a, inbox };
}

const offer = (size = 100 * 1024 * 1024): Extract<SealedMessage, { t: "offer" }> => ({
  t: "offer",
  id: toB64u(randomBytes(16)),
  files: [{ name: "x.bin", size, type: "" }],
  resume: false,
});

describe("malicious sender", () => {
  it("cannot exhaust receiver memory by ignoring the ack window", async () => {
    const saved = tuning.window;
    tuning.window = 256 * 1024;
    try {
      const { bob, mallory, inbox } = await setup();
      const o = offer();
      await mallory.send(o);
      await until(() => inbox.some((m) => m.t === "accept"));
      const accept = inbox.find((m) => m.t === "accept") as Extract<SealedMessage, { t: "accept" }>;
      const key = await deriveFileKey(mallory.keys!.fileMaster, fromB64u(o.id), fromB64u(accept.salt));
      for (let i = 0; i < 40; i++) {
        mallory.sendFrame(await sealFrame(key, { flags: 0, fileIndex: 0, stream: accept.stream, chunkIndex: i }, new Uint8Array(64 * 1024)));
      }
      await until(() => inbox.some((m) => m.t === "cancel" && m.reason === "integrity"));
      const t = bob.incoming.get(o.id)!;
      expect(t.state).toBe("failed");
      expect(t.error).toContain("flow control");
    } finally {
      tuning.window = saved;
    }
  });

  it("cannot flood the user with prompts", async () => {
    const { bob, mallory, inbox } = await setup({ autoAccept: false, maxPendingPerPeer: 3 });
    for (let i = 0; i < 6; i++) await mallory.send(offer(10));
    await until(() => inbox.filter((m) => m.t === "decline").length === 3);
    expect([...bob.incoming.values()].filter((t) => t.state === "offered")).toHaveLength(3);
    expect(inbox.every((m) => m.t === "decline" && m.reason === "busy")).toBe(true);
  });

  it("cannot send data before the receiver accepts", async () => {
    const { bob, mallory } = await setup({ autoAccept: false });
    const o = offer(1000);
    await mallory.send(o);
    await until(() => bob.incoming.has(o.id));
    // Guess a stream id and a key: frames for an unaccepted transfer are ignored.
    const fakeKey = await deriveFileKey(mallory.keys!.fileMaster, fromB64u(o.id), randomBytes(16));
    mallory.sendFrame(await sealFrame(fakeKey, { flags: 1, fileIndex: 0, stream: 1, chunkIndex: 0 }, new Uint8Array(1000)));
    await new Promise((r) => setTimeout(r, 50));
    expect(bob.incoming.get(o.id)!.state).toBe("offered");
    expect(bob.incoming.get(o.id)!.bytes).toBe(0);
  });

  it("cannot resume someone else's transfer with different files", async () => {
    const { bob, mallory, inbox } = await setup();
    const o = offer(1000);
    await mallory.send(o);
    await until(() => inbox.some((m) => m.t === "accept"));
    await mallory.send({ ...o, files: [{ name: "evil.exe", size: 1000, type: "" }], resume: true });
    await until(() => inbox.some((m) => m.t === "decline"));
    expect(bob.incoming.get(o.id)!.files[0]!.name).toBe("x.bin");
  });

  it("rejects malformed sealed messages by closing the link", async () => {
    const { mallory } = await setup();
    // A well-sealed message with an unknown type fails schema validation on the receiver.
    await mallory.send({ t: "offer", id: "A".repeat(22), files: [], resume: false } as never);
    await until(() => !mallory.isOpen);
  });
});
