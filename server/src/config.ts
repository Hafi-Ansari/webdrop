import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Limits {
  /** Max simultaneous WebSocket connections across the process. */
  maxConnections: number;
  /** Max simultaneous connections from one client IP. */
  maxConnectionsPerIp: number;
  /** New connections per IP: bucket size and refill per second. */
  connectBurst: number;
  connectPerSecond: number;
  /** Messages per connection: bucket size and refill per second. */
  messageBurst: number;
  messagesPerSecond: number;
  /** Rate-limit violations tolerated before the socket is closed. */
  maxViolations: number;
  /** Pair-room join attempts per IP: bucket size and refill per second. */
  joinBurst: number;
  joinPerSecond: number;
  /** Pair rooms created per connection: bucket size and refill per second. */
  createBurst: number;
  createPerSecond: number;
  maxRoomSize: number;
  helloTimeoutMs: number;
  resumeGraceMs: number;
  heartbeatMs: number;
  /** Close a client whose outbound buffer exceeds this many bytes. */
  maxBufferedBytes: number;
}

export interface TurnConfig {
  /** coturn-style "TURN REST API" shared secret (use-auth-secret). */
  secret?: string;
  urls: string[];
  ttlSeconds: number;
  /** Cloudflare Realtime TURN key. */
  cloudflareKeyId?: string;
  cloudflareApiToken?: string;
}

export interface Config {
  host: string;
  port: number;
  staticDir: string;
  /** Exact origins allowed to open /ws. Empty means "same origin as the Host header". */
  allowedOrigins: string[];
  /** Header carrying the client IP set by a trusted edge proxy, e.g. cf-connecting-ip. */
  clientIpHeader?: string;
  /** Number of trusted proxies appending to X-Forwarded-For. 0 = ignore the header. */
  trustProxyHops: number;
  stunUrls: string[];
  turn: TurnConfig;
  limits: Limits;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const defaultLimits: Limits = {
  maxConnections: 20_000,
  maxConnectionsPerIp: 64,
  connectBurst: 30,
  connectPerSecond: 1,
  messageBurst: 200,
  messagesPerSecond: 50,
  maxViolations: 20,
  joinBurst: 10,
  joinPerSecond: 10 / 60,
  createBurst: 5,
  createPerSecond: 5 / 60,
  maxRoomSize: 100,
  helloTimeoutMs: 10_000,
  resumeGraceMs: 15_000,
  heartbeatMs: 30_000,
  maxBufferedBytes: 4 * 1024 * 1024,
};

class ConfigError extends Error {}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedOrigins = list(env.ALLOWED_ORIGINS, []);
  for (const origin of allowedOrigins) {
    const url = URL.parse(origin);
    if (!url || url.origin !== origin) throw new ConfigError(`ALLOWED_ORIGINS entry is not a bare origin: "${origin}"`);
  }

  const clientIpHeader = env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined;
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) throw new ConfigError("CLIENT_IP_HEADER is not a valid header name");

  const stunUrls = list(env.STUN_URLS, ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]);
  const turnUrls = list(env.TURN_URLS, []);
  for (const url of [...stunUrls, ...turnUrls]) {
    if (!/^(stun|stuns|turn|turns):[^\s,]+$/.test(url)) throw new ConfigError(`Invalid ICE URL "${url}"`);
  }
  const turnSecret = env.TURN_SECRET || undefined;
  if (turnSecret && turnUrls.length === 0) throw new ConfigError("TURN_SECRET is set but TURN_URLS is empty");
  const cloudflareKeyId = env.CF_TURN_KEY_ID || undefined;
  const cloudflareApiToken = env.CF_TURN_API_TOKEN || undefined;
  if (Boolean(cloudflareKeyId) !== Boolean(cloudflareApiToken)) {
    throw new ConfigError("CF_TURN_KEY_ID and CF_TURN_API_TOKEN must be set together");
  }

  const logLevel = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) throw new ConfigError("Invalid LOG_LEVEL");

  return {
    host: env.HOST || "0.0.0.0",
    port: int(env, "PORT", 8080, 0, 65535),
    staticDir: path.resolve(repoRoot, env.STATIC_DIR || "web/dist"),
    allowedOrigins,
    clientIpHeader,
    trustProxyHops: int(env, "TRUST_PROXY_HOPS", 0, 0, 10),
    stunUrls,
    turn: {
      secret: turnSecret,
      urls: turnUrls,
      ttlSeconds: int(env, "TURN_TTL_SECONDS", 4 * 3600, 60, 48 * 3600),
      cloudflareKeyId,
      cloudflareApiToken,
    },
    limits: {
      ...defaultLimits,
      maxConnections: int(env, "MAX_CONNECTIONS", defaultLimits.maxConnections, 1, 1_000_000),
      maxConnectionsPerIp: int(env, "MAX_CONNECTIONS_PER_IP", defaultLimits.maxConnectionsPerIp, 1, 10_000),
      maxRoomSize: int(env, "MAX_ROOM_SIZE", defaultLimits.maxRoomSize, 2, 1000),
    },
    logLevel,
  };
}
