# Decisions

Each decision has a one-line rationale. Versions were checked against the npm registry and web sources on 2026-10-10.

## Repo & tooling
- **Fresh git repo in `new-version/`, branch `main`.** The brief asked for a new directory; a separate history keeps the reference repo untouched.
- **npm workspaces (`shared`, `server`, `web`).** npm ships with Node, so there's no extra package manager to install, and one lockfile covers everything.
- **Node.js 24 LTS (24.21.0), `engines >=24`.** It's the Active LTS today; Node 26 only enters LTS later in October 2026, and the code is compatible with it.
- **TypeScript 6.0.3, not 7.0.** TS 7 (Go-native, GA July 2026) isn't yet supported by typescript-eslint (`<6.1`); 6.0 is the last JS-based release and fully compatible.
- **Server runs `.ts` directly via Node's built-in type stripping.** There's no server build step, and source maps aren't needed; the tsconfig uses `erasableSyntaxOnly` to stay compatible.
- **ESLint 10 + typescript-eslint 8.71 + react-hooks 7.** These are the current maintained versions, and the react-hooks rules catch effect bugs.
- **Vitest 5.0 for unit tests, Playwright 1.64 for e2e and benchmarks.** Both are current. Playwright drives real Chromium, so WebRTC is tested for real.

## Frontend
- **React 19.3 + Vite 8.3 (Rolldown) + @vitejs/plugin-react 6.1.** These were the user's preference and are current; Vite gives a static `dist/` that any host can serve.
- **Tailwind CSS 4.3 via `@tailwindcss/vite`.** The reference used Tailwind; v4 needs no PostCSS config and emits a static CSS file, which works with `style-src 'self'`.
- **lucide-react for icons (replaces react-icons).** It's actively published (Oct 2026), tree-shakable SVG components, and needs no innerHTML.
- **Native `RTCPeerConnection` instead of PeerJS.** PeerJS was last published June 2025, needs its own server, and hides `bufferedAmount`, which backpressure depends on.
- **No state library; `useSyncExternalStore` over a small controller.** That's enough for this app size and avoids a dependency.
- **Native `<dialog>` for modals.** It gives free focus trapping and Esc handling without a dependency.

## Server
- **`ws` 8.22 on a plain `node:http` server (no Express/socket.io).** It's the de-facto minimal WS library and actively maintained; the small dependency surface helps security.
- **zod 4 (`zod/mini`) schemas in `shared/`, used by both server and client.** One source of truth for validation, and the mini build keeps the client bundle small.
- **Same-origin deployment: the server serves `web/dist` and `/ws`.** This removes CORS, makes `connect-src 'self'` possible, and means one free-tier service hosts everything.
- **Static files are indexed in memory at startup, with brotli/gzip precomputed.** No path traversal is possible (only enumerated files are served), and responses are fast.
- **The server assigns names and IDs; clients cannot choose them.** No free-text from peers reaches other users, which prevents impersonation and injection.
- **Peer IDs are 128-bit random (base64url).** They're unguessable, so targeted signal injection without sharing a room is impossible.
- **Resume token (256-bit, hashed server-side) with a 15 s grace period.** A brief network blip keeps the same ID and name, so in-flight transfers can resume.
- **Rooms: automatic "network" room keyed by public IPv4 or IPv6 /64, HMAC'd with a per-boot random key.** This matches the "same network" behaviour, and raw IPs are never exposed to clients.
- **Optional pairing rooms with 6-char server-generated Crockford-base32 codes (30 bits), rate-limited joins.** Devices on different networks can still pair, and brute force is impractical at 10 attempts/min/IP.
- **Delta broadcasts (`peer-joined`/`peer-left`) scoped per room.** That's O(room) fan-out instead of O(all users) on every change.
- **Client IP source is configurable (`CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS`).** Render appends to client-supplied X-Forwarded-For, so trusting it blindly would let clients spoof their way into other networks.
- **Single-instance in-memory hub behind a small interface.** Render's free tier is one instance. Horizontal scale needs room-affinity routing or a pub/sub broker (documented as future work).

## WebRTC & transfer
- **Perfect-negotiation pattern with two negotiated channels (`ctrl` id 0, `data` id 1).** It handles glare deterministically, and control messages never queue behind megabytes of file data.
- **STUN: Google + Cloudflare public servers; TURN optional via coturn shared secret or Cloudflare Realtime TURN API.** No secrets are in code, credentials are short-lived and minted server-side, and Cloudflare's free tier gives 1,000 GB/month.
- **App-layer E2E on top of DTLS: ECDH P-256 + HKDF-SHA-256 + AES-256-GCM.** Every browser supports these in WebCrypto, and they protect file contents even if the signaling server is malicious and the users compare codes.
- **Hash-commitment handshake + 6-digit SAS (like Bluetooth numeric comparison).** Without the commitment, a MITM could grind keys until the short code matched.
- **The SAS is shown on both sides; verification is optional (Signal model).** It's usable by default and strong when users compare codes. The threat model is documented honestly.
- **The receiver must accept every offer; there's no auto-download.** The reference auto-saved anything any peer sent.
- **Per-attempt file keys (salt chosen by the receiver at accept) and nonce = fileIndex‖chunkIndex.** Nonces stay unique even when a transfer resumes or is retried.
- **Backpressure via `bufferedAmountLowThreshold` plus an application ack window.** This bounds memory on both ends and gives safe resume offsets (bytes actually written).
- **Receiver streams to OPFS (`createWritable`) when available, falling back to in-memory Blob parts.** Multi-GB files don't need RAM. Safari has had `createWritable` since Safari 26, so it's feature-detected.
- **Downloads are saved as `application/octet-stream` with a sanitized filename (bidi/control chars stripped).** The browser never renders peer-supplied content, and an RLO character can't disguise an extension.
- **Resume scope: dropped WebRTC/WS connections within the same page session.** File handles can't survive a sender reload in most browsers; cross-reload resume is listed as future work.

## Deploy
- **Render free web service (Docker runtime) via `render.yaml` blueprint.** It's free with no credit card and supports WebSockets; since Feb 2026, WebSocket messages keep the instance awake.
- **Dockerfile (node:24-alpine, non-root, multi-stage).** It runs unchanged on Fly.io, Koyeb, DigitalOcean (GitHub Student Pack credits), Azure Container Apps, or a VM.
- **Vercel is not used.** Vercel functions can't host a long-lived WebSocket server; the same-origin single service is simpler.

## Hardening (milestone 4)
- **Receiver caps unwritten bytes at 2× the ack window.** A malicious sender that ignores flow control would otherwise grow the receiver's memory without bound.
- **Per-target inbound signal budget on the server (2× the per-connection limit).** Many attacker sockets each under their own limit could still flood one victim.
- **Client rate-limits peer-initiated sessions (4 burst, 1 per 5 s per peer) and holds at most 32 connections.** Each `connect`/offer costs the victim an RTCPeerConnection.
- **The token bucket lives in `shared/`.** Server and client use one implementation.
- **Pairing links use the URL fragment (`#pair=CODE`) and also react to `hashchange`.** Fragments never reach servers or logs, and scanning a QR code with the app already open still works.
- **SECURITY.md documents the threat model, including the "codes are optional" caveat.** Honest scope beats an overclaimed "unbreakable E2E".

## Performance (benchmarks in bench/)
- **Default chunk 128 KiB (capped by SCTP max-message-size).** It was marginally fastest in the 64/128/256 KiB sweep (all within noise at ~25–29 MB/s), with fewer messages and crypto calls than 64 KiB, and it fits Chrome/Safari's 256 KiB limit.
- **Send-buffer watermarks 8 MiB / 2 MiB.** A sweep of 2/0.5 to 12/4 showed no significant difference; Chrome closes a channel that buffers past 16 MiB, so stay well below it.
- **One data channel on one connection; no striping.** Measured raw throughput does not scale with parallel RTCPeerConnections (1: 23 MB/s, 2: 23, 4: 20), because Chrome's WebRTC network thread is the bottleneck.
- **OPFS for transfers ≥ 32 MiB.** Benchmarks show no throughput cost vs memory, and it keeps RAM flat for multi-GB files.
