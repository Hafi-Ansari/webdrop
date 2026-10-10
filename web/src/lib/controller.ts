import type { DeviceInfo, ErrorCode, Peer, RoomTag, ServerMessage, SignalPayload } from "@webdrop/shared/protocol";
import { randomId } from "./bytes.ts";
import { saveFile } from "./download.ts";
import type { FileMeta } from "./peer-protocol.ts";
import type { SecureLink } from "./secure-link.ts";
import { PeerSession } from "./session.ts";
import { SignalingClient, type SignalingState } from "./signaling.ts";
import { cleanupOpfs, createSink } from "./sinks.ts";
import { TransferManager } from "./transfer-manager.ts";
import type { Incoming, Outgoing, TransferState } from "./transfer.ts";

export interface PeerView extends Peer {
  rooms: RoomTag[];
}

export interface TransferView {
  id: string;
  direction: "in" | "out";
  peerId: string;
  peerName: string;
  state: TransferState;
  files: FileMeta[];
  total: number;
  bytes: number;
  rate: number;
  sas: string | undefined;
  error: string | undefined;
  /** Incoming only: indices of files saved so far. */
  saved: number[];
}

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

export interface AppState {
  connection: SignalingState;
  self: Peer | null;
  peers: PeerView[];
  pairCode: string | null;
  transfers: TransferView[];
  /** Incoming offers waiting for the user, oldest first. */
  prompts: TransferView[];
  toasts: Toast[];
}

type Listener = () => void;

/** Minimal external store for useSyncExternalStore. */
export class Store<T> {
  private state: T;
  private readonly listeners = new Set<Listener>();
  constructor(initial: T) {
    this.state = initial;
  }
  get = (): T => this.state;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(next: T): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  "room-not-found": "No device is using that code.",
  "room-full": "That room is full.",
  "rate-limited": "Too many requests. Wait a moment and try again.",
  "server-full": "The server is busy. Try again shortly.",
};

const LINK_TIMEOUT_MS = 20_000;

export class Controller {
  readonly store = new Store<AppState>({
    connection: "connecting",
    self: null,
    peers: [],
    pairCode: null,
    transfers: [],
    prompts: [],
    toasts: [],
  });
  readonly transfers: TransferManager;

  private readonly signaling: SignalingClient;
  private self: Peer | null = null;
  private iceServers: RTCIceServer[] = [];
  private readonly rooms = new Map<RoomTag, Map<string, Peer>>();
  private readonly sessions = new Map<string, PeerSession>();
  private readonly linkWaiters = new Map<string, Array<(s: PeerSession) => void>>();
  private toasts: Toast[] = [];
  private toastSeq = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingJoin: string | null = null;

  constructor(opts: { url: string; device: DeviceInfo }) {
    this.signaling = new SignalingClient(opts.url, opts.device);
    this.signaling.onMessage = (m) => this.onServer(m);
    this.signaling.onState = () => this.refresh(true);
    this.transfers = new TransferManager({
      createSink,
      getLink: (peerId) => this.getLink(peerId),
      onOffer: () => this.refresh(true),
      onFile: (t, file, index) => this.onFile(t, file, index),
      onChange: () => this.refresh(),
      nameOf: (peerId) => this.peer(peerId)?.name ?? "Unknown device",
    });
  }

  start(): void {
    void cleanupOpfs();
    const match = /^#pair=([0-9A-Za-z]{6})$/.exec(location.hash);
    if (match?.[1]) {
      this.pendingJoin = normalizeCode(match[1]);
      history.replaceState(null, "", location.pathname + location.search);
    }
    this.signaling.start();
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  sendFiles(peerId: string, files: File[]): void {
    const peer = this.peer(peerId);
    if (!peer || files.length === 0) return;
    this.transfers.send(peerId, peer.name, files);
  }

  accept(id: string): void {
    void this.transfers.incoming.get(id)?.accept();
    this.refresh(true);
  }

  decline(id: string): void {
    this.transfers.incoming.get(id)?.decline();
    this.refresh(true);
  }

  cancel(id: string): void {
    this.transfers.outgoing.get(id)?.cancel();
    this.transfers.incoming.get(id)?.cancel();
    this.refresh(true);
  }

  dismiss(id: string): void {
    this.transfers.remove(id);
  }

  save(id: string, index: number): void {
    const t = this.transfers.incoming.get(id);
    const file = t?.results[index];
    if (t && file) {
      saveFile(file);
      this.markSaved(t, index);
    }
  }

  createPairRoom(): void {
    this.signaling.send({ t: "room-create" });
  }

  joinPairRoom(code: string): void {
    this.signaling.send({ t: "room-join", code: normalizeCode(code) });
  }

  leavePairRoom(): void {
    this.signaling.send({ t: "room-leave" });
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.refresh(true);
  }

  // ---------------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------------

  private onServer(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        if (this.self && this.self.id !== msg.self.id) {
          // New identity: peers know us by the old id, so every session is stale.
          for (const s of this.sessions.values()) s.close("identity changed");
        }
        this.self = msg.self;
        this.iceServers = msg.iceServers.map((s) => ({ ...s, urls: s.urls }));
        const before = this.allPeerIds();
        this.rooms.clear();
        this.departed(before);
        if (this.pendingJoin) {
          this.signaling.send({ t: "room-join", code: this.pendingJoin });
          this.pendingJoin = null;
        }
        break;
      }
      case "peers": {
        const before = this.allPeerIds();
        this.rooms.set(msg.room, new Map(msg.peers.map((p) => [p.id, p])));
        this.departed(before);
        for (const p of msg.peers) this.transfers.rename(p.id, p.name);
        break;
      }
      case "peer-joined": {
        let room = this.rooms.get(msg.room);
        if (!room) this.rooms.set(msg.room, (room = new Map()));
        room.set(msg.peer.id, msg.peer);
        break;
      }
      case "peer-left": {
        const before = this.allPeerIds();
        this.rooms.get(msg.room)?.delete(msg.id);
        this.departed(before);
        break;
      }
      case "room-left": {
        const before = this.allPeerIds();
        this.rooms.delete(msg.room);
        this.departed(before);
        break;
      }
      case "signal":
        this.onSignal(msg.from, msg.payload);
        break;
      case "error": {
        const text = ERROR_TEXT[msg.code];
        if (text) this.toast("error", text);
        break;
      }
      case "pong":
        break;
    }
    this.refresh(true);
  }

  private allPeerIds(): Set<string> {
    const ids = new Set<string>();
    for (const room of this.rooms.values()) for (const id of room.keys()) ids.add(id);
    return ids;
  }

  /** Tear down anything belonging to peers that are no longer visible. */
  private departed(before: Set<string>): void {
    const now = this.allPeerIds();
    for (const id of before) {
      if (now.has(id)) continue;
      this.sessions.get(id)?.close("peer left");
      this.transfers.peerGone(id);
    }
  }

  private peer(id: string): Peer | undefined {
    for (const room of this.rooms.values()) {
      const p = room.get(id);
      if (p) return p;
    }
    return undefined;
  }

  private signal(to: string, payload: SignalPayload): void {
    this.signaling.send({ t: "signal", to, payload });
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  private isOfferer(peerId: string): boolean {
    return this.self !== null && this.self.id < peerId;
  }

  private createSession(peerId: string, sid: string, offerer: boolean): PeerSession {
    this.sessions.get(peerId)?.close("replaced");
    const session = new PeerSession({
      peerId,
      sid,
      offerer,
      iceServers: this.iceServers,
      signal: (payload) => this.signal(peerId, payload),
    });
    session.onClosed = () => {
      if (this.sessions.get(peerId) === session) {
        this.sessions.delete(peerId);
        this.signal(peerId, { kind: "close", sid });
      }
      this.refresh();
    };
    this.sessions.set(peerId, session);
    this.transfers.attach(peerId, session.link);
    session.link.ready.then(
      () => {
        for (const resolve of this.linkWaiters.get(peerId)?.splice(0) ?? []) resolve(session);
        this.transfers.linkReady(peerId);
        this.refresh(true);
      },
      () => {},
    );
    return session;
  }

  /** A ready secure link to `peerId`, creating a session if needed. */
  private async getLink(peerId: string): Promise<SecureLink> {
    const existing = this.sessions.get(peerId);
    if (existing && !existing.isClosed) {
      await existing.link.ready;
      return existing.link;
    }
    if (!this.self || !this.peer(peerId)) throw new Error("peer not available");
    if (this.isOfferer(peerId)) {
      const session = this.createSession(peerId, randomId(), true);
      await session.link.ready;
      return session.link;
    }
    // The other side offers: ask it to, then wait for its session to come up.
    const session = await new Promise<PeerSession>((resolve, reject) => {
      const waiters = this.linkWaiters.get(peerId) ?? [];
      this.linkWaiters.set(peerId, waiters);
      const done = (s: PeerSession) => {
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(done) >>> 0, 1);
        reject(new Error("peer did not connect"));
      }, LINK_TIMEOUT_MS);
      waiters.push(done);
      this.signal(peerId, { kind: "connect" });
    });
    await session.link.ready;
    return session.link;
  }

  private onSignal(from: string, payload: SignalPayload): void {
    if (!this.peer(from) || !this.self) return;
    const current = this.sessions.get(from);
    switch (payload.kind) {
      case "connect":
        // Only the lower id offers. The requester has no usable session, so start fresh.
        if (this.isOfferer(from)) this.createSession(from, randomId(), true);
        return;
      case "description":
        if (payload.description.type === "offer") {
          if (this.isOfferer(from)) return;
          const s = current && current.sid === payload.sid && !current.isClosed ? current : this.createSession(from, payload.sid, false);
          s.handleSignal(payload);
        } else if (current?.sid === payload.sid) {
          current.handleSignal(payload);
        }
        return;
      case "candidate":
      case "close":
        if (current?.sid === payload.sid) current.handleSignal(payload);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  private readonly savedFiles = new Map<string, Set<number>>();

  private onFile(t: Incoming, file: File, index: number): void {
    // Saved automatically once the user accepted the transfer.
    saveFile(file);
    this.markSaved(t, index);
  }

  private markSaved(t: Incoming, index: number): void {
    const set = this.savedFiles.get(t.id) ?? new Set<number>();
    set.add(index);
    this.savedFiles.set(t.id, set);
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // View state
  // ---------------------------------------------------------------------------

  toast(kind: Toast["kind"], text: string): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts.slice(-3), { id, kind, text }];
    setTimeout(() => this.dismissToast(id), 6000);
    this.refresh(true);
  }

  /** Coalesce frequent progress updates into at most ~10 renders/s. */
  private refresh(immediate = false): void {
    if (immediate) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      this.store.set(this.snapshot());
      return;
    }
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.store.set(this.snapshot());
    }, 100);
  }

  private snapshot(): AppState {
    const peers = new Map<string, PeerView>();
    let pairCode: string | null = null;
    for (const [tag, room] of this.rooms) {
      if (tag.startsWith("pair:")) pairCode = tag.slice(5);
      for (const p of room.values()) {
        const view = peers.get(p.id) ?? { ...p, rooms: [] };
        view.rooms.push(tag);
        peers.set(p.id, view);
      }
    }
    const view = (t: Outgoing | Incoming): TransferView => ({
      id: t.id,
      direction: t.direction,
      peerId: t.peerId,
      peerName: t.peerName,
      state: t.state,
      files: t.files,
      total: t.total,
      bytes: t.bytes,
      rate: t.rate,
      sas: t.sas,
      error: t.error,
      saved: [...(this.savedFiles.get(t.id) ?? [])],
    });
    const all = [...this.transfers.outgoing.values(), ...this.transfers.incoming.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      connection: this.signaling.state,
      self: this.self,
      peers: [...peers.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pairCode,
      transfers: all.filter((t) => !(t.direction === "in" && t.state === "offered")).map(view),
      prompts: [...this.transfers.incoming.values()].filter((t) => t.state === "offered").map(view),
      toasts: this.toasts,
    };
  }
}

/** Crockford base32: accept lowercase and the usual look-alikes. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");
}
