import type { SignalPayload } from "@webdrop/shared/protocol";
import { SecureLink } from "./secure-link.ts";
import { tuning } from "./tuning.ts";

export interface SessionOptions {
  peerId: string;
  sid: string;
  /** The peer with the lower id always offers; it is also handshake role A. */
  offerer: boolean;
  iceServers: RTCIceServer[];
  signal: (payload: SignalPayload) => void;
}

/**
 * One RTCPeerConnection to one peer, carrying a SecureLink over two
 * pre-negotiated data channels. Only the offerer ever creates offers (initial
 * and ICE restarts), so there is no glare to resolve.
 */
export class PeerSession {
  readonly peerId: string;
  readonly sid: string;
  readonly offerer: boolean;
  readonly pc: RTCPeerConnection;
  readonly link: SecureLink;
  onClosed: (reason: string) => void = () => {};

  private readonly signal: (payload: SignalPayload) => void;
  private chain: Promise<void> = Promise.resolve();
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private failTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly connectTimer: ReturnType<typeof setTimeout>;

  constructor(opts: SessionOptions) {
    this.peerId = opts.peerId;
    this.sid = opts.sid;
    this.offerer = opts.offerer;
    this.signal = opts.signal;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    const ctrl = this.pc.createDataChannel("ctrl", { negotiated: true, id: 0, ordered: true });
    const data = this.pc.createDataChannel("data", { negotiated: true, id: 1, ordered: true });
    this.link = new SecureLink(this.offerer ? "A" : "B", ctrl, data, {
      lowWater: tuning.lowWater,
      maxMessageSize: () => this.pc.sctp?.maxMessageSize,
    });
    this.link.onClose = (reason) => this.close(reason);

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate) return;
      const j = candidate.toJSON();
      this.signal({
        kind: "candidate",
        sid: this.sid,
        candidate: {
          candidate: j.candidate ?? "",
          sdpMid: j.sdpMid ?? null,
          sdpMLineIndex: j.sdpMLineIndex ?? null,
          usernameFragment: j.usernameFragment ?? null,
        },
      });
    };
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "closed") this.close("connection closed");
    };
    if (this.offerer) {
      this.pc.onnegotiationneeded = () =>
        this.enqueue(async () => {
          await this.pc.setLocalDescription();
          this.sendDescription();
        });
    }
    this.connectTimer = setTimeout(() => {
      if (!this.link.keys) this.close("connect timeout");
    }, 30_000);
    void this.link.ready.then(() => clearTimeout(this.connectTimer), () => {});
  }

  handleSignal(payload: SignalPayload): void {
    if (payload.kind === "close") return this.close("closed by peer");
    this.enqueue(async () => {
      if (payload.kind === "description") {
        const { type, sdp } = payload.description;
        if (this.offerer ? type !== "answer" : type !== "offer") return;
        await this.pc.setRemoteDescription({ type, sdp });
        for (const c of this.pending.splice(0)) await this.addCandidate(c);
        if (type === "offer") {
          await this.pc.setLocalDescription();
          this.sendDescription();
        }
      } else if (payload.kind === "candidate" && payload.candidate) {
        const c: RTCIceCandidateInit = {
          candidate: payload.candidate.candidate,
          sdpMid: payload.candidate.sdpMid ?? null,
          sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
          usernameFragment: payload.candidate.usernameFragment ?? null,
        };
        if (this.pc.remoteDescription) await this.addCandidate(c);
        else if (this.pending.length < 64) this.pending.push(c);
      }
    });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.restartTimer);
    clearTimeout(this.failTimer);
    this.link.close(reason);
    this.pc.close();
    this.onClosed(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private sendDescription(): void {
    const d = this.pc.localDescription;
    if (d && (d.type === "offer" || d.type === "answer")) {
      this.signal({ kind: "description", sid: this.sid, description: { type: d.type, sdp: d.sdp } });
    }
  }

  private async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch {
      // A stale or malformed candidate is not fatal.
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => this.close(`negotiation failed: ${String(err)}`));
  }

  /** Brief outages trigger an ICE restart (offerer); prolonged failure closes the session. */
  private onIceState(): void {
    const state = this.pc.iceConnectionState;
    clearTimeout(this.restartTimer);
    if (state === "connected" || state === "completed") {
      clearTimeout(this.failTimer);
      this.failTimer = undefined;
      return;
    }
    if (state === "disconnected" || state === "failed") {
      if (this.offerer) this.restartTimer = setTimeout(() => this.pc.restartIce(), state === "failed" ? 0 : 3000);
      this.failTimer ??= setTimeout(() => this.close("connection lost"), 20_000);
    }
  }
}
