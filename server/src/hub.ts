import {
  ClientMessage,
  CloseCode,
  type DeviceInfo,
  type ErrorCode,
  type Peer,
  type RoomTag,
  type ServerMessage,
  parseJson,
} from "@webdrop/shared/protocol";
import type { Limits } from "./config.ts";
import type { IceProvider } from "./ice.ts";
import { hashToken, newPeerId, newResumeToken, newRoomCode } from "./ids.ts";
import type { Logger } from "./log.ts";
import { randomName } from "./names.ts";
import { KeyedLimiter, TokenBucket } from "@webdrop/shared/rate-limit";

/** The minimum a socket must offer. Implemented by `ws` and by test fakes. */
export interface Transport {
  send(data: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

interface PeerState {
  id: string;
  name: string;
  device: DeviceInfo;
  resumeHash: string;
  transport: Transport | null;
  netRoom: Room | null;
  pairRoom: Room | null;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Signals relayed *to* this peer, across all senders. */
  inbound: TokenBucket;
}

interface Room {
  key: string;
  tag: RoomTag;
  members: Set<PeerState>;
}

export interface HubOptions {
  limits: Limits;
  iceProvider: IceProvider;
  /** Maps a client IP to its discovery network key. */
  networkKey: (ip: string) => string;
  log: Logger;
  now?: () => number;
}

export type Admission = { ok: true } | { ok: false; status: number; reason: string };

export class Hub {
  readonly peers = new Map<string, PeerState>();
  private readonly byResume = new Map<string, PeerState>();
  private readonly rooms = new Map<string, Room>();
  private readonly connectionsByIp = new Map<string, number>();
  private readonly connectLimiter: KeyedLimiter;
  readonly joinLimiter: KeyedLimiter;
  private connectionCount = 0;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  readonly opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
    const { limits } = opts;
    const now = opts.now ?? Date.now;
    this.connectLimiter = new KeyedLimiter(limits.connectBurst, limits.connectPerSecond, now);
    this.joinLimiter = new KeyedLimiter(limits.joinBurst, limits.joinPerSecond, now);
    this.sweepTimer = setInterval(() => {
      this.connectLimiter.sweep();
      this.joinLimiter.sweep();
    }, 60_000);
    this.sweepTimer.unref();
  }

  /** Decide whether to accept a new WebSocket from `ip` (called before the upgrade completes). */
  admit(ip: string): Admission {
    const { limits } = this.opts;
    if (this.connectionCount >= limits.maxConnections) return { ok: false, status: 503, reason: "server full" };
    if ((this.connectionsByIp.get(ip) ?? 0) >= limits.maxConnectionsPerIp) {
      return { ok: false, status: 429, reason: "too many connections" };
    }
    if (!this.connectLimiter.take(ip)) return { ok: false, status: 429, reason: "too many connection attempts" };
    return { ok: true };
  }

  /** Register an accepted socket. The caller forwards messages and the close event. */
  connect(transport: Transport, ip: string): Connection {
    this.connectionCount++;
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1);
    return new Connection(this, transport, ip);
  }

  /** @internal */
  released(ip: string): void {
    this.connectionCount--;
    const n = (this.connectionsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) this.connectionsByIp.delete(ip);
    else this.connectionsByIp.set(ip, n);
  }

  stats() {
    return { connections: this.connectionCount, peers: this.peers.size, rooms: this.rooms.size };
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const peer of this.peers.values()) clearTimeout(peer.graceTimer);
  }

  // -------------------------------------------------------------------------
  // Peer lifecycle
  // -------------------------------------------------------------------------

  /** @internal Create or resume a peer for a validated hello. */
  attachPeer(transport: Transport, ip: string, device: DeviceInfo, resume: string | undefined) {
    let peer = resume ? this.byResume.get(hashToken(resume)) : undefined;
    let resumed = false;
    if (peer && peer.transport === null) {
      clearTimeout(peer.graceTimer);
      peer.graceTimer = undefined;
      this.byResume.delete(peer.resumeHash);
      peer.transport = transport;
      peer.device = device;
      resumed = true;
    } else {
      // Unknown/expired token, or the identity is live in another tab
      // (sessionStorage is copied when a tab is duplicated): new identity.
      const netKey = "net:" + this.opts.networkKey(ip);
      const taken = new Set([...(this.rooms.get(netKey)?.members ?? [])].map((p) => p.name));
      peer = {
        id: newPeerId(),
        name: randomName(taken),
        device,
        resumeHash: "",
        transport,
        netRoom: null,
        pairRoom: null,
        graceTimer: undefined,
        inbound: new TokenBucket(this.opts.limits.messageBurst * 2, this.opts.limits.messagesPerSecond * 2, this.opts.now),
      };
      this.peers.set(peer.id, peer);
    }
    // Rotate the resume token on every successful hello.
    const token = newResumeToken();
    peer.resumeHash = hashToken(token);
    this.byResume.set(peer.resumeHash, peer);
    return { peer, token, resumed };
  }

  /** @internal Send room snapshots after `welcome`; move networks if the IP changed. */
  enterRooms(peer: PeerState, ip: string): void {
    const netKey = "net:" + this.opts.networkKey(ip);
    if (peer.netRoom && peer.netRoom.key !== netKey) this.leaveRoom(peer, peer.netRoom, false);
    if (!this.joinRoom(peer, this.room(netKey, "net"))) this.sendError(peer, "room-full", "net");
    const pair = peer.pairRoom;
    if (pair) {
      // A peer that left the page vacated its pair room, which may have emptied
      // (and been unregistered) since. Rejoin unless its code now names another room.
      const live = this.rooms.get(pair.key);
      if (!live) this.rooms.set(pair.key, pair);
      if ((live && live !== pair) || !this.joinRoom(peer, pair)) peer.pairRoom = null;
    }
  }

  /**
   * @internal Socket closed: keep the identity for the grace period so the
   * client can resume. A client leaving its page also leaves its rooms now
   * instead of lingering in other devices' lists until the grace period ends.
   */
  detachPeer(peer: PeerState, transport: Transport, leaving: boolean): void {
    if (peer.transport !== transport) return;
    peer.transport = null;
    if (leaving) this.vacate(peer);
    peer.graceTimer = setTimeout(() => this.removePeer(peer), this.opts.limits.resumeGraceMs);
    peer.graceTimer.unref?.();
  }

  /** Leave every room, remembering the pair room so a resume (e.g. a reload) can rejoin it. */
  private vacate(peer: PeerState): void {
    const pair = peer.pairRoom;
    if (peer.netRoom) this.leaveRoom(peer, peer.netRoom, false);
    if (pair) this.leaveRoom(peer, pair, false);
    peer.pairRoom = pair;
  }

  private removePeer(peer: PeerState): void {
    clearTimeout(peer.graceTimer);
    if (peer.netRoom) this.leaveRoom(peer, peer.netRoom, false);
    if (peer.pairRoom) this.leaveRoom(peer, peer.pairRoom, false);
    this.byResume.delete(peer.resumeHash);
    this.peers.delete(peer.id);
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  private room(key: string, tag: RoomTag): Room {
    let room = this.rooms.get(key);
    if (!room) {
      room = { key, tag, members: new Set() };
      this.rooms.set(key, room);
    }
    return room;
  }

  private joinRoom(peer: PeerState, room: Room): boolean {
    if (!room.members.has(peer)) {
      if (room.members.size >= this.opts.limits.maxRoomSize) return false;
      room.members.add(peer);
      const announce: ServerMessage = { t: "peer-joined", room: room.tag, peer: publicPeer(peer) };
      for (const other of room.members) if (other !== peer) this.send(other, announce);
    }
    if (room.tag === "net") peer.netRoom = room;
    else peer.pairRoom = room;
    const others = [...room.members].filter((p) => p !== peer).map(publicPeer);
    this.send(peer, { t: "peers", room: room.tag, peers: others });
    return true;
  }

  private leaveRoom(peer: PeerState, room: Room, notifySelf: boolean): void {
    if (room.members.delete(peer)) {
      const msg: ServerMessage = { t: "peer-left", room: room.tag, id: peer.id };
      for (const other of room.members) this.send(other, msg);
    }
    // A vacated room may already be unregistered, and its code reused by another.
    if (room.members.size === 0 && this.rooms.get(room.key) === room) this.rooms.delete(room.key);
    if (peer.netRoom === room) peer.netRoom = null;
    if (peer.pairRoom === room) peer.pairRoom = null;
    if (notifySelf) this.send(peer, { t: "room-left", room: room.tag });
  }

  /** @internal */
  createPairRoom(peer: PeerState): void {
    let code: string;
    do code = newRoomCode();
    while (this.rooms.has("pair:" + code));
    if (peer.pairRoom) this.leaveRoom(peer, peer.pairRoom, true);
    this.joinRoom(peer, this.room("pair:" + code, `pair:${code}`));
  }

  /** @internal */
  joinPairRoom(peer: PeerState, code: string): void {
    const room = this.rooms.get("pair:" + code);
    if (!room) return this.sendError(peer, "room-not-found", code);
    if (peer.pairRoom === room) {
      this.joinRoom(peer, room);
      return;
    }
    if (room.members.size >= this.opts.limits.maxRoomSize) return this.sendError(peer, "room-full", code);
    if (peer.pairRoom) this.leaveRoom(peer, peer.pairRoom, true);
    this.joinRoom(peer, room);
  }

  /** @internal */
  leavePairRoom(peer: PeerState): void {
    if (peer.pairRoom) this.leaveRoom(peer, peer.pairRoom, true);
  }

  // -------------------------------------------------------------------------
  // Relay
  // -------------------------------------------------------------------------

  /** @internal Forward a signal only between peers that share a room. */
  relay(from: PeerState, msg: Extract<ClientMessage, { t: "signal" }>): void {
    const target = this.peers.get(msg.to);
    const shares =
      target !== undefined &&
      target !== from &&
      ((from.netRoom !== null && from.netRoom === target.netRoom) || (from.pairRoom !== null && from.pairRoom === target.pairRoom));
    if (!shares || !target.transport || target.transport.bufferedAmount > this.opts.limits.maxBufferedBytes / 4) {
      return this.sendError(from, "peer-unavailable", msg.to);
    }
    // Protects a victim from floods spread over many attacker sockets.
    if (!target.inbound.take()) return this.sendError(from, "rate-limited", msg.to);
    this.send(target, { t: "signal", from: from.id, payload: msg.payload });
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** @internal */
  send(peer: PeerState, msg: ServerMessage): void {
    const t = peer.transport;
    if (t) sendTo(t, msg, this.opts.limits.maxBufferedBytes);
  }

  /** @internal */
  sendError(peer: PeerState, code: ErrorCode, ref?: string): void {
    this.send(peer, ref === undefined ? { t: "error", code } : { t: "error", code, ref });
  }
}

function sendTo(t: Transport, msg: ServerMessage, maxBuffered: number): void {
  if (t.bufferedAmount > maxBuffered) {
    t.close(CloseCode.slowConsumer, "slow consumer");
    return;
  }
  t.send(JSON.stringify(msg));
}

const publicPeer = (p: PeerState): Peer => ({ id: p.id, name: p.name, device: p.device });

/** Per-socket state machine: hello first, then rate-limited, validated messages. */
export class Connection {
  private peer: PeerState | null = null;
  private helloPending = false;
  private closed = false;
  private violations = 0;
  private readonly messages: TokenBucket;
  private readonly creates: TokenBucket;
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  private readonly hub: Hub;
  private readonly transport: Transport;
  private readonly ip: string;

  constructor(hub: Hub, transport: Transport, ip: string) {
    this.hub = hub;
    this.transport = transport;
    this.ip = ip;
    const { limits } = hub.opts;
    const now = hub.opts.now ?? Date.now;
    this.messages = new TokenBucket(limits.messageBurst, limits.messagesPerSecond, now);
    this.creates = new TokenBucket(limits.createBurst, limits.createPerSecond, now);
    this.helloTimer = setTimeout(() => {
      if (!this.peer) this.terminate(CloseCode.helloTimeout, "hello timeout");
    }, limits.helloTimeoutMs);
    this.helloTimer.unref?.();
  }

  get peerId(): string | undefined {
    return this.peer?.id;
  }

  async onMessage(raw: string): Promise<void> {
    if (this.closed) return;
    if (!this.messages.take()) return this.violation("rate-limited");

    const parsed = ClientMessage.safeParse(parseJson(raw));
    if (!parsed.success) return this.violation("bad-message");
    const msg = parsed.data;

    if (msg.t === "hello") {
      if (this.peer || this.helloPending) return this.violation("bad-message");
      return this.hello(msg);
    }
    const peer = this.peer;
    if (!peer) {
      this.error("hello-required");
      return this.terminate(CloseCode.policy, "hello required");
    }

    switch (msg.t) {
      case "signal":
        return this.hub.relay(peer, msg);
      case "room-create":
        if (!this.creates.take()) return this.violation("rate-limited");
        return this.hub.createPairRoom(peer);
      case "room-join":
        if (!this.hub.joinLimiter.take(this.ip)) return this.violation("rate-limited");
        return this.hub.joinPairRoom(peer, msg.code);
      case "room-leave":
        return this.hub.leavePairRoom(peer);
      case "ping":
        return this.hub.send(peer, { t: "pong" });
    }
  }

  /** `code` is the close code the client sent, if any. */
  onClose(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.hub.released(this.ip);
    if (this.peer) this.hub.detachPeer(this.peer, this.transport, code === CloseCode.leaving);
  }

  private async hello(msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    this.helloPending = true;
    const { peer, token, resumed } = this.hub.attachPeer(this.transport, this.ip, msg.device, msg.resume);
    // Claim the identity immediately so a close during the await below releases it.
    this.peer = peer;
    clearTimeout(this.helloTimer);
    let iceServers: Awaited<ReturnType<IceProvider>> = [];
    try {
      iceServers = await this.hub.opts.iceProvider(peer.id);
    } catch (err) {
      this.hub.opts.log.warn("ice provider failed", { error: String(err) });
    }
    if (this.closed) return;
    this.hub.send(peer, {
      t: "welcome",
      self: { id: peer.id, name: peer.name, device: peer.device },
      resume: token,
      resumed,
      iceServers,
    });
    this.hub.enterRooms(peer, this.ip);
  }

  private error(code: ErrorCode): void {
    sendTo(this.transport, { t: "error", code }, this.hub.opts.limits.maxBufferedBytes);
  }

  private violation(code: ErrorCode): void {
    this.violations++;
    if (this.violations > this.hub.opts.limits.maxViolations) {
      return this.terminate(code === "rate-limited" ? CloseCode.rateLimited : CloseCode.policy, code);
    }
    this.error(code);
  }

  private terminate(code: number, reason: string): void {
    if (this.closed) return;
    this.transport.close(code, reason);
  }
}
