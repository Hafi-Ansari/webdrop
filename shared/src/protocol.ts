/**
 * Signaling protocol shared by the server and the web client.
 *
 * Every message crossing the WebSocket is validated against these schemas on
 * receipt (server validates client messages, client validates server
 * messages). Objects are strict: unknown keys are rejected rather than
 * silently passed through.
 */
import * as z from "zod/mini";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Max WebSocket frame accepted by the server (bytes). */
  maxFrameBytes: 64 * 1024,
  maxSdpLength: 32 * 1024,
  maxCandidateLength: 2 * 1024,
  maxIceServers: 8,
} as const;

/** 128-bit random id, base64url without padding. */
export const PeerId = z.string().check(z.regex(/^[A-Za-z0-9_-]{22}$/));
export type PeerId = z.infer<typeof PeerId>;

/** 256-bit random token, base64url without padding. */
export const ResumeToken = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/));

/** Session id chosen by the offering side for one RTCPeerConnection. */
export const SessionId = z.string().check(z.regex(/^[A-Za-z0-9_-]{16}$/));

/** Crockford base32 without I, L, O, U. */
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 6;
export const RoomCode = z.string().check(z.regex(/^[0-9A-HJKMNP-TV-Z]{6}$/));

/** Server-generated display names: "Adjective Noun" with an optional numeric suffix. */
export const DisplayName = z.string().check(z.maxLength(48), z.regex(/^[A-Z][a-z]+ [A-Z][a-z]+(?: [0-9]{1,3})?$/));

export const DeviceInfo = z.strictObject({
  os: z.enum(["windows", "macos", "linux", "chromeos", "android", "ios", "other"]),
  browser: z.enum(["chrome", "edge", "firefox", "safari", "opera", "samsung", "other"]),
  form: z.enum(["desktop", "mobile", "tablet"]),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const Peer = z.strictObject({
  id: PeerId,
  name: DisplayName,
  device: DeviceInfo,
});
export type Peer = z.infer<typeof Peer>;

/** Room tags as seen by clients. Internal room keys never leave the server. */
export const RoomTag = z.union([z.literal("net"), z.string().check(z.regex(/^pair:[0-9A-HJKMNP-TV-Z]{6}$/))]);
export type RoomTag = z.infer<typeof RoomTag>;

const IceUrl = z.string().check(z.maxLength(512), z.regex(/^(stun|stuns|turn|turns):[^\s]+$/));
export const IceServer = z.strictObject({
  urls: z.union([IceUrl, z.array(IceUrl).check(z.minLength(1), z.maxLength(8))]),
  username: z.optional(z.string().check(z.maxLength(512))),
  credential: z.optional(z.string().check(z.maxLength(512))),
});
export type IceServer = z.infer<typeof IceServer>;

// ---------------------------------------------------------------------------
// Signal payloads (opaque to the server beyond validation)
// ---------------------------------------------------------------------------

export const SessionDescription = z.strictObject({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().check(z.maxLength(LIMITS.maxSdpLength)),
});

export const IceCandidate = z.strictObject({
  candidate: z.string().check(z.maxLength(LIMITS.maxCandidateLength)),
  sdpMid: z.nullish(z.string().check(z.maxLength(64))),
  sdpMLineIndex: z.nullish(z.int().check(z.gte(0), z.lte(64))),
  usernameFragment: z.nullish(z.string().check(z.maxLength(256))),
});

export const SignalPayload = z.discriminatedUnion("kind", [
  /** Ask the peer with the lower id to (re)open a session to us. */
  z.strictObject({ kind: z.literal("connect") }),
  z.strictObject({ kind: z.literal("description"), sid: SessionId, description: SessionDescription }),
  z.strictObject({ kind: z.literal("candidate"), sid: SessionId, candidate: z.nullable(IceCandidate) }),
  z.strictObject({ kind: z.literal("close"), sid: SessionId }),
]);
export type SignalPayload = z.infer<typeof SignalPayload>;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("hello"), v: z.literal(PROTOCOL_VERSION), device: DeviceInfo, resume: z.optional(ResumeToken) }),
  z.strictObject({ t: z.literal("signal"), to: PeerId, payload: SignalPayload }),
  z.strictObject({ t: z.literal("room-create") }),
  z.strictObject({ t: z.literal("room-join"), code: RoomCode }),
  z.strictObject({ t: z.literal("room-leave") }),
  z.strictObject({ t: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  "bad-message",
  "hello-required",
  "rate-limited",
  "peer-unavailable",
  "room-not-found",
  "room-full",
  "server-full",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerMessage = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("welcome"),
    self: Peer,
    resume: ResumeToken,
    resumed: z.boolean(),
    iceServers: z.array(IceServer).check(z.maxLength(LIMITS.maxIceServers)),
  }),
  z.strictObject({ t: z.literal("peers"), room: RoomTag, peers: z.array(Peer).check(z.maxLength(1024)) }),
  z.strictObject({ t: z.literal("peer-joined"), room: RoomTag, peer: Peer }),
  z.strictObject({ t: z.literal("peer-left"), room: RoomTag, id: PeerId }),
  z.strictObject({ t: z.literal("signal"), from: PeerId, payload: SignalPayload }),
  z.strictObject({ t: z.literal("room-left"), room: RoomTag }),
  z.strictObject({ t: z.literal("error"), code: ErrorCode, ref: z.optional(z.string().check(z.maxLength(64))) }),
  z.strictObject({ t: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** WebSocket close codes used by the server (4000-4999 are application-defined). */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  policy: 1008,
  tooBig: 1009,
  helloTimeout: 4001,
  rateLimited: 4002,
  replaced: 4003,
  slowConsumer: 4004,
  /** Sent by the client when its page goes away (close, reload, navigation). */
  leaving: 4005,
} as const;

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
