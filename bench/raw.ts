/**
 * Baseline: raw RTCDataChannel throughput with no encryption or protocol,
 * using the same backpressure scheme, between two separate browser processes
 * (like two devices). Shows how close the real pipeline gets to what the
 * browser itself can do.
 *
 *   node bench/raw.ts --size 256 --chunks 16,64,256
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const sizeMb = Number(args.get("size") ?? 256);
const chunks = (args.get("chunks") ?? "16,64,256").split(",").map(Number);

const dirs: string[] = [];

/** One persistent profile per side, each in its own browser process (like two devices). */
async function side(): Promise<Page> {
  const dir = mkdtempSync(path.join(tmpdir(), "webdrop-raw-"));
  dirs.push(dir);
  const ctx = await chromium.launchPersistentContext(dir, { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("about:blank");
  await page.evaluate(() => {
    const w = window as any;
    w.pc = new RTCPeerConnection();
    w.cands = [];
    w.pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => e.candidate && w.cands.push(e.candidate.toJSON());
    w.dc = w.pc.createDataChannel("d", { negotiated: true, id: 1 });
    w.dc.binaryType = "arraybuffer";
  });
  return page;
}

for (const kb of chunks) {
  const tx = await side();
  const rx = await side();
  const offer = await tx.evaluate(async () => {
    const w = window as any;
    await w.pc.setLocalDescription();
    return w.pc.localDescription.toJSON();
  });
  const answer = await rx.evaluate(async (o) => {
    const w = window as any;
    await w.pc.setRemoteDescription(o);
    await w.pc.setLocalDescription();
    return w.pc.localDescription.toJSON();
  }, offer);
  await tx.evaluate((a) => (window as any).pc.setRemoteDescription(a), answer);
  await new Promise((r) => setTimeout(r, 300));
  const [c1, c2] = await Promise.all([tx.evaluate(() => (window as any).cands), rx.evaluate(() => (window as any).cands)]);
  await rx.evaluate(async (cs) => { for (const c of cs) await (window as any).pc.addIceCandidate(c); }, c1);
  await tx.evaluate(async (cs) => { for (const c of cs) await (window as any).pc.addIceCandidate(c); }, c2);
  await tx.waitForFunction(() => (window as any).dc.readyState === "open");

  const bytes = sizeMb * 1024 * 1024;
  const received = rx.evaluate(
    (bytes) =>
      new Promise<void>((resolve) => {
        let got = 0;
        (window as any).dc.onmessage = (e: MessageEvent) => {
          got += (e.data as ArrayBuffer).byteLength;
          if (got >= bytes) resolve();
        };
      }),
    bytes,
  );
  const start = Date.now();
  await tx.evaluate(
    async ({ kb, bytes }) => {
      const dc = (window as any).dc as RTCDataChannel;
      dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;
      const chunk = new Uint8Array(kb * 1024);
      for (let sent = 0; sent < bytes; sent += chunk.byteLength) {
        if (dc.bufferedAmount > 8 * 1024 * 1024) await new Promise((r) => (dc.onbufferedamountlow = r));
        dc.send(chunk);
      }
    },
    { kb, bytes },
  );
  await received;
  const mbps = bytes / 1e6 / ((Date.now() - start) / 1000);
  console.log(`raw chromium→chromium datachannel, chunk ${kb} KiB: ${mbps.toFixed(1)} MB/s`);
  await tx.context().close();
  await rx.context().close();
}
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
