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
  /** Free any storage backing the finished file (dismissed, or evicted for space). */
  release(): Promise<void>;
  /** False once the finished file's storage was released (it can no longer be saved again). */
  readonly available: boolean;
}

/** Raised when a file cannot be stored on this device. */
export class StorageError extends Error {
  constructor() {
    super("not enough storage space on this device");
    this.name = "StorageError";
  }
}

const MIME = "application/octet-stream";

export class MemorySink implements Sink {
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private readonly name: string;
  readonly available = true;
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
  async release(): Promise<void> {
    // Memory is reclaimed once the File is no longer referenced.
  }
}

const OPFS_DIR = "incoming";
const OPFS_BATCH = 4 * 1024 * 1024;

/** Finished OPFS files, oldest first. Evicted (oldest first) when a new file needs room. */
const completed: OpfsSink[] = [];
/** OPFS files still being written. */
const writing = new Set<OpfsSink>();

export class OpfsSink implements Sink {
  private batch: Uint8Array<ArrayBuffer>[] = [];
  private batched = 0;
  private flushed = 0;
  private released = false;
  /** Called when storage is released, so holders can drop their File snapshot. */
  onRelease: () => void = () => {};
  private readonly dir: FileSystemDirectoryHandle;
  private readonly handle: FileSystemFileHandle;
  private readonly writable: FileSystemWritableFileStream;
  private readonly entry: string;
  private readonly name: string;
  private readonly expected: number;

  private constructor(
    dir: FileSystemDirectoryHandle,
    entry: string,
    handle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    name: string,
    expected: number,
  ) {
    this.dir = dir;
    this.entry = entry;
    this.handle = handle;
    this.writable = writable;
    this.name = name;
    this.expected = expected;
  }

  static async create(name: string, expected: number): Promise<OpfsSink> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    // Timestamped random entry name, never derived from the peer-supplied name.
    const entry = `${Date.now()}-${crypto.randomUUID()}`;
    const handle = await dir.getFileHandle(entry, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    const sink = new OpfsSink(dir, entry, handle, writable, name, expected);
    writing.add(sink);
    return sink;
  }

  /** Bytes this file will still add to storage usage. */
  get outstanding(): number {
    return Math.max(0, this.expected - this.flushed);
  }

  get available(): boolean {
    return !this.released;
  }

  async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.batch.push(data);
    this.batched += data.byteLength;
    if (this.batched >= OPFS_BATCH) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.batched) return;
    // One contiguous buffer, not a Blob: Blobs go through the browser's blob
    // store, which has a hard memory quota in private windows.
    const buf = new Uint8Array(this.batched);
    let o = 0;
    for (const part of this.batch) {
      buf.set(part, o);
      o += part.byteLength;
    }
    this.batch = [];
    this.batched = 0;
    await this.writable.write(buf);
    this.flushed += buf.byteLength;
  }

  async finish(): Promise<File> {
    await this.flush();
    await this.writable.close();
    writing.delete(this);
    completed.push(this);
    const stored = await this.handle.getFile();
    // Re-wrap to carry the sanitized display name and a neutral MIME type.
    return new File([stored], this.name, { type: MIME });
  }

  async abort(): Promise<void> {
    this.batch = [];
    writing.delete(this);
    await this.writable.abort().catch(() => {});
    await this.release();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const i = completed.indexOf(this);
    if (i >= 0) completed.splice(i, 1);
    this.onRelease();
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

/** Largest single file we will hold in memory when OPFS has no room. */
const MEMORY_FALLBACK_MAX = 256 * 1024 * 1024;

async function freeSpace(): Promise<number> {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  let promised = 0;
  for (const s of writing) promised += s.outstanding;
  return quota - usage - promised;
}

/**
 * Pick where a received file goes. Large transfers stream into OPFS when it
 * has room; to make room, the oldest already-saved files are evicted first
 * (they are in the user's Downloads by then). Small files, and browsers
 * without OPFS, use memory.
 */
export async function createSink(name: string, fileSize: number, transferTotal: number): Promise<Sink> {
  if (transferTotal < tuning.opfsMinBytes || !opfsSupported()) return new MemorySink(name);
  // Headroom for the browser's swap file and metadata.
  const need = fileSize * 1.1 + 16 * 1024 * 1024;
  try {
    for (;;) {
      if ((await freeSpace()) >= need) return await OpfsSink.create(name, fileSize);
      const oldest = completed[0];
      if (!oldest) break;
      await oldest.release();
    }
  } catch {
    // OPFS unusable (e.g. blocked storage); fall through.
  }
  if (fileSize <= MEMORY_FALLBACK_MAX) return new MemorySink(name);
  throw new StorageError();
}
