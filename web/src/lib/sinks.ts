import { tuning } from "./tuning.ts";

/**
 * Where received bytes go. Large transfers stream into the Origin Private
 * File System so multi-GB files never sit in RAM; small ones (or browsers
 * without OPFS writable streams) collect Blob parts in memory.
 */
export interface Sink {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Flush and return the completed file. */
  finish(): Promise<File>;
  abort(): Promise<void>;
}

const MIME = "application/octet-stream";

export class MemorySink implements Sink {
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.parts.push(data);
  }
  async finish(): Promise<File> {
    const file = new File(this.parts, this.name, { type: MIME });
    this.parts = [];
    return file;
  }
  async abort(): Promise<void> {
    this.parts = [];
  }
}

const OPFS_DIR = "incoming";
const OPFS_BATCH = 4 * 1024 * 1024;

export class OpfsSink implements Sink {
  private batch: Uint8Array<ArrayBuffer>[] = [];
  private batched = 0;
  private readonly dir: FileSystemDirectoryHandle;
  private readonly handle: FileSystemFileHandle;
  private readonly writable: FileSystemWritableFileStream;
  private readonly entry: string;
  private readonly name: string;

  private constructor(dir: FileSystemDirectoryHandle, entry: string, handle: FileSystemFileHandle, writable: FileSystemWritableFileStream, name: string) {
    this.dir = dir;
    this.entry = entry;
    this.handle = handle;
    this.writable = writable;
    this.name = name;
  }

  static async create(name: string): Promise<OpfsSink> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    // Timestamped random entry name, never derived from the peer-supplied name.
    const entry = `${Date.now()}-${crypto.randomUUID()}`;
    const handle = await dir.getFileHandle(entry, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    return new OpfsSink(dir, entry, handle, writable, name);
  }

  async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.batch.push(data);
    this.batched += data.byteLength;
    if (this.batched >= OPFS_BATCH) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.batched) return;
    const blob = new Blob(this.batch);
    this.batch = [];
    this.batched = 0;
    await this.writable.write(blob);
  }

  async finish(): Promise<File> {
    await this.flush();
    await this.writable.close();
    const stored = await this.handle.getFile();
    // Re-wrap to carry the sanitized display name and a neutral MIME type.
    return new File([stored], this.name, { type: MIME });
  }

  async abort(): Promise<void> {
    this.batch = [];
    await this.writable.abort().catch(() => {});
    await this.dir.removeEntry(this.entry).catch(() => {});
  }
}

export function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

/**
 * Remove leftovers from earlier page loads. Only entries older than a few
 * hours are touched, so transfers running in other tabs are left alone.
 */
export async function cleanupOpfs(maxAgeMs = 6 * 3600_000): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    for await (const name of dir.keys()) {
      const started = Number(name.split("-", 1)[0]);
      if (!Number.isFinite(started) || Date.now() - started > maxAgeMs) await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // Nothing to clean.
  }
}

/** Use OPFS for large transfers when there is room for them. */
export async function createSink(name: string, transferTotal: number): Promise<Sink> {
  if (transferTotal >= tuning.opfsMinBytes && opfsSupported()) {
    try {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      if (quota - usage > transferTotal * 1.1) return await OpfsSink.create(name);
    } catch {
      // Fall back to memory.
    }
  }
  return new MemorySink(name);
}
