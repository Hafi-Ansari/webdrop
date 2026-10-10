import { describe, expect, it } from "vitest";
import { fromB64u, toB64u, utf8 } from "../src/lib/bytes.ts";
import { commitTo, deriveFileKey, deriveSessionKeys, generateEphemeral, Opener, Sealer, verifyCommitment } from "../src/lib/crypto.ts";
import { FLAG_LAST, openFrame, readHeader, sealFrame } from "../src/lib/framing.ts";
import { sanitizeFileName, sanitizeMime } from "../src/lib/sanitize.ts";
import { FakeChannel, linkPair, until } from "./fakes.ts";

describe("key schedule", () => {
  it("both roles derive matching keys and the same SAS", async () => {
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const ka = await deriveSessionKeys("A", a, a.pub, b.pub);
    const kb = await deriveSessionKeys("B", b, a.pub, b.pub);
    expect(ka.sas).toMatch(/^\d{3} \d{3}$/);
    expect(ka.sas).toBe(kb.sas);

    const ct = await new Sealer(ka.send).seal(utf8("hello"));
    expect(new TextDecoder().decode(await new Opener(kb.recv).open(ct))).toBe("hello");
    // Direction keys differ: A cannot open its own messages with its recv key.
    await expect(new Opener(ka.recv).open(ct)).rejects.toThrow();
  });

  it("a man in the middle ends up with different codes on each side", async () => {
    const a = await generateEphemeral();
    const m1 = await generateEphemeral();
    const m2 = await generateEphemeral();
    const b = await generateEphemeral();
    const aSide = await deriveSessionKeys("A", a, a.pub, m1.pub);
    const bSide = await deriveSessionKeys("B", b, m2.pub, b.pub);
    expect(aSide.sas).not.toBe(bSide.sas);
  });

  it("commitments bind the public key", async () => {
    const a = await generateEphemeral();
    const other = await generateEphemeral();
    const c = await commitTo(a.pub);
    expect(await verifyCommitment(a.pub, c)).toBe(true);
    expect(await verifyCommitment(other.pub, c)).toBe(false);
  });

  it("rejects invalid or reflected public keys", async () => {
    const a = await generateEphemeral();
    const bogus = new Uint8Array(65).fill(4);
    await expect(deriveSessionKeys("A", a, a.pub, bogus)).rejects.toThrow();
    await expect(deriveSessionKeys("A", a, a.pub, a.pub)).rejects.toThrow("reflected");
    await expect(deriveSessionKeys("A", a, a.pub, a.pub.subarray(1))).rejects.toThrow("length");
  });

  it("control messages fail on replay, reordering and tampering", async () => {
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const ka = await deriveSessionKeys("A", a, a.pub, b.pub);
    const kb = await deriveSessionKeys("B", b, a.pub, b.pub);
    const sealer = new Sealer(ka.send);
    const m1 = await sealer.seal(utf8("one"));
    const m2 = await sealer.seal(utf8("two"));

    await expect(new Opener(kb.recv).open(m2)).rejects.toThrow(); // reordered
    const opener = new Opener(kb.recv);
    await opener.open(m1);
    await expect(opener.open(m1)).rejects.toThrow(); // replayed
    const bad = new Uint8Array(m2.slice(0));
    bad[0]! ^= 1;
    await expect(new Opener(kb.recv).open(bad.buffer)).rejects.toThrow(); // tampered
  });
});

describe("data frames", () => {
  const key = async () => {
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const k = await deriveSessionKeys("A", a, a.pub, b.pub);
    return deriveFileKey(k.fileMaster, new Uint8Array(16), new Uint8Array(16).fill(1));
  };

  it("round-trips and authenticates the header", async () => {
    const k = await key();
    const h = { flags: FLAG_LAST, fileIndex: 3, stream: 77, chunkIndex: 9 };
    const frame = await sealFrame(k, h, utf8("payload"));
    expect(readHeader(frame)).toEqual(h);
    expect(new TextDecoder().decode(await openFrame(k, h, frame))).toBe("payload");

    // Flip the "last" flag in the header: AAD mismatch.
    const forged = new Uint8Array(frame.slice(0));
    forged[1] = 0;
    await expect(openFrame(k, readHeader(forged.buffer)!, forged.buffer)).rejects.toThrow();
    // Claim a different chunk index: nonce mismatch.
    await expect(openFrame(k, { ...h, chunkIndex: 10 }, frame)).rejects.toThrow();
    // A different attempt's key cannot open it.
    await expect(openFrame(await key(), h, frame)).rejects.toThrow();
  });

  it("rejects malformed headers", () => {
    expect(readHeader(new ArrayBuffer(10))).toBeNull();
    const f = new Uint8Array(40);
    f[0] = 2;
    expect(readHeader(f.buffer)).toBeNull();
    f[0] = 1;
    f[1] = 0x80;
    expect(readHeader(f.buffer)).toBeNull();
  });

  it("derives distinct keys per salt", async () => {
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const k = await deriveSessionKeys("A", a, a.pub, b.pub);
    const id = new Uint8Array(16);
    const k1 = await deriveFileKey(k.fileMaster, id, new Uint8Array(16).fill(1));
    const k2 = await deriveFileKey(k.fileMaster, id, new Uint8Array(16).fill(2));
    const h = { flags: 0, fileIndex: 0, stream: 1, chunkIndex: 0 };
    const frame = await sealFrame(k1, h, utf8("x"));
    await expect(openFrame(k2, h, frame)).rejects.toThrow();
  });
});

describe("secure link", () => {
  it("handshakes over data channels and agrees on a code", async () => {
    const { a, b } = linkPair();
    const [ka, kb] = await Promise.all([a.ready, b.ready]);
    expect(ka.sas).toBe(kb.sas);
    const got: string[] = [];
    b.onMessage = (m) => got.push(m.t === "done" ? m.id : "?");
    const id = toB64u(new Uint8Array(16).fill(7));
    await a.send({ t: "done", id });
    await a.send({ t: "done", id: toB64u(new Uint8Array(16).fill(8)) });
    await until(() => got.length === 2);
    expect(got[0]).toBe(id);
  });

  it("closes on a tampered control message", async () => {
    const { a, b, ctrl } = linkPair();
    await Promise.all([a.ready, b.ready]);
    ctrl[0].tamper = (d) => {
      if (typeof d === "string") return d;
      const x = new Uint8Array(d);
      x[x.length - 1]! ^= 1;
      return x.buffer;
    };
    void a.send({ t: "done", id: toB64u(new Uint8Array(16)) });
    await until(() => !b.isOpen);
    expect(b.closedReason).toContain("protocol error");
    expect(a.isOpen).toBe(false); // closing a channel closes the pair
  });

  it("fails the handshake when the reveal does not match the commitment", async () => {
    const [ca, cb] = FakeChannel.pair();
    const [da, db] = FakeChannel.pair();
    const { SecureLink } = await import("../src/lib/secure-link.ts");
    const a = new SecureLink("A", ca, da, { lowWater: 0 });
    const b = new SecureLink("B", cb, db, { lowWater: 0 });
    const other = await generateEphemeral();
    ca.tamper = (d) => {
      if (typeof d === "string" && d.includes("hs-reveal")) return JSON.stringify({ t: "hs-reveal", v: 1, pub: toB64u(other.pub) });
      return d;
    };
    for (const ch of [ca, cb, da, db]) ch.open();
    await expect(b.ready).rejects.toThrow();
    expect(b.closedReason).toContain("commitment mismatch");
    void a;
  });

  it("rejects plaintext after the handshake and frames before it", async () => {
    const { a, b, ctrl } = linkPair();
    await Promise.all([a.ready, b.ready]);
    ctrl[0].send(JSON.stringify({ t: "hs-commit", v: 1, commit: "x".repeat(43) }));
    await until(() => !b.isOpen);

    const p = linkPair();
    p.data[0].send(new ArrayBuffer(64)); // before keys exist on B
    await until(() => !p.b.isOpen);
    expect(p.b.closedReason).toContain("unexpected data frame");
  });

  it("times out a stalled handshake", async () => {
    const [ca, cb] = FakeChannel.pair();
    const [da, db] = FakeChannel.pair();
    const { SecureLink } = await import("../src/lib/secure-link.ts");
    const b = new SecureLink("B", cb, db, { lowWater: 0, handshakeTimeoutMs: 50 });
    for (const ch of [ca, cb, da, db]) ch.open();
    await expect(b.ready).rejects.toThrow("handshake timeout");
  });

  it("base64url helpers round-trip and reject junk", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(65));
    expect(fromB64u(toB64u(bytes))).toEqual(bytes);
    expect(() => fromB64u("a+b/")).toThrow();
  });
});

describe("sanitize", () => {
  it.each([
    ["../../etc/passwd", "_.._etc_passwd"],
    ["C:\\Windows\\evil.exe", "C__Windows_evil.exe"],
    ["photo\u202Egpj.exe", "photogpj.exe"],
    ["\u0000\u0007bell.txt", "bell.txt"],
    ["  ...hidden  ", "hidden"],
    ["CON.txt", "_CON.txt"],
    ["", "file"],
    ["....", "file"],
    ["normal name (1).pdf", "normal name (1).pdf"],
    ["e\u0301.txt", "\u00e9.txt"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it("truncates long names but keeps the extension", () => {
    const out = sanitizeFileName("a".repeat(500) + ".tar.gz");
    expect(Array.from(out).length).toBe(200);
    expect(out.endsWith(".gz")).toBe(true);
    // Never splits a surrogate pair.
    const emoji = sanitizeFileName("😀".repeat(300));
    expect(Array.from(emoji).every((c) => c === "😀")).toBe(true);
  });

  it("only passes well-formed MIME types", () => {
    expect(sanitizeMime("image/PNG")).toBe("image/png");
    expect(sanitizeMime("text/html; charset=utf-8")).toBe("");
    expect(sanitizeMime("<script>")).toBe("");
  });
});
