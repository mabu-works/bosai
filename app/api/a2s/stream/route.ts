/* bosai — A.A.S proxy: SSE stream relay.
   Opens the upstream /v1/stream with the server-side token and passes the
   event stream through to the browser, which holds no credential.
   The function lifetime is capped at 60 seconds; when it ends, the
   client's EventSource reconnects automatically and the A2S replay (up
   to the `ready` frame) restores continuity, so nothing is lost. */

import { getToken, jsonError, UPSTREAM_BASE } from "@/lib/upstream";

// ⏱️ Maximum function duration in seconds; recovery is by reconnect+replay.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const token = getToken();
  if (!token) {
    return jsonError(500, "a2s_proxy_not_configured");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}/v1/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      // 🔌 Abort the upstream connection when the client disconnects.
      signal: req.signal,
    });
  } catch {
    // 📌 On a client abort the response side is already gone; return an
    // empty 499 instead of an error body.
    if (req.signal?.aborted) return new Response(null, { status: 499 });
    return jsonError(502, "a2s_upstream_unavailable");
  }
  if (!upstream.ok || !upstream.body) {
    return jsonError(upstream.status || 502, "a2s_upstream_error");
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
