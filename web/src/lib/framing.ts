/**
 * Binary data frames on the `data` channel:
 *
 *   0      1      2..3        4..7      8..11        12..
 *   ver    flags  fileIndex   stream    chunkIndex   AES-GCM(ciphertext || tag)
 *
 * The 12-byte header is the AAD, so it cannot be altered. The nonce is
 * fileIndex (u32) || chunkIndex (u64), unique within one transfer attempt's
 * key. Chunk indices count from 0 at the resume offset of each file.
 */
export const FRAME_VERSION = 1;
export const HEADER_BYTES = 12;
export const TAG_BYTES = 16;
export const FLAG_LAST = 0x01;

export interface FrameHeader {
  flags: number;
  fileIndex: number;
  stream: number;
  chunkIndex: number;
}

function nonceFor(fileIndex: number, chunkIndex: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  const v = new DataView(nonce.buffer);
  v.setUint32(0, fileIndex);
  v.setBigUint64(4, BigInt(chunkIndex));
  return nonce;
}

export function writeHeader(h: FrameHeader): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint8(0, FRAME_VERSION);
  v.setUint8(1, h.flags);
  v.setUint16(2, h.fileIndex);
  v.setUint32(4, h.stream);
  v.setUint32(8, h.chunkIndex);
  return out;
}

export function readHeader(frame: ArrayBuffer): FrameHeader | null {
  if (frame.byteLength < HEADER_BYTES + TAG_BYTES) return null;
  const v = new DataView(frame, 0, HEADER_BYTES);
  if (v.getUint8(0) !== FRAME_VERSION) return null;
  const flags = v.getUint8(1);
  if (flags & ~FLAG_LAST) return null;
  return { flags, fileIndex: v.getUint16(2), stream: v.getUint32(4), chunkIndex: v.getUint32(8) };
}

export async function sealFrame(key: CryptoKey, h: FrameHeader, plaintext: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const header = writeHeader(h);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceFor(h.fileIndex, h.chunkIndex), additionalData: header },
    key,
    plaintext,
  );
  const frame = new Uint8Array(HEADER_BYTES + ct.byteLength);
  frame.set(header, 0);
  frame.set(new Uint8Array(ct), HEADER_BYTES);
  return frame.buffer;
}

/** Throws if the frame was tampered with or encrypted under a different key. */
export async function openFrame(key: CryptoKey, h: FrameHeader, frame: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceFor(h.fileIndex, h.chunkIndex), additionalData: new Uint8Array(frame, 0, HEADER_BYTES) },
    key,
    new Uint8Array(frame, HEADER_BYTES),
  );
  return new Uint8Array(pt);
}
