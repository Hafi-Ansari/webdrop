# WebDrop v2 — Plan

A ground-up rebuild of Web-Drop (AirDrop-style browser file sharing). Feature parity with the
reference (`../Web-Drop`): nearby-device discovery, random usernames, P2P file transfer over WebRTC.
Priorities: **security > transfer speed > scalability**.

## What changes vs. the reference

| Area | Reference | v2 |
|---|---|---|
| Discovery | Every connected client sees every other client, globally | Peers grouped by public network (same public IPv4 / IPv6 /64), plus optional pairing rooms joined by a short code |
| Identity | Client picks its own name and peer ID | Server assigns a random name and an unguessable peer ID. A resume token keeps them stable across reconnects |
| Signaling | socket.io + separate PeerJS server | One small WebSocket server (`ws`) that relays SDP/ICE only between peers who share a room |
| Transfer | Whole file as one message; receiver auto-downloads anything | Chunked, encrypted, backpressured stream. The receiver must accept, partial transfers resume after a dropped connection, and large files stream to disk (OPFS) |
| Crypto | DTLS only (signaling server could MITM) | DTLS **plus** an app-layer E2E channel: ECDH P-256 with a hash commitment, HKDF, AES-256-GCM per chunk, and a 6-digit verification code both users can compare |
| Hardening | `cors: *`, no validation, no limits | Strict schema validation, size limits, per-IP and per-connection rate limits, an Origin allow-list, strict CSP with Trusted Types, security headers |
| Deploy | Vercel + hand-managed EC2 | One container that serves the static app and signaling on the same origin. Render free tier blueprint, plus a Dockerfile for any host |

## Architecture

```
new-version/
  shared/     protocol schemas + limits (zod/mini) shared by server and web
  server/     Node 24 (native TS type-stripping, no build step)
              http: static files + security headers + /healthz
              ws:   /ws signaling — rooms, relay, rate limiting, resume
  web/        React 19 + Vite 8 + Tailwind 4
              lib/signaling   reconnecting WS client
              lib/peer        RTCPeerConnection, perfect negotiation, negotiated channels
              lib/secure      handshake, key schedule, sealing (WebCrypto)
              lib/transfer    sender / receiver / framing / sinks (OPFS, memory)
              ui/             components
  e2e/        Playwright two-browser tests
  bench/      throughput benchmark (real browsers over WebRTC) + crypto microbench
```

### Signaling protocol (JSON over WebSocket, ≤64 KiB per frame)
- C→S: `hello{device, resume?}` (must be the first message, sent within 10 s), `signal{to, payload}`, `room-create`, `room-join{code}`, `room-leave`, `ping`
- S→C: `welcome{self, resume, iceServers, rooms}`, `peers{room, peers}`, `peer-joined`, `peer-left`, `signal{from, payload}`, `room`, `room-left`, `error{code}`, `pong`
- The server relays a signal only if the sender and target share a room. It sends per-room deltas instead of full-list broadcasts.

### Peer protocol (inside WebRTC; DTLS-protected, and E2E-sealed on top)
1. Two negotiated data channels: `ctrl` (id 0, JSON) and `data` (id 1, binary frames).
2. Handshake on `ctrl`: the lower peer ID (A) sends `commit = SHA-256(pubA)`. B replies with `pubB`, then A reveals `pubA`.
   Both sides derive keys from ECDH using HKDF with salt = transcript hash. The SAS (6 digits) comes from the same key schedule.
   The commitment stops a man-in-the-middle from grinding keys until the SAS matches.
3. Sealed control messages (AES-GCM, per-direction keys, counter nonces): `offer`, `accept{salt, resume}`, `decline`, `cancel`, `ack`, `file-end`, `done`.
4. Data frames: a 12-byte header (`ver, flags, fileIndex, streamId, chunkIndex`) used as AAD, followed by AES-GCM ciphertext.
   Each attempt uses its own key, derived with the receiver-chosen salt, so nonces never repeat.

### Speed
- Chunk size is `min(preferred, sctp.maxMessageSize − overhead)`. The benchmark picks the default.
- Backpressure uses `bufferedAmountLowThreshold` with high/low watermarks. An application-level ack window caps unwritten bytes at the receiver.
- The sender reads ahead and encrypts in parallel. The receiver decrypts in parallel and writes in order.
- Resume: on channel loss, both sides keep their transfer state. When the session is re-established, the sender re-offers the same transfer ID and the receiver auto-accepts with the byte offsets it already wrote.

## Milestones (each ends with build + tests green, then a git commit)
1. PLAN.md, DECISIONS.md, workspace scaffold
2. Signaling server + unit/integration tests
3. Frontend + transfer path (crypto, peer, transfer engine, UI)
4. Security hardening pass (CSP/headers, limits, sanitization, audit)
5. Tests: web unit tests, Playwright e2e (transfer, decline, resume, CSP), benchmark
6. Docker + Render blueprint + docs (README, STATUS)
