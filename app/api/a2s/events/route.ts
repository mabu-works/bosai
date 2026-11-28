/* bosai — A.A.S proxy: event list relay.
   The browser only ever sees this same-origin endpoint and holds no
   credential. kind / limit / since are forwarded to the upstream
   /v1/events and the request is authenticated with the server-side token. */

import { relayJson } from "@/lib/upstream";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = new URLSearchParams();
  for (const key of ["kind", "limit", "since"]) {
    const v = url.searchParams.get(key);
    if (v !== null && v !== "") params.set(key, v);
  }
  const qs = params.toString();
  return relayJson(req, `/v1/events${qs ? `?${qs}` : ""}`, "public, s-maxage=5, stale-while-revalidate=10");
}
