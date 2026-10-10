import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";

/**
 * Content-Security-Policy for the app. Everything is same-origin; no inline
 * script or style, no eval, no plugins, no framing, and Trusted Types are
 * enforced so DOM XSS sinks (innerHTML, etc.) throw.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "origin-agent-cluster": "?1",
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt"]);

interface Asset {
  body: Buffer;
  br?: Buffer;
  gzip?: Buffer;
  type: string;
  etag: string;
  cacheControl: string;
}

/**
 * Indexes every file under `root` into memory at startup. Requests are
 * answered by exact map lookup, so path traversal is impossible and no
 * filesystem access happens per request. The built app is a few hundred KB.
 */
export function createStaticHandler(root: string) {
  const assets = new Map<string, Asset>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).size < 10 * 1024 * 1024) {
        const ext = path.extname(entry.name).toLowerCase();
        const type = TYPES[ext];
        if (!type) continue;
        const body = readFileSync(full);
        const urlPath = "/" + path.relative(root, full).split(path.sep).join("/");
        const asset: Asset = {
          body,
          type,
          etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
          // Vite fingerprints everything under /assets; everything else must revalidate.
          cacheControl: urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        };
        if (COMPRESSIBLE.has(ext) && body.length > 512) {
          asset.br = brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } });
          asset.gzip = gzipSync(body, { level: 9 });
        }
        assets.set(urlPath, asset);
      }
    }
  };
  try {
    walk(root);
  } catch {
    // No build present (e.g. dev mode, where Vite serves the app).
  }
  const index = assets.get("/index.html");
  if (index) assets.set("/", index);

  return {
    size: assets.size,
    /** Returns false when no asset matches (caller sends 404). */
    serve(req: IncomingMessage, res: ServerResponse): boolean {
      const pathname = URL.parse(req.url ?? "/", "http://x")?.pathname ?? "/";
      const asset = assets.get(pathname);
      if (!asset) return false;

      res.setHeader("content-type", asset.type);
      res.setHeader("cache-control", asset.cacheControl);
      res.setHeader("etag", asset.etag);
      res.setHeader("vary", "accept-encoding");
      if (req.headers["if-none-match"] === asset.etag) {
        res.statusCode = 304;
        res.end();
        return true;
      }
      const accept = String(req.headers["accept-encoding"] ?? "");
      let body = asset.body;
      if (asset.br && /\bbr\b/.test(accept)) {
        body = asset.br;
        res.setHeader("content-encoding", "br");
      } else if (asset.gzip && /\bgzip\b/.test(accept)) {
        body = asset.gzip;
        res.setHeader("content-encoding", "gzip");
      }
      res.setHeader("content-length", body.length);
      res.statusCode = 200;
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    },
  };
}
