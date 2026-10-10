import { fromB64u, toB64u, utf8 } from "./bytes.ts";
import {
  commitTo,
  deriveSessionKeys,
  generateEphemeral,
  Opener,
  Sealer,
  verifyCommitment,
  type Ephemeral,
  type Role,
  type SessionKeys,
} from "./crypto.ts";
import { HandshakeMessage, SealedMessage } from "./peer-protocol.ts";

/** The subset of RTCDataChannel we rely on (lets tests substitute fakes). */
export interface ChannelLike extends EventTarget {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export class LinkClosedError extends Error {
  constructor(reason: string) {
    super(`link closed: ${reason}`);
    this.name = "LinkClosedError";
  }
}

const MAX_SEALED_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * An authenticated, encrypted link to one peer over two data channels:
 * `ctrl` carries the handshake and then sealed JSON messages, `data` carries
 * file frames (already encrypted by the transfer layer with per-transfer keys).
 */
export class SecureLink {
  readonly role: Role;
  readonly ready: Promise<SessionKeys>;
  /** Set once the handshake completes. */
  keys: SessionKeys | undefined;
  closedReason: string | undefined;

  onMessage: (msg: SealedMessage) => void = () => {};
  onFrame: (frame: ArrayBuffer) => void = () => {};
  onClose: (reason: string) => void = () => {};

  private readonly ctrl: ChannelLike;
  private readonly data: ChannelLike;
  private eph: Ephemeral | undefined;
  private peerCommit: Uint8Array | undefined;
  private sealer: Sealer | undefined;
  private opener: Opener | undefined;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private drainWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private resolveReady!: (k: SessionKeys) => void;
  private rejectReady!: (e: Error) => void;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;
  private readonly getMaxMessageSize: () => number | null | undefined;

  constructor(
    role: Role,
    ctrl: ChannelLike,
    data: ChannelLike,
    opts: { lowWater: number; handshakeTimeoutMs?: number; maxMessageSize?: () => number | null | undefined },
  ) {
    this.role = role;
    this.getMaxMessageSize = opts.maxMessageSize ?? (() => undefined);
    this.ctrl = ctrl;
    this.data = data;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    ctrl.binaryType = "arraybuffer";
    data.binaryType = "arraybuffer";
    data.bufferedAmountLowThreshold = opts.lowWater;

    ctrl.addEventListener("message", (e) => this.onCtrl((e as MessageEvent).data));
    data.addEventListener("message", (e) => this.onData((e as MessageEvent).data));
    data.addEventListener("bufferedamountlow", () => this.flushDrainWaiters());
    for (const ch of [ctrl, data]) {
      ch.addEventListener("close", () => this.close("channel closed"));
      ch.addEventListener("error", () => this.close("channel error"));
    }
    this.handshakeTimer = setTimeout(() => {
      if (!this.keys) this.close("handshake timeout");
    }, opts.handshakeTimeoutMs ?? 15_000);

    const start = () => void this.start().catch((err: unknown) => this.close(`handshake failed: ${String(err)}`));
    // Both channels must be open before we use them.
    const whenOpen = (ch: ChannelLike) =>
      ch.readyState === "open" ? Promise.resolve() : new Promise<void>((r) => ch.addEventListener("open", () => r(), { once: true }));
    void Promise.all([whenOpen(ctrl), whenOpen(data)]).then(start);
  }

  get sas(): string | undefined {
    return this.keys?.sas;
  }

  get isOpen(): boolean {
    return this.closedReason === undefined;
  }

  /** Largest message the remote SCTP endpoint accepts, if known. */
  get maxMessageSize(): number | null | undefined {
    return this.getMaxMessageSize();
  }

  get dataBuffered(): number {
    return this.data.bufferedAmount;
  }

  // ---------------------------------------------------------------------------
  // Handshake
  // ---------------------------------------------------------------------------

  private sendHs(msg: HandshakeMessage): void {
    this.ctrl.send(JSON.stringify(msg));
  }

  private async start(): Promise<void> {
    if (this.role !== "A" || this.closedReason) return;
    this.eph = await generateEphemeral();
    this.sendHs({ t: "hs-commit", v: 1, commit: toB64u(await commitTo(this.eph.pub)) });
  }

  private async handshake(raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > 1024) throw new Error("unexpected handshake frame");
    const msg = HandshakeMessage.parse(JSON.parse(raw));
    let keys: SessionKeys | undefined;
    if (this.role === "A") {
      if (msg.t !== "hs-key" || !this.eph) throw new Error(`unexpected ${msg.t}`);
      const pubB = fromB64u(msg.pub);
      this.sendHs({ t: "hs-reveal", v: 1, pub: toB64u(this.eph.pub) });
      keys = await deriveSessionKeys("A", this.eph, this.eph.pub, pubB);
    } else if (!this.peerCommit) {
      if (msg.t !== "hs-commit") throw new Error(`unexpected ${msg.t}`);
      this.peerCommit = fromB64u(msg.commit);
      this.eph = await generateEphemeral();
      this.sendHs({ t: "hs-key", v: 1, pub: toB64u(this.eph.pub) });
    } else {
      if (msg.t !== "hs-reveal" || !this.eph) throw new Error(`unexpected ${msg.t}`);
      const pubA = fromB64u(msg.pub);
      if (!(await verifyCommitment(pubA, this.peerCommit))) throw new Error("commitment mismatch");
      keys = await deriveSessionKeys("B", this.eph, pubA, this.eph.pub);
    }
    if (keys && !this.closedReason) {
      clearTimeout(this.handshakeTimer);
      this.keys = keys;
      this.sealer = new Sealer(keys.send);
      this.opener = new Opener(keys.recv);
      this.eph = undefined;
      this.resolveReady(keys);
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  private onCtrl(raw: unknown): void {
    this.recvChain = this.recvChain
      .then(async () => {
        if (this.closedReason) return;
        if (!this.keys) return this.handshake(raw);
        if (!(raw instanceof ArrayBuffer) || raw.byteLength > MAX_SEALED_BYTES) throw new Error("unexpected ctrl frame");
        const opener = this.opener as Opener;
        const plaintext = await opener.open(raw);
        const msg = SealedMessage.parse(JSON.parse(decoder.decode(plaintext)));
        this.onMessage(msg);
      })
      .catch((err: unknown) => this.close(`protocol error: ${String(err)}`));
  }

  private onData(raw: unknown): void {
    if (this.closedReason) return;
    if (!this.keys || !(raw instanceof ArrayBuffer)) return this.close("unexpected data frame");
    this.onFrame(raw);
  }

  /** Seal and send a control message. Messages go out in call order. */
  send(msg: SealedMessage): Promise<void> {
    const p = this.sendChain.then(async () => {
      if (this.closedReason) throw new LinkClosedError(this.closedReason);
      const sealer = this.sealer;
      if (!sealer) throw new Error("link not ready");
      const ct = await sealer.seal(utf8(JSON.stringify(msg)));
      if (this.closedReason) throw new LinkClosedError(this.closedReason);
      this.ctrl.send(ct);
    });
    this.sendChain = p.catch(() => {});
    return p;
  }

  sendFrame(frame: ArrayBuffer): void {
    if (this.closedReason) throw new LinkClosedError(this.closedReason);
    this.data.send(frame);
  }

  /** Resolves once the data channel's buffer drops below the low-water mark. */
  drain(): Promise<void> {
    if (this.closedReason) return Promise.reject(new LinkClosedError(this.closedReason));
    if (this.data.bufferedAmount <= this.data.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((resolve, reject) => this.drainWaiters.push({ resolve, reject }));
  }

  private flushDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w.resolve();
  }

  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    clearTimeout(this.handshakeTimer);
    const err = new LinkClosedError(reason);
    this.rejectReady(err);
    for (const w of this.drainWaiters) w.reject(err);
    this.drainWaiters = [];
    for (const ch of [this.ctrl, this.data]) {
      try {
        ch.close();
      } catch {
        // already closed
      }
    }
    this.onClose(reason);
  }
}
