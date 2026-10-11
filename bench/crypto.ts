/**
 * Encryption micro-benchmark (Node's WebCrypto, same code the browser runs):
 * how fast can one core seal/open file frames? Compare with bench/run.ts to
 * see that crypto is not the bottleneck.
 *
 *   node bench/crypto.ts
 */
import { deriveFileKey, deriveSessionKeys, generateEphemeral } from "../web/src/lib/crypto.ts";
import { openFrame, readHeader, sealFrame } from "../web/src/lib/framing.ts";

const a = await generateEphemeral();
const b = await generateEphemeral();
const keys = await deriveSessionKeys("A", a, a.pub, b.pub);
const key = await deriveFileKey(keys.fileMaster, new Uint8Array(16), crypto.getRandomValues(new Uint8Array(16)));

for (const kb of [16, 64, 128, 256]) {
  const chunk = new Uint8Array(kb * 1024);
  const total = 256 * 1024 * 1024;
  const n = total / chunk.byteLength;
  let t = performance.now();
  const frames: ArrayBuffer[] = [];
  // 16 in flight, like the sender's read-ahead.
  for (let i = 0; i < n; i += 16) {
    frames.push(...(await Promise.all(Array.from({ length: Math.min(16, n - i) }, (_, j) => sealFrame(key, { flags: 0, fileIndex: 0, stream: 1, chunkIndex: i + j }, chunk)))));
  }
  const sealMbps = total / 1e6 / ((performance.now() - t) / 1000);
  t = performance.now();
  for (let i = 0; i < frames.length; i += 16) {
    await Promise.all(frames.slice(i, i + 16).map((f) => openFrame(key, readHeader(f)!, f)));
  }
  const openMbps = total / 1e6 / ((performance.now() - t) / 1000);
  console.log(`chunk ${String(kb).padStart(3)} KiB: seal ${sealMbps.toFixed(0)} MB/s, open ${openMbps.toFixed(0)} MB/s`);
}
