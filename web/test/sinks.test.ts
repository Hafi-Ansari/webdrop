import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fake Origin Private File System with a fixed quota, enough to exercise
 * the sink selection and eviction policy in Node.
 */
class FakeFileHandle {
  data: Uint8Array[] = [];
  readonly fs: FakeFs;
  constructor(fs: FakeFs) {
    this.fs = fs;
  }
  async createWritable() {
    const pending: Uint8Array[] = [];
    return {
      write: async (chunk: Uint8Array) => {
        if (this.fs.usage() + chunk.byteLength > this.fs.quota) {
          throw Object.assign(new Error("would exceed its storage quota"), { name: "QuotaExceededError" });
        }
        pending.push(chunk);
        this.fs.inflight += chunk.byteLength;
      },
      close: async () => {
        this.data = pending.splice(0);
        this.fs.inflight -= this.data.reduce((n, c) => n + c.byteLength, 0);
      },
      abort: async () => {
        this.fs.inflight -= pending.splice(0).reduce((n, c) => n + c.byteLength, 0);
      },
    };
  }
  async getFile() {
    return new File(this.data as BlobPart[], "stored");
  }
}

class FakeFs {
  files = new Map<string, FakeFileHandle>();
  inflight = 0;
  readonly quota: number;
  constructor(quota: number) {
    this.quota = quota;
  }
  usage() {
    let n = this.inflight;
    for (const f of this.files.values()) n += f.data.reduce((m, c) => m + c.byteLength, 0);
    return n;
  }
  dir = {
    getDirectoryHandle: async () => this.dir,
    getFileHandle: async (name: string) => {
      const h = new FakeFileHandle(this);
      this.files.set(name, h);
      return h;
    },
    removeEntry: async (name: string) => {
      this.files.delete(name);
    },
  };
}

const MiB = 1024 * 1024;
let fs: FakeFs;

beforeEach(() => {
  // Fresh module state (the eviction registry) for every test.
  vi.resetModules();
  fs = new FakeFs(300 * MiB);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => fs.dir, estimate: async () => ({ quota: fs.quota, usage: fs.usage() }) } },
  });
  (globalThis as Record<string, unknown>).FileSystemFileHandle = FakeFileHandle;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).FileSystemFileHandle;
});

async function receive(createSink: typeof import("../src/lib/sinks.ts").createSink, size: number) {
  const sink = await createSink("f.bin", size, size);
  for (let o = 0; o < size; o += 4 * MiB) await sink.write(new Uint8Array(Math.min(4 * MiB, size - o)));
  await sink.finish();
  return sink;
}

describe("receive sinks", () => {
  it("streams large transfers to OPFS and small ones to memory", async () => {
    const { createSink, MemorySink, OpfsSink } = await import("../src/lib/sinks.ts");
    expect(await createSink("a", 1000, 1000)).toBeInstanceOf(MemorySink);
    const big = await createSink("b", 64 * MiB, 64 * MiB);
    expect(big).toBeInstanceOf(OpfsSink);
    await big.abort();
    expect(fs.files.size).toBe(0);
  });

  it("evicts the oldest saved files to make room, and marks them unavailable", async () => {
    const { createSink, OpfsSink } = await import("../src/lib/sinks.ts");
    const first = await receive(createSink, 120 * MiB);
    const second = await receive(createSink, 120 * MiB);
    expect(first.available && second.available).toBe(true);
    // 240 MiB used of 300: a third 120 MiB file needs the oldest one evicted.
    const third = await receive(createSink, 120 * MiB);
    expect(third).toBeInstanceOf(OpfsSink);
    expect(first.available).toBe(false);
    expect(second.available).toBe(true);
    expect(fs.usage()).toBeLessThanOrEqual(fs.quota);
  });

  it("falls back to memory for moderate files, and refuses huge ones, when nothing can be evicted", async () => {
    const { createSink, MemorySink, StorageError } = await import("../src/lib/sinks.ts");
    fs = new FakeFs(50 * MiB);
    expect(await createSink("m", 100 * MiB, 100 * MiB)).toBeInstanceOf(MemorySink);
    await expect(createSink("h", 2048 * MiB, 2048 * MiB)).rejects.toBeInstanceOf(StorageError);
  });

  it("counts space promised to files still being written", async () => {
    const { createSink, OpfsSink, MemorySink } = await import("../src/lib/sinks.ts");
    const a = await createSink("a", 200 * MiB, 200 * MiB);
    expect(a).toBeInstanceOf(OpfsSink);
    // Nothing written yet, but 200 MiB is spoken for: a second 200 MiB file cannot use OPFS.
    expect(await createSink("b", 200 * MiB, 200 * MiB)).toBeInstanceOf(MemorySink);
    await a.abort();
  });
});
