# WebDrop

AirDrop-style file sharing in the browser. Open the page on two devices on the same network and they find each
other. Click a device to send files straight to it over WebRTC, end-to-end encrypted and peer-to-peer. The server
only introduces devices; files never touch it.

This is a ground-up rebuild of the original Web-Drop (`../Web-Drop`). It keeps the same three features (nearby
discovery, random names, P2P transfer) and fixes the original's main weaknesses. The original had global discovery,
no consent, whole-file-in-memory transfers, no validation or limits, and a server that could silently read files by
intercepting the connection. See [PLAN.md](PLAN.md) for the architecture, [SECURITY.md](SECURITY.md) for the threat
model, and [DECISIONS.md](DECISIONS.md) for every choice with its rationale.

## Highlights
- **Nearby discovery.** Devices behind the same public IP (or IPv6 /64) see each other. A 6-character pairing code
  (with QR code) connects devices on different networks.
- **Random names** like *Rowdy Outlaw*, assigned by the server and kept across reloads and reconnects.
- **End-to-end encryption on top of WebRTC's DTLS.** ECDH P-256 with a hash commitment, HKDF, and AES-256-GCM per
  chunk. A 6-digit verification code is shown on both screens. The receiver must accept every transfer.
- **Fast, bounded-memory transfers.** Chunked stream with read-ahead, parallel encryption, and two-level backpressure.
  Large files stream to disk (OPFS), so multi-GB files don't need RAM.
- **Resumable.** If the connection drops mid-transfer, it reconnects and continues from the last byte written.
- **Hardened.** Strict schemas, per-IP and per-connection rate limits, an Origin allow-list, and a strict CSP with
  Trusted Types. The server has two runtime dependencies (`ws`, `zod`).

## Run it locally

You need **Node.js 24 LTS** (`brew install node@24 && brew link --force node@24` on macOS).

```bash
cd new-version
npm install
npm run dev
```

Open <http://localhost:5173> in two browser windows (use a private window for the second, so it gets its own
identity). Both appear as nearby devices. Click one to send a file.

`npm run dev` runs the signaling server on :8080 with auto-restart, plus Vite with hot reload, which proxies `/ws` to
the server.

### Production build locally
```bash
npm run build      # builds web/dist
npm start          # serves the app + signaling on http://localhost:8080
```

### Testing on your phone
Browsers only expose the Web Crypto API on HTTPS (or `localhost`), so `http://192.168.x.x` won't work from a phone.
The quickest fix is a free, account-less Cloudflare quick tunnel:

```bash
npm run build && npm start                     # terminal 1
brew install cloudflared
cloudflared tunnel --url http://localhost:8080 # terminal 2: prints https://<random>.trycloudflare.com
```

Open the printed URL on your laptop and phone. Through the tunnel, every client appears to come from localhost, so all
devices are grouped together, which is fine for testing. For real use, deploy it as described below.

## Deploy (free)

### Render (recommended: free, no credit card, one service)
Render's free web services support WebSockets and, since February 2026, stay awake while WebSocket messages flow. The
included [`render.yaml`](render.yaml) blueprint deploys the Docker image as a single free web service, which serves
both the app and signaling on one HTTPS origin.

1. Push this folder to its own GitHub repository (`new-version` must be the repository root):
   ```bash
   cd new-version
   gh repo create webdrop --private --source . --push   # or create the repo on github.com and git push
   ```
2. On <https://dashboard.render.com>, go to **New → Blueprint**, pick the repository, and click **Apply**.
3. Wait for the build (about 2–3 minutes), then open `https://webdrop-xxxx.onrender.com`.
4. **Check discovery is per-network.** In the service's **Logs**, find the `client ip source` line. It should say
   `"source":"header"`. If it says `"socket"`, Render didn't send `cf-connecting-ip`. Then set
   `CLIENT_IP_HEADER=true-client-ip`, or remove it and set `TRUST_PROXY_HOPS=1`, under **Environment**.

Free instances sleep after 15 minutes without traffic. The first visit after that takes about a minute to wake up.

**Optional TURN relay.** For devices behind strict NATs (some mobile carriers and corporate networks), create a free
Cloudflare Realtime TURN key (1,000 GB/month free). Then set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` in Render. The
server mints short-lived credentials, and the secret never reaches browsers.

### Anywhere Docker runs
```bash
docker build -t webdrop .
docker run -p 8080:8080 --read-only --cap-drop ALL --security-opt no-new-privileges webdrop
```
Put it behind HTTPS (any PaaS does this for you). The same image works on Fly.io, Koyeb, Railway, Google Cloud Run,
Azure Container Apps (GitHub Student Pack credit), DigitalOcean App Platform (Student Pack credit, if your pack still
lists it), or a VM. If a proxy sits in front, set `CLIENT_IP_HEADER` or `TRUST_PROXY_HOPS` (see below).

**Why not Vercel?** Vercel's serverless functions can't hold the long-lived WebSocket that signaling needs. You could
host only the static frontend there, but then you'd run a second service for signaling and a cross-origin setup. One
container is simpler and safer.

## Configuration
All variables are optional; see [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |
| `ALLOWED_ORIGINS` | *(same origin)* | Comma-separated exact origins allowed to open `/ws` |
| `CLIENT_IP_HEADER` | — | Header set by a trusted edge proxy with the client IP (e.g. `cf-connecting-ip`) |
| `TRUST_PROXY_HOPS` | `0` | Trusted proxies appending to `X-Forwarded-For` |
| `STUN_URLS` | Cloudflare + Google | Comma-separated; empty disables STUN |
| `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS` | — | coturn `use-auth-secret` relay |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | — | Cloudflare Realtime TURN |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `MAX_ROOM_SIZE` | `20000`, `64`, `100` | Limits |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (watch) + Vite dev server |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run check` | Typecheck + lint + unit tests |
| `npm test` | Unit and integration tests (Vitest, 113 tests) |
| `npm run test:e2e` | Playwright end-to-end tests over real WebRTC (first run: `npx playwright install`) |
| `npm run bench` | Throughput benchmark between two real browsers (see below) |
| `node bench/raw.ts` | Baseline: raw, unencrypted data channel throughput |
| `node bench/crypto.ts` | AES-GCM frame sealing/opening speed |

## Benchmarks
Measured on an Apple Silicon Mac. Headless Chromium to Chromium over loopback, each "device" a separate browser
process with its own profile, 256 MiB file streamed to OPFS on the receiver. Raw results are in
[`bench/results/`](bench/results/).

| | Throughput |
|---|---|
| WebDrop (encrypted, end to end, written to disk), warm connection | **~75–81 MB/s** |
| WebDrop, first transfer on a fresh connection (SCTP slow start) | ~46–54 MB/s |
| Raw unencrypted RTCDataChannel, fresh connection, same setup | ~46–51 MB/s |
| AES-GCM frame sealing alone, one core (`bench/crypto.ts`) | ~3,600 MB/s |

The encrypted pipeline runs at the browser's own data-channel speed; encryption costs essentially nothing. On real
Wi-Fi the network is the limit. The numbers swing with background load: the same runs measured 25–30 MB/s while other
heavy apps were busy. Parallel peer connections don't raise Chrome's ceiling (measured), so WebDrop uses one.
Playwright's WebKit build is much slower (~4 MB/s even raw), so measure Safari on a real device.

Try other settings: `npm run bench -- --size 512 --chunks 64,128,256 --runs 3 --sink memory --water 8:2`.

## Project layout
```
shared/   protocol schemas (zod) and the token bucket, used by server and web
server/   Node 24 signaling + static server (runs TypeScript directly, no build step)
web/      React 19 + Vite 8 + Tailwind 4 app
  src/lib/  signaling, WebRTC session, secure link (handshake/crypto), transfer engine, sinks
  src/ui/   components
e2e/      Playwright tests (transfer, decline, resume, pairing, security, cross-browser)
bench/    benchmarks
```

See [STATUS.md](STATUS.md) for what's done and what's left.

## License

[MIT](LICENSE)
