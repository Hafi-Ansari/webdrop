import { fromB64u, randomBytes, toB64u } from "./bytes.ts";
import { deriveFileKey } from "./crypto.ts";
import { FLAG_LAST, HEADER_BYTES, openFrame, sealFrame, TAG_BYTES, type FrameHeader } from "./framing.ts";
import type { FileMeta, SealedMessage } from "./peer-protocol.ts";
import { sanitizeFileName, sanitizeMime } from "./sanitize.ts";
import { LinkClosedError, type SecureLink } from "./secure-link.ts";
import type { Sink } from "./sinks.ts";
import { chunkSizeFor, tuning } from "./tuning.ts";

export type TransferState =
  | "connecting" // outgoing: waiting for a secure link
  | "offered" // outgoing: waiting for the receiver; incoming: waiting for the user
  | "active"
  | "interrupted" // link lost; resumes automatically when the peer is back
  | "done"
  | "declined"
  | "cancelled"
  | "failed";

const FINAL: ReadonlySet<TransferState> = new Set(["done", "declined", "cancelled", "failed"]);

class Cancelled extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Throughput over a sliding window of recent samples. */
class RateMeter {
  private samples: Array<[number, number]> = [];
  push(bytes: number, now = performance.now()): void {
    this.samples.push([now, bytes]);
    while (this.samples.length > 2 && now - (this.samples[0]?.[0] ?? now) > 3000) this.samples.shift();
  }
  get rate(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last[0] - first[0] < 250) return 0;
    return ((last[1] - first[1]) * 1000) / (last[0] - first[0]);
  }
}

abstract class TransferBase {
  abstract readonly direction: "out" | "in";
  readonly id: string;
  readonly idBytes: Uint8Array<ArrayBuffer>;
  readonly files: FileMeta[];
  readonly total: number;
  peerId: string;
  peerName: string;
  state: TransferState;
  error: string | undefined;
  /** Bytes confirmed written at the receiver. */
  bytes = 0;
  readonly createdAt = Date.now();
  startedAt: number | undefined;
  finishedAt: number | undefined;
  link: SecureLink | undefined;
  onChange: () => void = () => {};
  private readonly meter = new RateMeter();

  protected constructor(id: string, files: FileMeta[], peerId: string, peerName: string, state: TransferState) {
    this.id = id;
    this.idBytes = fromB64u(id);
    this.files = files;
    this.total = files.reduce((n, f) => n + f.size, 0);
    this.peerId = peerId;
    this.peerName = peerName;
    this.state = state;
  }

  get isFinal(): boolean {
    return FINAL.has(this.state);
  }

  get rate(): number {
    return this.state === "active" ? this.meter.rate : 0;
  }

  /** Verification code of the link currently carrying this transfer. */
  get sas(): string | undefined {
    return this.link?.sas;
  }

  protected setState(state: TransferState): void {
    if (this.isFinal) return;
    this.state = state;
    if (state === "active") this.startedAt ??= performance.now();
    this.onChange();
  }

  protected progress(bytes: number): void {
    this.bytes = bytes;
    this.meter.push(bytes);
    this.onChange();
  }

  protected finish(state: Extract<TransferState, "done" | "declined" | "cancelled" | "failed">, error?: string): void {
    if (this.isFinal) return;
    this.state = state;
    this.error = error;
    this.finishedAt = performance.now();
    this.onChange();
  }
}

// =============================================================================
// Sending
// =============================================================================

export class Outgoing extends TransferBase {
  readonly direction = "out";
  private readonly sources: File[];
  /** prefix[i] = total size of files before i. */
  private readonly prefix: number[];
  private attempts = 0;
  private reply: Deferred<Extract<SealedMessage, { t: "accept" | "decline" | "cancel" }>> | undefined;
  private done: Deferred<void> | undefined;
  private ackWaiter: Deferred<void> | undefined;
  private ackPos = 0;
  private sentPos = 0;

  constructor(peerId: string, peerName: string, files: File[]) {
    const meta = files.map((f) => ({
      name: Array.from(f.name || "file").slice(0, 255).join(""),
      size: f.size,
      type: f.type.length <= 127 ? f.type : "",
    }));
    super(toB64u(randomBytes(16)), meta, peerId, peerName, "connecting");
    this.sources = files;
    this.prefix = [0];
    let sum = 0;
    for (const f of files) this.prefix.push((sum += f.size));
  }

  /**
   * Offer (or re-offer) and stream over `link`. Returns "interrupted" if the
   * link drops (call again with a new link to resume), otherwise "finished".
   */
  async run(link: SecureLink): Promise<"finished" | "interrupted"> {
    if (this.isFinal) return "finished";
    this.link = link;
    this.reply = deferred();
    this.done = deferred();
    try {
      this.setState("offered");
      await link.send({ t: "offer", id: this.id, files: this.files, resume: this.attempts++ > 0 });
      const reply = await this.reply.promise;
      if (reply.t === "decline") {
        this.finish("declined", reply.reason === "declined" ? undefined : reply.reason);
        return "finished";
      }
      if (reply.t === "cancel") {
        this.finish("cancelled");
        return "finished";
      }
      const keys = link.keys;
      const size = this.files[reply.file]?.size ?? 0;
      if (!keys || reply.file > this.files.length || reply.offset > size || (reply.file === this.files.length && reply.offset !== 0)) {
        throw new Error("invalid accept");
      }
      const key = await deriveFileKey(keys.fileMaster, this.idBytes, fromB64u(reply.salt));
      const chunkSize = chunkSizeFor(link.maxMessageSize);
      this.ackPos = this.sentPos = (this.prefix[reply.file] ?? this.total) + reply.offset;
      this.progress(this.ackPos);
      this.setState("active");

      for (let f = reply.file; f < this.files.length; f++) {
        const offset = f === reply.file ? reply.offset : 0;
        for await (const { frame, len } of this.frames(key, reply.stream, f, offset, chunkSize)) {
          // Two levels of backpressure: the local SCTP send buffer, and the
          // receiver's unwritten bytes (bounded by `window`).
          while (link.dataBuffered > tuning.highWater) await link.drain();
          while (this.sentPos - this.ackPos > tuning.window) {
            this.ackWaiter = deferred();
            await this.ackWaiter.promise;
          }
          if (this.isFinal) throw new Cancelled();
          link.sendFrame(frame);
          this.sentPos += len;
        }
      }
      await this.done.promise;
      this.progress(this.total);
      this.finish("done");
      return "finished";
    } catch (err) {
      if (this.isFinal || err instanceof Cancelled) return "finished";
      if (err instanceof LinkClosedError || !link.isOpen) {
        this.setState("interrupted");
        return "interrupted";
      }
      this.finish("failed", err instanceof Error ? err.message : String(err));
      link.send({ t: "cancel", id: this.id, reason: "error" }).catch(() => {});
      return "finished";
    }
  }

  /**
   * Read ahead in large blocks and encrypt every chunk of a block in
   * parallel; frames are yielded in order.
   */
  private async *frames(key: CryptoKey, stream: number, fileIndex: number, offset: number, chunkSize: number) {
    const file = this.sources[fileIndex];
    if (!file) throw new Error("no such file");
    const size = file.size;
    const header = (chunkIndex: number, last: boolean): FrameHeader => ({ flags: last ? FLAG_LAST : 0, fileIndex, stream, chunkIndex });
    if (offset >= size) {
      // Empty file (or resumed exactly at its end): one empty "last" frame.
      yield { len: 0, frame: await sealFrame(key, header(0, true), new Uint8Array(0)) };
      return;
    }
    const blockSize = Math.max(chunkSize, Math.floor(tuning.readBlock / chunkSize) * chunkSize);
    const read = (start: number): Promise<{ start: number; buf: Uint8Array<ArrayBuffer> }> => {
      const end = Math.min(size, start + blockSize);
      return file
        .slice(start, end)
        .arrayBuffer()
        .then((buf) => ({ start, buf: new Uint8Array(buf) }));
    };
    type Block = { start: number; buf: Uint8Array<ArrayBuffer> };
    let chunkIndex = 0;
    let next: Promise<Block> | null = read(offset);
    while (next) {
      const block: Block = await next;
      const { start, buf } = block;
      const end: number = start + buf.byteLength;
      if (buf.byteLength === 0) throw new Error("file changed while sending");
      next = end < size ? read(end) : null;
      next?.catch(() => {});
      const pending: Array<{ len: number; frame: Promise<ArrayBuffer> }> = [];
      for (let o = 0; o < buf.byteLength; o += chunkSize) {
        const pt = buf.subarray(o, Math.min(buf.byteLength, o + chunkSize));
        const last = start + o + pt.byteLength === size;
        const frame = sealFrame(key, header(chunkIndex++, last), pt);
        frame.catch(() => {});
        pending.push({ len: pt.byteLength, frame });
      }
      for (const p of pending) yield { len: p.len, frame: await p.frame };
    }
  }

  /** Route a sealed message for this transfer. */
  handle(msg: SealedMessage): void {
    switch (msg.t) {
      case "accept":
      case "decline":
        this.reply?.resolve(msg);
        break;
      case "cancel":
        if (this.state === "offered") this.reply?.resolve(msg);
        else if (msg.reason === "cancelled") this.abort("cancelled");
        else this.abort("failed", msg.reason === "integrity" ? "receiver rejected corrupted data" : "receiver error");
        break;
      case "ack": {
        const size = this.files[msg.file]?.size;
        if (size === undefined || msg.bytes > size) return;
        const pos = (this.prefix[msg.file] ?? 0) + msg.bytes;
        if (pos > this.ackPos && pos <= this.sentPos) {
          this.ackPos = pos;
          this.progress(pos);
          this.ackWaiter?.resolve();
        }
        break;
      }
      case "done":
        this.done?.resolve();
        break;
    }
  }

  /** The link carrying this transfer closed. */
  interrupt(reason: string): void {
    if (this.isFinal) return;
    const err = new LinkClosedError(reason);
    this.reply?.reject(err);
    this.done?.reject(err);
    this.ackWaiter?.reject(err);
    this.setState("interrupted");
  }

  /** Sender gives up while still waiting for a link (peer gone). */
  giveUp(reason: string): void {
    this.abort("failed", reason);
  }

  cancel(): void {
    if (this.isFinal) return;
    this.link?.send({ t: "cancel", id: this.id, reason: "cancelled" }).catch(() => {});
    this.abort("cancelled");
  }

  private abort(state: "cancelled" | "failed", error?: string): void {
    if (this.isFinal) return;
    this.finish(state, error);
    const err = new Cancelled();
    this.reply?.reject(err);
    this.done?.reject(err);
    this.ackWaiter?.reject(err);
  }
}

// =============================================================================
// Receiving
// =============================================================================

export type SinkFactory = (name: string, transferTotal: number) => Promise<Sink>;

export class Incoming extends TransferBase {
  readonly direction = "in";
  /** Files saved so far, by index. */
  readonly results: Array<File | undefined> = [];
  onFile: (file: File, index: number) => void = () => {};

  private readonly offered: FileMeta[];
  private readonly createSink: SinkFactory;
  private readonly sinks: Array<Sink | undefined> = [];
  private key: CryptoKey | undefined;
  private stream = 0;
  private chain: Promise<void> = Promise.resolve();
  // Write side (after decryption, in order).
  private fileIndex = 0;
  private written = 0;
  private lastAck = 0;
  // Arrival side (validated synchronously as frames arrive).
  private aFile = 0;
  private aChunk = 0;
  private aBytes = 0;

  constructor(peerId: string, peerName: string, offer: Extract<SealedMessage, { t: "offer" }>, link: SecureLink, createSink: SinkFactory) {
    const files = offer.files.map((f) => ({ name: sanitizeFileName(f.name), size: f.size, type: sanitizeMime(f.type) }));
    super(offer.id, files, peerId, peerName, "offered");
    this.offered = offer.files;
    this.link = link;
    this.createSink = createSink;
  }

  /** A re-offer must describe exactly the same files to be resumed. */
  matches(offer: Extract<SealedMessage, { t: "offer" }>): boolean {
    return (
      offer.files.length === this.offered.length &&
      offer.files.every((f, i) => {
        const o = this.offered[i];
        return o !== undefined && f.name === o.name && f.size === o.size && f.type === o.type;
      })
    );
  }

  /** Re-attach to a new link after an interruption (sender re-offered). */
  relink(link: SecureLink): void {
    this.link = link;
  }

  /** Accept (first time, by the user) or resume (automatically) over the current link. */
  async accept(): Promise<void> {
    const link = this.link;
    if (!link || this.state === "declined" || this.state === "cancelled" || this.state === "failed") return;
    // Let writes from a previous attempt land so the resume offset is exact.
    await this.chain;
    const keys = link.keys;
    if (!keys || !link.isOpen) return this.setState("interrupted");
    const salt = randomBytes(16);
    this.stream = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.key = await deriveFileKey(keys.fileMaster, this.idBytes, salt);
    this.aFile = this.fileIndex;
    this.aChunk = 0;
    this.aBytes = this.written;
    if (this.state !== "done") this.setState("active");
    try {
      await link.send({ t: "accept", id: this.id, salt: toB64u(salt), stream: this.stream, file: this.fileIndex, offset: this.written });
      if (this.fileIndex >= this.files.length) await link.send({ t: "done", id: this.id });
    } catch {
      this.interrupt();
    }
  }

  decline(): void {
    if (this.state !== "offered") return;
    this.link?.send({ t: "decline", id: this.id, reason: "declined" }).catch(() => {});
    this.finish("declined");
  }

  cancel(): void {
    if (this.isFinal) return;
    this.link?.send({ t: "cancel", id: this.id, reason: "cancelled" }).catch(() => {});
    this.stop("cancelled");
  }

  /** Sender cancelled. */
  cancelledByPeer(reason: string): void {
    this.stop(reason === "cancelled" ? "cancelled" : "failed", reason === "cancelled" ? undefined : `sender: ${reason}`);
  }

  interrupt(): void {
    if (this.state === "active") this.setState("interrupted");
  }

  /** Data frame for this transfer (caller has matched link and stream). */
  onFrame(link: SecureLink, h: FrameHeader, frame: ArrayBuffer): void {
    const key = this.key;
    if (link !== this.link || this.state !== "active" || h.stream !== this.stream || !key) return;
    const len = frame.byteLength - HEADER_BYTES - TAG_BYTES;
    const file = this.files[this.aFile];
    const last = (h.flags & FLAG_LAST) !== 0;
    const valid =
      file !== undefined &&
      h.fileIndex === this.aFile &&
      h.chunkIndex === this.aChunk &&
      len <= tuning.maxChunk &&
      (last ? this.aBytes + len === file.size : len > 0 && this.aBytes + len < file.size);
    if (!valid) return this.integrityFailure();

    const index = this.aFile;
    this.aChunk++;
    this.aBytes += len;
    if (last) {
      this.aFile++;
      this.aChunk = 0;
      this.aBytes = 0;
    }
    // Decrypt now (in parallel with earlier frames), write in order.
    const plaintext = openFrame(key, h, frame);
    plaintext.catch(() => {});
    this.chain = this.chain
      .then(() => this.write(link, index, plaintext, last))
      .catch((err: unknown) => {
        if (this.isFinal) return;
        this.link?.send({ t: "cancel", id: this.id, reason: "error" }).catch(() => {});
        this.stop("failed", err instanceof Error ? err.message : String(err));
      });
  }

  private async write(link: SecureLink, index: number, plaintext: Promise<Uint8Array<ArrayBuffer>>, last: boolean): Promise<void> {
    if (this.isFinal) return;
    let data: Uint8Array<ArrayBuffer>;
    try {
      data = await plaintext;
    } catch {
      return this.integrityFailure();
    }
    const meta = this.files[index];
    if (!meta) throw new Error("no such file");
    let sink = this.sinks[index];
    if (!sink) {
      sink = await this.createSink(meta.name, this.total);
      this.sinks[index] = sink;
    }
    await sink.write(data);
    this.written += data.byteLength;
    this.progress(this.bytes + data.byteLength);

    if (last) {
      const file = await sink.finish();
      this.sinks[index] = undefined;
      this.results[index] = file;
      this.fileIndex = index + 1;
      this.written = 0;
      this.lastAck = 0;
      link.send({ t: "ack", id: this.id, file: index, bytes: meta.size }).catch(() => {});
      this.onFile(file, index);
      if (this.fileIndex === this.files.length) {
        link.send({ t: "done", id: this.id }).catch(() => {});
        this.finish("done");
      }
    } else if (this.written - this.lastAck >= tuning.ackEvery) {
      this.lastAck = this.written;
      link.send({ t: "ack", id: this.id, file: index, bytes: this.written }).catch(() => {});
    }
  }

  private integrityFailure(): void {
    if (this.isFinal) return;
    this.link?.send({ t: "cancel", id: this.id, reason: "integrity" }).catch(() => {});
    this.stop("failed", "integrity check failed");
  }

  private stop(state: "cancelled" | "failed", error?: string): void {
    if (this.isFinal) return;
    this.finish(state, error);
    for (const sink of this.sinks) void sink?.abort();
    this.sinks.length = 0;
  }

  /** True if this transfer owns frames tagged `stream` on `link`. */
  owns(link: SecureLink, stream: number): boolean {
    return this.link === link && this.stream === stream && this.state === "active";
  }
}
