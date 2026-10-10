import { SecureLink, type ChannelLike } from "../src/lib/secure-link.ts";
import { MemorySink } from "../src/lib/sinks.ts";
import { TransferManager } from "../src/lib/transfer-manager.ts";

/**
 * In-memory data channel with ordered async delivery and a simulated send
 * buffer: messages leave the buffer at `bytesPerTick` per macrotask, so
 * `bufferedAmount` and `bufferedamountlow` behave like the real thing.
 */
export class FakeChannel extends EventTarget implements ChannelLike {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  maxBuffered = 0;
  peer!: FakeChannel;
  /** Optional hook to mutate/drop data in flight (return null to drop). */
  tamper: ((data: string | ArrayBuffer) => string | ArrayBuffer | null) | undefined;
  private readonly queue: Array<string | ArrayBuffer> = [];
  private pumping = false;
  private readonly bytesPerTick: number;

  constructor(bytesPerTick = 1 << 20) {
    super();
    this.bytesPerTick = bytesPerTick;
  }

  static pair(bytesPerTick?: number): [FakeChannel, FakeChannel] {
    const a = new FakeChannel(bytesPerTick);
    const b = new FakeChannel(bytesPerTick);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    const copy = typeof data === "string" ? data : data.slice(0);
    this.queue.push(copy);
    this.bufferedAmount += size(copy);
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    if (!this.pumping) {
      this.pumping = true;
      setImmediate(() => this.pump());
    }
  }

  private pump(): void {
    let budget = this.bytesPerTick;
    while (this.queue.length && budget > 0 && this.readyState === "open") {
      const data = this.queue.shift()!;
      const n = size(data);
      budget -= n;
      const before = this.bufferedAmount;
      this.bufferedAmount -= n;
      const delivered = this.tamper ? this.tamper(data) : data;
      if (delivered !== null && this.peer.readyState === "open") {
        this.peer.dispatchEvent(new MessageEvent("message", { data: delivered }));
      }
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event("bufferedamountlow"));
      }
    }
    if (this.queue.length && this.readyState === "open") setImmediate(() => this.pump());
    else this.pumping = false;
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.queue.length = 0;
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}

const size = (d: string | ArrayBuffer) => (typeof d === "string" ? d.length : d.byteLength);

export interface LinkPair {
  a: SecureLink;
  b: SecureLink;
  ctrl: [FakeChannel, FakeChannel];
  data: [FakeChannel, FakeChannel];
  /** Simulate the connection dropping. */
  drop(): void;
}

export function linkPair(opts: { bytesPerTick?: number; maxMessageSize?: number } = {}): LinkPair {
  const ctrl = FakeChannel.pair(opts.bytesPerTick);
  const data = FakeChannel.pair(opts.bytesPerTick);
  const linkOpts = { lowWater: 256 * 1024, maxMessageSize: () => opts.maxMessageSize ?? 64 * 1024 };
  const a = new SecureLink("A", ctrl[0], data[0], linkOpts);
  const b = new SecureLink("B", ctrl[1], data[1], linkOpts);
  for (const ch of [...ctrl, ...data]) ch.open();
  return { a, b, ctrl, data, drop: () => ctrl[0].close() };
}

/** Two TransferManagers ("alice" sends, "bob" receives) joined by fake links. */
export function network(opts: { bytesPerTick?: number; autoAccept?: boolean } = {}) {
  const links: LinkPair[] = [];
  let current: LinkPair | undefined;
  let refuse = false;
  const sinks: MemorySink[] = [];
  const files: Array<{ name: string; file: File }> = [];

  const bob: TransferManager = new TransferManager({
    createSink: async (name) => {
      const s = new MemorySink(name);
      sinks.push(s);
      return s;
    },
    getLink: async () => {
      throw new Error("bob does not send in these tests");
    },
    onOffer: (t) => {
      if (opts.autoAccept !== false) void t.accept();
    },
    onFile: (_t, file) => files.push({ name: file.name, file }),
    onChange: () => {},
    nameOf: () => "Alice",
  });

  const alice: TransferManager = new TransferManager({
    createSink: async (name) => new MemorySink(name),
    getLink: async () => {
      if (refuse) throw new Error("unreachable");
      if (current?.a.isOpen) return current.a;
      current = linkPair({ bytesPerTick: opts.bytesPerTick });
      links.push(current);
      alice.attach("bob", current.a);
      bob.attach("alice", current.b);
      await Promise.all([current.a.ready, current.b.ready]);
      return current.a;
    },
    onOffer: () => {},
    onFile: () => {},
    onChange: () => {},
    nameOf: () => "Bob",
    retryDelaysMs: [20],
  });

  return {
    alice,
    bob,
    links,
    files,
    get current() {
      return current;
    },
    setReachable(ok: boolean) {
      refuse = !ok;
    },
  };
}

export function randomFile(name: string, size: number): File {
  const data = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(size, o + 65536)));
  return new File([data], name, { type: "application/x-test" });
}

export async function sameBytes(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  return Buffer.from(x).equals(Buffer.from(y));
}

export async function until(cond: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
