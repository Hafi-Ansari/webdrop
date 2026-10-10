import { createHmac } from "node:crypto";
import { IceServer, LIMITS } from "@webdrop/shared/protocol";
import * as z from "zod/mini";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";

export type IceProvider = (peerId: string) => Promise<IceServer[]>;

const CloudflareResponse = z.object({ iceServers: z.array(IceServer) });

/**
 * Builds the ICE server list handed to each client in `welcome`.
 *
 * - STUN URLs are public and static.
 * - coturn "TURN REST API": username = "<expiry>:<peerId>",
 *   credential = base64(HMAC-SHA1(secret, username)). The secret never leaves
 *   the server; credentials expire after `ttlSeconds`.
 * - Cloudflare Realtime TURN: short-lived credentials minted via its API and
 *   cached for half their lifetime.
 */
export function createIceProvider(config: Config, log: Logger, fetchImpl: typeof fetch = fetch): IceProvider {
  const stun: IceServer[] = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
  const { turn } = config;

  let cfCache: { servers: IceServer[]; expires: number } | undefined;
  let cfInflight: Promise<IceServer[]> | undefined;

  async function cloudflare(keyId: string, apiToken: string): Promise<IceServer[]> {
    if (cfCache && cfCache.expires > Date.now()) return cfCache.servers;
    cfInflight ??= (async () => {
      try {
        const res = await fetchImpl(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
            body: JSON.stringify({ ttl: turn.ttlSeconds }),
            signal: AbortSignal.timeout(3000),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = CloudflareResponse.safeParse(await res.json());
        if (!parsed.success) throw new Error("unexpected response shape");
        // Browsers cannot use port 53; Cloudflare's docs recommend dropping those URLs.
        const servers = parsed.data.iceServers
          .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
          .filter((s) => s.urls.length > 0);
        cfCache = { servers, expires: Date.now() + (turn.ttlSeconds * 1000) / 2 };
        return servers;
      } catch (err) {
        log.warn("cloudflare turn credentials failed", { error: String(err) });
        return [];
      } finally {
        cfInflight = undefined;
      }
    })();
    return cfInflight;
  }

  return async (peerId: string) => {
    const servers = [...stun];
    if (turn.secret && turn.urls.length) {
      const username = `${Math.floor(Date.now() / 1000) + turn.ttlSeconds}:${peerId}`;
      const credential = createHmac("sha1", turn.secret).update(username).digest("base64");
      servers.push({ urls: turn.urls, username, credential });
    }
    if (turn.cloudflareKeyId && turn.cloudflareApiToken) {
      servers.push(...(await cloudflare(turn.cloudflareKeyId, turn.cloudflareApiToken)));
    }
    return servers.slice(0, LIMITS.maxIceServers);
  };
}
