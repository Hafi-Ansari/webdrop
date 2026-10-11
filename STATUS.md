# Status

Last updated 2026-10-10. Every milestone in [PLAN.md](PLAN.md) is done and committed on `main`.

## Finished

| Milestone | State | Evidence |
|---|---|---|
| 1. Plan | ✅ | PLAN.md, DECISIONS.md |
| 2. Signaling server | ✅ | Network rooms (IPv4 / IPv6 /64 / LAN), pairing codes, relay only within shared rooms, resume tokens with grace period, short-lived TURN credentials, static server. 56 server tests |
| 3. Frontend + transfer path | ✅ | React UI; native WebRTC; commitment handshake + verification code; encrypted chunked frames; read-ahead, parallel crypto, two-level backpressure; OPFS streaming; automatic resume |
| 4. Security hardening | ✅ | Strict CSP + Trusted Types, security headers, Origin checks, layered rate limits, flow-control bound, offer/session flood limits, filename sanitizing. [SECURITY.md](SECURITY.md) |
| 5. Tests | ✅ | 113 unit/integration tests (Vitest), 13 Playwright e2e tests over real WebRTC (10 run locally; the 3 Firefox interop tests skip here), benchmarks in `bench/` |
| 6. Docker / deploy | ✅ | Dockerfile verified locally (built, run read-only with all capabilities dropped, e2e suite passed against it), `render.yaml`, GitHub Actions CI |
| README / STATUS | ✅ | This file, [README.md](README.md) |

### Verified end to end (Chromium, real WebRTC)
- Discovery on the same network, with identical verification codes on both sides
- Single and multi-file transfers (including empty files), SHA-256 identical after download
- Decline: nothing is saved
- Resume after the peer connection is killed mid-transfer (64 MiB); continues and completes intact
- Signaling WebSocket drop mid-transfer: the transfer is unaffected and identities are kept
- Pairing by code and by `#pair=` link (QR)
- No CSP violations during use; `innerHTML` and inline scripts are blocked; cross-origin WebSocket refused
- Chromium → WebKit interop
- Repeated 256 MiB transfers (4 per session) stream to disk at ~75–81 MB/s, and storage is reclaimed by evicting already-saved files

## Not finished / known gaps
- **Firefox not exercised locally.** Playwright's Firefox build fails to launch on this Mac (macOS 27: "Could not find
  profile folder"), so the Firefox interop tests skip here. CI runs them on Ubuntu; check the first CI run.
- **Real Safari / iOS / Android devices not tested.** Only Playwright's WebKit build was tested, and its data channel
  is slow (~4 MB/s raw), so measure real Safari on a device. OPFS `createWritable` is feature-detected (Safari 26+);
  older Safari falls back to memory.
- **Render client-IP header unverified.** `render.yaml` uses `CLIENT_IP_HEADER=cf-connecting-ip`. Confirm with the
  `client ip source` log line after the first deploy (README, Deploy, step 4). If it's wrong, every Render user lands in
  one shared "network".
- **Resume does not survive a page reload on the sending side.** Browsers can't persist `File` handles; only
  connection drops within the same page session resume.
- **Single instance only.** Rooms live in memory. Running several instances needs room-affinity routing (e.g. a
  consistent hash on the network key) or a pub/sub broker behind the `Hub`. That's a non-issue on Render's free tier
  (one instance).
- **Verification is opt-in.** Codes are shown on both sides, but there's no "mark as verified" state or "only send
  to verified devices" setting yet.
- **TypeScript 7.** Pinned to 6.0.3 until typescript-eslint supports TS 7.

## Ideas for later
- Relay-only (TURN) privacy mode that hides IPs from peers
- Folder drag-and-drop, image previews, PWA install + share target
- Persisted "trusted devices" (would need long-term identity keys)
- Cloudflare Workers + Durable Objects adapter for the hub (global, no cold starts)
