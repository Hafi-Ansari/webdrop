import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Config } from "./config.ts";

function normalize(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let ip = raw.trim();
  // Strip brackets / zone ids that some proxies include.
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : undefined;
}

/**
 * Resolve the client's IP. Order: trusted edge header, then X-Forwarded-For
 * counted from the right by the number of trusted hops, then the socket.
 * Client-supplied values are only honoured when the operator opted in.
 */
export function clientIp(req: IncomingMessage, config: Pick<Config, "clientIpHeader" | "trustProxyHops">): string {
  if (config.clientIpHeader) {
    const value = req.headers[config.clientIpHeader];
    const ip = normalize(Array.isArray(value) ? value[0] : value);
    if (ip) return ip;
  }
  if (config.trustProxyHops > 0) {
    const xff = req.headers["x-forwarded-for"];
    const parts = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
    const ip = normalize(parts[parts.length - config.trustProxyHops]);
    if (ip) return ip;
  }
  return normalize(req.socket.remoteAddress) ?? "unknown";
}

/** Expand an IPv6 address into 8 hextets. Assumes `isIP(ip) === 6`. */
function expandV6(ip: string): string[] {
  let [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  // Embedded IPv4 in the last 32 bits.
  const convertV4 = (s: string) => {
    const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (!m?.[1]) return s;
    const [a = 0, b = 0, c = 0, d = 0] = m[1].split(".").map(Number);
    const hex = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)].join(":");
    return s.slice(0, s.length - m[1].length) + hex;
  };
  head = convertV4(head ?? "");
  tail = tail === undefined ? undefined : convertV4(tail);
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => x.padStart(4, "0"));
}

/**
 * Loopback, RFC 1918, link-local and IPv6 ULA addresses. When the server sees
 * these, it is running on the same LAN as its clients (self-hosted / dev), so
 * all of them belong to one network.
 */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) {
    const hextets = expandV6(ip);
    const first = parseInt(hextets[0] ?? "0", 16);
    const all = hextets.join("");
    return all === "0".repeat(31) + "1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * The "network" a client belongs to for discovery: a public IPv4 address, or
 * an IPv6 /64 (one LAN usually shares a /64 while each device has its own
 * address). The key is HMAC'd with a per-process secret so it is useless
 * outside this process and never reveals the address in logs.
 */
export function createNetworkKeyer(secret: Buffer = randomBytes(32)): (ip: string) => string {
  return (ip: string) => {
    let prefix: string;
    if (isPrivate(ip)) prefix = "lan";
    else if (isIP(ip) === 6) prefix = "6:" + expandV6(ip).slice(0, 4).join(":");
    else if (isIP(ip) === 4) prefix = "4:" + ip;
    else prefix = "?:" + ip;
    return createHmac("sha256", secret).update(prefix).digest("base64url").slice(0, 22);
  };
}
