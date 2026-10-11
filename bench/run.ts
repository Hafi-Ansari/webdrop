/**
 * Throughput benchmark over real WebRTC between two headless browsers.
 *
 *   npm run bench                      # default sweep
 *   npm run bench -- --size 512 --chunks 16,64,256 --browsers chromium:chromium
 *
 * Builds the e2e bundle, starts the server, opens two browser contexts, sends
 * a synthetic in-memory file and reports MB/s (sender-side, accept -> done,
 * i.e. including encryption, transport, decryption and receiver writes).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "@playwright/test";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const sizeMb = Number(args.get("size") ?? 256);
const chunksKb = (args.get("chunks") ?? "16,64,128,256").split(",").map(Number);
const runs = Number(args.get("runs") ?? 2);
/** "opfs" (default for large files) or "memory". */
const sink = args.get("sink") ?? "opfs";
/** Send-buffer watermarks in MiB, e.g. --water 8:2 */
const [highMb, lowMb] = (args.get("water") ?? "8:2").split(":").map(Number) as [number, number];
const browserPairs = (args.get("browsers") ?? "chromium:chromium").split(",").map((p) => p.split(":") as [string, string]);
const PORT = Number(args.get("port") ?? 4180);
const base = `http://localhost:${PORT}`;

/**
 * Each "device" is a persistent profile in its own browser process, like a
 * real device: disk-backed storage and its own WebRTC network thread.
 * (Private contexts have a small, memory-backed storage quota.)
 */
const launchers: Record<string, (dir: string) => Promise<BrowserContext>> = {
  chromium: (dir) => chromium.launchPersistentContext(dir, { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"], acceptDownloads: false }),
  firefox: (dir) =>
    firefox.launchPersistentContext(dir, { firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false }, acceptDownloads: false }),
  webkit: (dir) => webkit.launchPersistentContext(dir, { acceptDownloads: false }),
};

async function startServer(): Promise<ChildProcess> {
  execFileSync("npm", ["run", "build"], { stdio: "inherit", env: { ...process.env, VITE_E2E: "1", VITE_OUT_DIR: "dist-e2e" } });
  const proc = spawn(process.execPath, ["server/src/index.ts"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", STATIC_DIR: "web/dist-e2e", STUN_URLS: "", LOG_LEVEL: "warn" },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return proc;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function open(engine: string): Promise<{ page: Page; id: string; close(): Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "webdrop-bench-"));
  const ctx = await launchers[engine]!(dir);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(base);
  await page.waitForFunction(() => (window as any).__webdrop?.controller.store.get().self);
  const id = await page.evaluate(() => (window as any).__webdrop.controller.store.get().self.id as string);
  return {
    page,
    id,
    close: async () => {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function once(sender: Page, receiver: Page, receiverId: string, chunkKb: number): Promise<{ mbps: number; chunk: number }> {
  for (const p of [sender, receiver]) {
    await p.evaluate(
      ({ kb, memory, high, low }) => {
        const t = (window as any).__webdrop.tuning;
        t.chunkSize = kb * 1024;
        t.highWater = high * 1024 * 1024;
        t.lowWater = low * 1024 * 1024;
        if (memory) t.opfsMinBytes = Number.MAX_SAFE_INTEGER;
      },
      { kb: chunkKb, memory: sink === "memory", high: highMb, low: lowMb },
    );
  }
  await sender.waitForFunction((id) => (window as any).__webdrop.controller.store.get().peers.some((p: any) => p.id === id), receiverId);
  const accepted = receiver.evaluate(async () => {
    const c = (window as any).__webdrop.controller;
    for (;;) {
      const prompt = c.store.get().prompts[0];
      if (prompt) return c.accept(prompt.id);
      await new Promise((r) => setTimeout(r, 2));
    }
  });
  const result = sender.evaluate(
    async ({ id, bytes }) => {
      const c = (window as any).__webdrop.controller;
      const file = new File([new Uint8Array(bytes)], "bench.bin");
      c.sendFiles(id, [file]);
      const t = [...c.transfers.outgoing.values()].at(-1);
      let start = 0;
      for (;;) {
        if (!start && t.state === "active") start = performance.now();
        if (t.isFinal) break;
        await new Promise((r) => setTimeout(r, 1));
      }
      if (t.state !== "done") throw new Error(`transfer ${t.state}: ${t.error}`);
      return { seconds: (performance.now() - start) / 1000, chunk: (window as any).__webdrop.tuning.chunkSize };
    },
    { id: receiverId, bytes: sizeMb * 1024 * 1024 },
  );
  await accepted;
  const r = await result.catch(async (err: unknown) => {
    const why = await receiver.evaluate(() => {
      const ts = [...(window as any).__webdrop.controller.transfers.incoming.values()];
      return ts.map((t: any) => `${t.state}: ${t.error}`).join("; ");
    });
    throw new Error(`${String(err)} | receiver: ${why}`);
  });
  return { mbps: (sizeMb * 1.048576) / r.seconds, chunk: r.chunk };
}

const server = await startServer();
const rows: Array<{ pair: string; chunkKb: number; mbps: number[] }> = [];
try {
  for (const [from, to] of browserPairs) {
    for (const chunkKb of chunksKb) {
      const sender = await open(from!);
      const receiver = await open(to!);
      try {
        const mbps: number[] = [];
        for (let i = 0; i < runs; i++) mbps.push((await once(sender.page, receiver.page, receiver.id, chunkKb)).mbps);
        rows.push({ pair: `${from}→${to}`, chunkKb, mbps });
        console.log(`${from}→${to} chunk ${chunkKb} KiB (${sink}): ${mbps.map((m) => m.toFixed(1)).join(", ")} MB/s`);
      } finally {
        await sender.close();
        await receiver.close();
      }
    }
  }
} finally {
  server.kill();
}

const lines = [
  `# Benchmark ${new Date().toISOString()}`,
  "",
  `${sizeMb} MiB synthetic file, ${runs} run(s) each, receiver sink: ${sink}, send buffer ${highMb}/${lowMb} MiB, persistent profiles, loopback on ${process.platform}/${process.arch}.`,
  "",
  "| browsers | chunk | MB/s (best) | runs |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.pair} | ${r.chunkKb} KiB | ${Math.max(...r.mbps).toFixed(1)} | ${r.mbps.map((m) => m.toFixed(1)).join(", ")} |`),
];
mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/latest.md", lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
