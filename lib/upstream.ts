/* bosai — shared parts of the A.A.S (A2S) proxy. SERVER SIDE ONLY.
   The access token lives exclusively in the A2S_TOKEN environment
   variable on the host. Its value must never be written to a response,
   a log, or any client-visible artifact. Only Route Handlers may import
   this module. */

export const UPSTREAM_BASE = "https://a2s.taildf0a89.ts.net";

// 📋 Master-data datasets the proxy will relay (exactly the sets in the
// A.A.S contract for /v1/master/<name>). Anything else is refused locally.
export const MASTER_DATASETS = [
  "stations",
  "station-prefs",
  "tsunami-stations",
  "tsunami-zones",
  "coastline",
  "eew-polygons",
  "volcanoes",
  "rivers",
  "amedas",
] as const;

export type MasterDataset = (typeof MASTER_DATASETS)[number];

export function isMasterDataset(name: string): name is MasterDataset {
  return (MASTER_DATASETS as readonly string[]).includes(name);
}

// 🗃️ Master data changes rarely, so it gets a long shared cache.
export const MASTER_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

// 🔑 Read the token from the environment (null when unset or empty).
export function getToken(env: Record<string, string | undefined> = process.env): string | null {
  const t = env?.A2S_TOKEN;
  return typeof t === "string" && t.length > 0 ? t : null;
}

// 📤 JSON error response, never cached.
export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// 📥 Fetch an upstream JSON endpoint with the token attached and pass the
// status and body through unchanged. The caller picks the shared CDN
// cache directive: short caches keep every visitor from consuming the
// upstream per-token rate limit (60 requests/minute) individually.
export async function relayJson(req: Request, upstreamPath: string, cacheControl: string): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  }
  const token = getToken();
  if (!token) {
    return jsonError(500, "a2s_proxy_not_configured");
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}${upstreamPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return jsonError(502, "a2s_upstream_unavailable");
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}
