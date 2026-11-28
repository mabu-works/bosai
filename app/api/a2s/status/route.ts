/* bosai — A.A.S proxy: status relay.
   Fetches the upstream /v1/status with the server-side token. */

import { relayJson } from "@/lib/upstream";

export async function GET(req: Request): Promise<Response> {
  return relayJson(req, "/v1/status", "public, s-maxage=15, stale-while-revalidate=30");
}
