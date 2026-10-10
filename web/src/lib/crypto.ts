/**
 * End-to-end crypto for a peer session, layered on top of WebRTC's DTLS.
 *
 * Handshake (on the `ctrl` data channel; role A = the peer with the lower id):
 *   A -> B  commit = SHA-256("webdrop/v1/commit" || pubA)
 *   B -> A  pubB
 *   A -> B  pubA            (B checks it against the commitment)
 *
 * Both sides then compute ECDH(P-256) and run HKDF-SHA-256 with
 * salt = SHA-256("webdrop/v1" || pubA || pubB). Outputs: one AES-256-GCM key
 * per control direction, a file master key, and a 6-digit SAS.
 *
 * The commitment means A is bound to pubA before seeing pubB, and B picks
 * pubB before seeing pubA. A man-in-the-middle therefore cannot search for
 * key pairs that make both sides show the same code: a mismatch is detected
 * with probability 1 - 10^-6 when users compare codes.
 */
import { concat, equalBytes, utf8 } from "./bytes.ts";

const subtle = globalThis.crypto.subtle;
const PUBLIC_KEY_BYTES = 65; // uncompressed P-256 point

export type Role = "A" | "B";

export interface SessionKeys {
  /** Seals control messages we send. */
  send: CryptoKey;
  /** Opens control messages we receive. */
  recv: CryptoKey;
  /** HKDF base key for per-transfer file keys. */
  fileMaster: CryptoKey;
  /** Short authentication string, formatted "123 456". */
  sas: string;
}

export interface Ephemeral {
  keyPair: CryptoKeyPair;
  pub: Uint8Array<ArrayBuffer>;
}

export async function generateEphemeral(): Promise<Ephemeral> {
  const keyPair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, pub };
}

export async function commitTo(pub: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(utf8("webdrop/v1/commit"), pub)));
}

export async function verifyCommitment(pub: Uint8Array, commitment: Uint8Array): Promise<boolean> {
  return equalBytes(await commitTo(pub), commitment);
}

export async function deriveSessionKeys(role: Role, own: Ephemeral, pubA: Uint8Array, pubB: Uint8Array): Promise<SessionKeys> {
  if (pubA.length !== PUBLIC_KEY_BYTES || pubB.length !== PUBLIC_KEY_BYTES) throw new Error("bad public key length");
  const peerPub = role === "A" ? pubB : pubA;
  if (equalBytes(peerPub, own.pub)) throw new Error("reflected public key");
  // importKey validates that the point is on the curve.
  const peerKey = await subtle.importKey("raw", concat(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: peerKey }, own.keyPair.privateKey, 256);
  const salt = await subtle.digest("SHA-256", concat(utf8("webdrop/v1"), pubA, pubB));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const expand = (info: string, bytes: number) =>
    subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, ikm, bytes * 8);

  const aes = async (info: string) =>
    subtle.importKey("raw", await expand(info, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const [ab, ba, fileMasterBits, sasBits] = await Promise.all([
    aes("webdrop/v1/ctrl a->b"),
    aes("webdrop/v1/ctrl b->a"),
    expand("webdrop/v1/file", 32),
    expand("webdrop/v1/sas", 4),
  ]);
  const fileMaster = await subtle.importKey("raw", fileMasterBits, "HKDF", false, ["deriveKey"]);
  const code = (new DataView(sasBits).getUint32(0) % 1_000_000).toString().padStart(6, "0");
  return {
    send: role === "A" ? ab : ba,
    recv: role === "A" ? ba : ab,
    fileMaster,
    sas: `${code.slice(0, 3)} ${code.slice(3)}`,
  };
}

/**
 * Per-transfer-attempt AES-256-GCM key. `salt` is fresh randomness chosen by
 * the receiver on every accept, so a resumed or retried transfer never reuses
 * a (key, nonce) pair even though chunk indices restart.
 */
export function deriveFileKey(fileMaster: CryptoKey, transferId: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(utf8("webdrop/v1/file-key"), transferId) },
    fileMaster,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const CTRL_AAD = utf8("webdrop/v1/ctrl");

function counterNonce(counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
  return nonce;
}

/**
 * Seals control messages with a monotonically increasing counter nonce. The
 * channel is ordered and reliable, so the receiver tracks the same counter;
 * a replayed, dropped or reordered message fails authentication.
 * Callers must deliver sealed messages in the order `seal` was called.
 */
export class Sealer {
  private counter = 0;
  private readonly key: CryptoKey;
  constructor(key: CryptoKey) {
    this.key = key;
  }
  async seal(plaintext: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
    const iv = counterNonce(this.counter++);
    return subtle.encrypt({ name: "AES-GCM", iv, additionalData: CTRL_AAD }, this.key, plaintext);
  }
}

export class Opener {
  private counter = 0;
  private readonly key: CryptoKey;
  constructor(key: CryptoKey) {
    this.key = key;
  }
  /** Must be called sequentially in arrival order. Throws on tampering. */
  async open(ciphertext: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
    const iv = counterNonce(this.counter++);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: CTRL_AAD }, this.key, ciphertext));
  }
}
