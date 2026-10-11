import { describe, expect, it } from "vitest";
import { tuning } from "../src/lib/tuning.ts";
import { network, randomFile, sameBytes, until } from "./fakes.ts";

/** Run `fn` deterministically once `n` data frames have been delivered on the current link. */
function afterFrames(net: ReturnType<typeof network>, n: number, fn: () => void): void {
  let count = 0;
  const arm = () => {
    const link = net.current;
    if (!link?.a.isOpen) return void setTimeout(arm, 1);
    link.data[0].tamper = (d) => {
      if (++count === n) queueMicrotask(fn);
      return d;
    };
  };
  arm();
}

/** Drop the current link after `n` data frames. */
function dropAfterFrames(net: ReturnType<typeof network>, n: number, before?: () => void): void {
  afterFrames(net, n, () => {
    before?.();
    net.current!.drop();
  });
}

describe("transfer", () => {
  it("sends several files, including an empty one, intact and in order", async () => {
    const net = network();
    const files = [randomFile("a.bin", 3 * 1024 * 1024 + 17), randomFile("empty.txt", 0), randomFile("b.bin", 70_000)];
    const [out] = net.alice.send("bob", "Bob", files);
    await until(() => out!.state === "done", 20_000, "sender done");
    const inc = net.bob.incoming.get(out!.id)!;
    await until(() => inc.state === "done");

    expect(net.files.map((f) => f.name)).toEqual(["a.bin", "empty.txt", "b.bin"]);
    for (let i = 0; i < files.length; i++) expect(await sameBytes(net.files[i]!.file, files[i]!)).toBe(true);
    expect(out!.bytes).toBe(out!.total);
    expect(inc.bytes).toBe(inc.total);
    expect(out!.sas).toBe(inc.sas);
    expect(net.files[0]!.file.type).toBe("application/octet-stream");
  });

  it("respects the send-buffer high-water mark", async () => {
    const net = network({ bytesPerTick: 64 * 1024 });
    const [out] = net.alice.send("bob", "Bob", [randomFile("big.bin", 12 * 1024 * 1024)]);
    await until(() => out!.state === "done", 30_000);
    const max = net.links[0]!.data[0].maxBuffered;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(tuning.highWater + 64 * 1024 + 64);
  });

  it("resumes after the connection drops, without resending written data", async () => {
    const net = network({ bytesPerTick: 128 * 1024 });
    const file = randomFile("resume.bin", 8 * 1024 * 1024);
    const [out] = net.alice.send("bob", "Bob", [file]);
    const inc = () => net.bob.incoming.get(out!.id);
    dropAfterFrames(net, 40);

    await until(() => net.links.length === 2, 20_000, "second link");
    const resumedFrom = inc()!.bytes;
    expect(resumedFrom).toBeGreaterThan(0);
    expect(resumedFrom).toBeLessThan(file.size);

    await until(() => out!.state === "done", 30_000, "resumed transfer done");
    expect(net.links.length).toBe(2);
    expect(await sameBytes(net.files[0]!.file, file)).toBe(true);
    // The second link only carried what was missing (plus framing).
    const secondLinkBytes = net.links[1]!.data[0].maxBuffered;
    expect(secondLinkBytes).toBeLessThan(file.size);
  });

  it("waits for a link while the peer is unreachable, then resumes", async () => {
    const net = network({ bytesPerTick: 128 * 1024 });
    const file = randomFile("later.bin", 4 * 1024 * 1024);
    const [out] = net.alice.send("bob", "Bob", [file]);
    dropAfterFrames(net, 20, () => net.setReachable(false));
    await until(() => out!.state === "interrupted");
    await new Promise((r) => setTimeout(r, 100));
    expect(out!.state).toBe("interrupted");
    net.setReachable(true);
    await until(() => out!.state === "done", 30_000);
    expect(await sameBytes(net.files[0]!.file, file)).toBe(true);
  });

  it("lets the receiver decline", async () => {
    const net = network({ autoAccept: false });
    const [out] = net.alice.send("bob", "Bob", [randomFile("no.bin", 1000)]);
    await until(() => net.bob.incoming.size === 1);
    const inc = [...net.bob.incoming.values()][0]!;
    expect(inc.state).toBe("offered");
    expect(inc.peerName).toBe("Alice");
    inc.decline();
    await until(() => out!.state === "declined");
    expect(net.files).toHaveLength(0);
  });

  it("propagates cancellation from either side mid-transfer", async () => {
    const net = network({ bytesPerTick: 64 * 1024 });
    const [out] = net.alice.send("bob", "Bob", [randomFile("x.bin", 8 * 1024 * 1024)]);
    afterFrames(net, 10, () => net.bob.incoming.get(out!.id)!.cancel());
    await until(() => out!.isFinal);
    expect(out!.state).toBe("cancelled");
    expect(net.bob.incoming.get(out!.id)!.state).toBe("cancelled");

    const [out2] = net.alice.send("bob", "Bob", [randomFile("y.bin", 8 * 1024 * 1024)]);
    afterFrames(net, 10, () => out2!.cancel());
    await until(() => net.bob.incoming.get(out2!.id)?.isFinal === true);
    expect(net.bob.incoming.get(out2!.id)!.state).toBe("cancelled");
    expect(net.files).toHaveLength(0);
  });

  it("fails closed when a data frame is tampered with in transit", async () => {
    const net = network();
    const [out] = net.alice.send("bob", "Bob", [randomFile("t.bin", 2 * 1024 * 1024)]);
    await until(() => net.current !== undefined);
    let n = 0;
    net.current!.data[0].tamper = (d) => {
      if (typeof d === "string" || ++n !== 5) return d;
      const x = new Uint8Array(d);
      x[100]! ^= 0xff;
      return x.buffer;
    };
    await until(() => out!.isFinal, 20_000);
    const inc = net.bob.incoming.get(out!.id)!;
    expect(inc.state).toBe("failed");
    expect(inc.error).toContain("integrity");
    expect(out!.state).toBe("failed");
    expect(net.files).toHaveLength(0);
  });

  it("fails closed when a frame is dropped (sequence gap)", async () => {
    const net = network();
    const [out] = net.alice.send("bob", "Bob", [randomFile("g.bin", 2 * 1024 * 1024)]);
    await until(() => net.current !== undefined);
    let n = 0;
    net.current!.data[0].tamper = (d) => (++n === 3 ? null : d);
    await until(() => out!.isFinal, 20_000);
    expect(net.bob.incoming.get(out!.id)!.state).toBe("failed");
  });

  it("splits huge selections into several offers and runs them sequentially", async () => {
    const net = network();
    const files = Array.from({ length: 120 }, (_, i) => randomFile(`f${i}.txt`, 10));
    const outs = net.alice.send("bob", "Bob", files);
    expect(outs).toHaveLength(2);
    await until(() => outs.every((o) => o.state === "done"), 20_000);
    expect(net.files).toHaveLength(120);
  });

  it("frees received files when a finished transfer is dismissed", async () => {
    const net = network();
    const [out] = net.alice.send("bob", "Bob", [randomFile("keep.bin", 100_000)]);
    await until(() => out!.state === "done");
    const inc = net.bob.incoming.get(out!.id)!;
    expect(inc.results[0]).toBeDefined();
    net.bob.remove(out!.id);
    await until(() => inc.results.length === 0);
    expect(net.bob.incoming.has(out!.id)).toBe(false);
    // Active transfers cannot be dismissed.
    const [busy] = net.alice.send("bob", "Bob", [randomFile("busy.bin", 4 * 1024 * 1024)]);
    net.alice.remove(busy!.id);
    expect(net.alice.outgoing.has(busy!.id)).toBe(true);
  });

  it("gives up when the peer leaves", async () => {
    const net = network({ bytesPerTick: 64 * 1024 });
    const [out] = net.alice.send("bob", "Bob", [randomFile("z.bin", 4 * 1024 * 1024)]);
    dropAfterFrames(net, 5, () => net.setReachable(false));
    await until(() => out!.state === "interrupted");
    net.alice.peerGone("bob");
    net.bob.peerGone("alice");
    expect(out!.state).toBe("failed");
    expect(net.bob.incoming.get(out!.id)!.isFinal).toBe(true);
  });
});
