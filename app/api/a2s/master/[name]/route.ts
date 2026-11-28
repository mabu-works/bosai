/* bosai — A.A.S proxy: master-data relay.
   Observation points, forecast zones, polygons and similar master data
   are aggregated by A.A.S; the browser fetches them only through this
   same-origin endpoint. Master data changes rarely, so the shared CDN
   cache is long (s-maxage=3600, stale-while-revalidate=86400) to keep
   upstream requests low. Only the dataset names in the A.A.S contract
   (lib/upstream.ts MASTER_DATASETS) are relayed; anything else is
   answered 404 locally without contacting the upstream. */

import { isMasterDataset, jsonError, MASTER_CACHE_CONTROL, relayJson } from "@/lib/upstream";

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await params;
  if (!isMasterDataset(name)) {
    return jsonError(404, "unknown_master_dataset");
  }
  return relayJson(req, `/v1/master/${name}`, MASTER_CACHE_CONTROL);
}
