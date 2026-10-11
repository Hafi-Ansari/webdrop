import { readHeader } from "./framing.ts";
import { MAX_FILES_PER_OFFER, type SealedMessage } from "./peer-protocol.ts";
import type { SecureLink } from "./secure-link.ts";
import { Incoming, Outgoing, type SinkFactory } from "./transfer.ts";

export interface TransferManagerOptions {
  createSink: SinkFactory;
  /** Establish (or reuse) a secure link to a peer for sending. */
  getLink: (peerId: string) => Promise<SecureLink>;
  /** A new incoming offer needs a user decision. */
  onOffer: (t: Incoming) => void;
  /** A received file is complete. */
  onFile: (t: Incoming, file: File, index: number) => void;
  onChange: () => void;
  /** Display name for a peer id. */
  nameOf: (peerId: string) => string;
  /** Max undecided offers per peer before further offers are auto-declined. */
  maxPendingPerPeer?: number;
  retryDelaysMs?: number[];
}

/**
 * Owns all transfers. Routes sealed messages and data frames from secure
 * links to the transfer they belong to, runs outgoing transfers one at a
 * time per peer, and retries interrupted ones when a link is available.
 *
 * A message for transfer X is only honoured if it arrives on the link X is
 * currently attached to, so one peer can never act on another's transfers.
 */
export class TransferManager {
  readonly outgoing = new Map<string, Outgoing>();
  readonly incoming = new Map<string, Incoming>();
  private readonly opts: Required<TransferManagerOptions>;
  private readonly running = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();

  constructor(opts: TransferManagerOptions) {
    this.opts = { maxPendingPerPeer: 3, retryDelaysMs: [1000, 2000, 4000, 8000, 15000, 30000], ...opts };
  }

  /** Start routing traffic from a newly established link. */
  attach(peerId: string, link: SecureLink): void {
    link.onMessage = (msg) => this.onMessage(peerId, link, msg);
    link.onFrame = (frame) => {
      const h = readHeader(frame);
      if (!h) return link.close("malformed frame");
      for (const t of this.incoming.values()) {
        if (t.owns(link, h.stream)) return t.onFrame(link, h, frame);
      }
      // Late frames from a cancelled/finished attempt: ignore.
    };
    const previous = link.onClose;
    link.onClose = (reason) => {
      previous(reason);
      for (const t of this.outgoing.values()) if (t.link === link) t.interrupt(reason);
      for (const t of this.incoming.values()) if (t.link === link) t.interrupt();
      this.opts.onChange();
    };
  }

  /** Queue files for a peer. Large selections are split into several offers. */
  send(peerId: string, peerName: string, files: File[]): Outgoing[] {
    const created: Outgoing[] = [];
    for (let i = 0; i < files.length; i += MAX_FILES_PER_OFFER) {
      const t = new Outgoing(peerId, peerName, files.slice(i, i + MAX_FILES_PER_OFFER));
      t.onChange = this.opts.onChange;
      this.outgoing.set(t.id, t);
      created.push(t);
    }
    this.opts.onChange();
    void this.pump(peerId);
    return created;
  }

  /** A link to this peer is ready: resume anything that was waiting. */
  linkReady(peerId: string): void {
    clearTimeout(this.retries.get(peerId));
    this.retries.delete(peerId);
    this.attempts.delete(peerId);
    void this.pump(peerId);
  }

  /** The peer left the network: nothing can resume any more. */
  peerGone(peerId: string): void {
    clearTimeout(this.retries.get(peerId));
    this.retries.delete(peerId);
    this.attempts.delete(peerId);
    for (const t of this.outgoing.values()) if (t.peerId === peerId && !t.isFinal) t.giveUp("device left");
    for (const t of this.incoming.values()) {
      if (t.peerId === peerId && !t.isFinal) {
        if (t.state === "offered") t.decline();
        else t.cancelledByPeer("device left");
      }
    }
    this.opts.onChange();
  }

  /** Display name updates (e.g. peer list refresh). */
  rename(peerId: string, name: string): void {
    for (const t of [...this.outgoing.values(), ...this.incoming.values()]) if (t.peerId === peerId) t.peerName = name;
  }

  /** Forget a finished transfer and free storage held for its files. */
  remove(id: string): void {
    const t = this.outgoing.get(id) ?? this.incoming.get(id);
    if (t && !t.isFinal) return;
    this.outgoing.delete(id);
    const inc = this.incoming.get(id);
    this.incoming.delete(id);
    void inc?.release();
    this.opts.onChange();
  }

  private next(peerId: string): Outgoing | undefined {
    for (const t of this.outgoing.values()) {
      if (t.peerId === peerId && (t.state === "connecting" || t.state === "interrupted")) return t;
    }
    return undefined;
  }

  private async pump(peerId: string): Promise<void> {
    if (this.running.has(peerId)) return;
    this.running.add(peerId);
    try {
      for (let t = this.next(peerId); t; t = this.next(peerId)) {
        let link: SecureLink;
        try {
          link = await this.opts.getLink(peerId);
        } catch {
          return this.scheduleRetry(peerId);
        }
        if (t.isFinal) continue;
        const result = await t.run(link);
        if (result === "interrupted") return this.scheduleRetry(peerId);
        this.attempts.delete(peerId);
      }
    } finally {
      this.running.delete(peerId);
    }
  }

  private scheduleRetry(peerId: string): void {
    if (this.retries.has(peerId) || !this.next(peerId)) return;
    const attempt = this.attempts.get(peerId) ?? 0;
    this.attempts.set(peerId, attempt + 1);
    const delays = this.opts.retryDelaysMs;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
    const timer = setTimeout(() => {
      this.retries.delete(peerId);
      void this.pump(peerId);
    }, delay);
    this.retries.set(peerId, timer);
  }

  private onMessage(peerId: string, link: SecureLink, msg: SealedMessage): void {
    if (msg.t === "offer") return this.onOffer(peerId, link, msg);

    const out = this.outgoing.get(msg.id);
    if (out && out.link === link) return out.handle(msg);

    const inc = this.incoming.get(msg.id);
    if (inc && inc.link === link && msg.t === "cancel") inc.cancelledByPeer(msg.reason);
  }

  private onOffer(peerId: string, link: SecureLink, offer: Extract<SealedMessage, { t: "offer" }>): void {
    const existing = this.incoming.get(offer.id);
    if (existing) {
      // Resume: transfer ids are random and only ever sent sealed, so knowing
      // one proves the offer comes from the original sender.
      if (!existing.matches(offer) || existing.state === "declined" || existing.state === "cancelled" || existing.state === "failed") {
        link.send({ t: "decline", id: offer.id, reason: "error" }).catch(() => {});
        return;
      }
      existing.peerId = peerId;
      existing.relink(link);
      if (existing.state !== "offered") void existing.accept();
      this.opts.onChange();
      return;
    }
    if (this.outgoing.has(offer.id)) return;

    const pending = [...this.incoming.values()].filter((t) => t.peerId === peerId && t.state === "offered").length;
    if (pending >= this.opts.maxPendingPerPeer) {
      link.send({ t: "decline", id: offer.id, reason: "busy" }).catch(() => {});
      return;
    }
    const t = new Incoming(peerId, this.opts.nameOf(peerId), offer, link, this.opts.createSink);
    t.onChange = this.opts.onChange;
    t.onFile = (file, index) => this.opts.onFile(t, file, index);
    this.incoming.set(t.id, t);
    this.opts.onOffer(t);
    this.opts.onChange();
  }
}
