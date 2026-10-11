# Security model

WebDrop moves files directly between browsers. The server only introduces peers to each other and relays
connection setup messages. File contents, file names, and transfer metadata never pass through it.

## What protects what

| Layer | Protects against | Mechanism |
|---|---|---|
| WebRTC DTLS | Passive network observers, TURN relays | DTLS 1.2+/SRTP keys negotiated per connection (built into browsers) |
| App-layer E2E | A malicious or compromised signaling server, **if users compare codes** | ECDH P-256 with a hash commitment, HKDF-SHA-256, AES-256-GCM on every control message and file chunk |
| Verification code | Man-in-the-middle by the server | 6-digit code derived from the session keys, shown on both devices |
| Receiver consent | Unwanted files | Every offer needs an explicit Accept; nothing is saved before that |
| Signaling hardening | Abuse of the server | Strict schemas, size limits, per-IP and per-connection rate limits, Origin allow-list |
| Browser hardening | XSS and injection in the app | Strict CSP (no inline code, no eval), Trusted Types, nosniff, no framing |

### Handshake
1. The peer with the lower ID (A) sends `commit = SHA-256("webdrop/v1/commit" || pubA)`.
2. B replies with `pubB`.
3. A reveals `pubA`, and B checks it against the commitment.
4. Both sides compute ECDH and derive keys with HKDF (salt = `SHA-256("webdrop/v1" || pubA || pubB)`):
   one AES-GCM key per direction for control messages, a file master key, and the verification code.

The commitment matters because a man-in-the-middle who controls signaling could otherwise try many key pairs until both
sides showed the same 6-digit code. With the commitment, each side's key is fixed before it sees the other's, so a MITM
matches by chance only (1 in 10^6).

### File frames
- Each accepted attempt derives a fresh key: `HKDF(fileMaster, salt = receiver-chosen random 16 bytes, info = transferId)`.
- The nonce is `fileIndex ‖ chunkIndex`. The 12-byte frame header is authenticated as AAD.
- The receiver rejects any frame that is out of order, oversized, past the declared size, or fails authentication,
  and aborts the transfer. Truncation is detected because each file's final frame is flagged and the declared size must
  match exactly.
- Control messages use counter nonces per direction, so replay, reordering, or dropping a message breaks the link.

## What users need to know
- **Codes are optional but meaningful.** Without comparing them you are protected from everyone except the signaling
  server itself (same as DTLS alone). Comparing them protects you from the server too. This is the same model Signal uses
  for safety numbers.
- **A new connection means a new code.** If a transfer resumes after a dropped connection, a new code is derived.
- **Discovery is by network.** Anyone behind the same public IP (or IPv6 /64) as you can see your random name and send
  you requests. Pairing codes widen this to whoever has the code. Peers learn each other's IP addresses through WebRTC,
  as with any P2P app. Browsers hide local addresses behind mDNS names.

## Server hardening
- **Validation.** Every message is checked against strict zod schemas: unknown keys are rejected, and SDP/candidate
  sizes are capped. Frames are capped at 64 KiB and must be text. Peer IDs are 128-bit random values, and names are
  server-generated.
- **Rate limits.**
  - Concurrent connections per IP: 64.
  - New connections per IP: 30 burst, then 1/s.
  - Messages per connection: 200 burst, then 50/s.
  - Signals delivered to any single peer: 400 burst, then 100/s.
  - Pair-code joins per IP: 10/min.
  - Room creation: 5/min.
  - Repeat offenders are disconnected.
- **Origin.** WebSocket upgrades require an `Origin` that matches the host (or `ALLOWED_ORIGINS`).
- **Client IP.** Proxy headers are ignored unless the operator opts in (`CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS`), so
  clients cannot spoof their way into another network's room.
- **No IPs leave the process.** Network rooms are keyed by an HMAC of the IP prefix with a random per-boot key, and logs
  never contain IPs or tokens.
- **Static files.** These are indexed into memory at startup and served by exact lookup, so path traversal is impossible.
- **No secrets in code.** TURN credentials come from the environment and are handed to clients only as short-lived
  derived credentials.

## Client hardening
- **Filenames** are sanitized: control and bidi characters, path separators, and reserved device names are removed, and
  length is bounded. Files are always saved as `application/octet-stream`.
- **Flow control.** A sender that ignores flow control is cut off once the receiver's unwritten bytes exceed twice the
  window.
- **Offer spam.** At most 3 undecided offers per peer; more are auto-declined.
- **Connection floods.** Sessions created at a peer's request are rate-limited, and at most 32 peer connections are held
  at once.
- **Insecure origins.** The app refuses to run without WebCrypto, which only exists in secure contexts.

## Out of scope / known limits
- A compromised browser or device can read what it receives. E2E protects data in transit, not at the endpoints.
- Room codes have 30 bits of entropy and rely on rate limiting. A large botnet could enumerate active codes; it would
  still need the receiver to accept a file.
- Metadata visible to the server: which random IDs talk to each other, when, and roughly how much signaling they
  exchange. It never sees file names, sizes, or contents.

## Reporting
Please open a private security advisory on the repository rather than a public issue.
