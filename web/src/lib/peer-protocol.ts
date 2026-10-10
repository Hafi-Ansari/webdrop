/**
 * Messages exchanged directly between browsers over WebRTC data channels.
 * Everything a remote peer sends is untrusted and validated here.
 */
import * as z from "zod/mini";

const b64u = (bytes: number) => z.string().check(z.length(Math.ceil((bytes * 4) / 3)), z.regex(/^[A-Za-z0-9_-]+$/));

export const TransferId = b64u(16);
const u32 = z.int().check(z.gte(0), z.lte(0xffffffff));
const byteCount = z.int().check(z.gte(0), z.lte(2 ** 50));

export const MAX_FILES_PER_OFFER = 100;

// ---------------------------------------------------------------------------
// Handshake: plaintext JSON strings on the ctrl channel
// ---------------------------------------------------------------------------

export const HandshakeMessage = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("hs-commit"), v: z.literal(1), commit: b64u(32) }),
  z.strictObject({ t: z.literal("hs-key"), v: z.literal(1), pub: b64u(65) }),
  z.strictObject({ t: z.literal("hs-reveal"), v: z.literal(1), pub: b64u(65) }),
]);
export type HandshakeMessage = z.infer<typeof HandshakeMessage>;

// ---------------------------------------------------------------------------
// Sealed control messages: AES-GCM binary messages on the ctrl channel
// ---------------------------------------------------------------------------

export const FileMeta = z.strictObject({
  name: z.string().check(z.minLength(1), z.maxLength(255)),
  size: byteCount,
  type: z.string().check(z.maxLength(127)),
});
export type FileMeta = z.infer<typeof FileMeta>;

export const DeclineReason = z.enum(["declined", "busy", "storage", "error"]);
export const CancelReason = z.enum(["cancelled", "error", "integrity"]);

export const SealedMessage = z.discriminatedUnion("t", [
  /** Sender proposes a transfer. `resume` re-offers a transfer interrupted earlier. */
  z.strictObject({
    t: z.literal("offer"),
    id: TransferId,
    files: z.array(FileMeta).check(z.minLength(1), z.maxLength(MAX_FILES_PER_OFFER)),
    resume: z.boolean(),
  }),
  /**
   * Receiver accepts. Files are received strictly in order, so resume state is
   * (first incomplete file, bytes of it already written). `stream` tags the
   * data frames of this attempt; `salt` makes this attempt's key unique.
   */
  z.strictObject({
    t: z.literal("accept"),
    id: TransferId,
    salt: b64u(16),
    stream: u32,
    file: z.int().check(z.gte(0), z.lte(MAX_FILES_PER_OFFER)),
    offset: byteCount,
  }),
  z.strictObject({ t: z.literal("decline"), id: TransferId, reason: DeclineReason }),
  z.strictObject({ t: z.literal("cancel"), id: TransferId, reason: CancelReason }),
  /** Cumulative bytes of `file` durably written by the receiver. */
  z.strictObject({ t: z.literal("ack"), id: TransferId, file: z.int().check(z.gte(0), z.lt(MAX_FILES_PER_OFFER)), bytes: byteCount }),
  z.strictObject({ t: z.literal("done"), id: TransferId }),
]);
export type SealedMessage = z.infer<typeof SealedMessage>;
