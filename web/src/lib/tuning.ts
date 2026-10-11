/**
 * Transfer tuning. Defaults come from bench/ results (see README). The object
 * is mutable so the benchmark can sweep values in e2e builds.
 */
export const tuning = {
  /** Preferred plaintext bytes per frame; capped by the SCTP max message size. */
  chunkSize: 256 * 1024,
  /** Pause sending while the data channel buffers more than this. */
  highWater: 8 * 1024 * 1024,
  /** Resume sending once the buffer drains below this. */
  lowWater: 2 * 1024 * 1024,
  /** Max bytes sent but not yet acknowledged as written by the receiver. */
  window: 32 * 1024 * 1024,
  /** Receiver acknowledges at least this often (bytes). */
  ackEvery: 1024 * 1024,
  /** Bytes read from disk per File.slice() call (multiple of chunkSize). */
  readBlock: 2 * 1024 * 1024,
  /** Largest plaintext chunk a receiver accepts. */
  maxChunk: 1024 * 1024,
  /** Transfers at least this large stream to OPFS (when available) instead of memory. */
  opfsMinBytes: 32 * 1024 * 1024,
};

/** Frame overhead: 12-byte header + 16-byte GCM tag. */
const OVERHEAD = 28;

export function chunkSizeFor(maxMessageSize: number | null | undefined): number {
  // Unknown / zero means the browser did not tell us; 16 KiB is universally safe.
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : 16 * 1024;
  return Math.max(1024, Math.min(tuning.chunkSize, tuning.maxChunk, limit - OVERHEAD));
}
