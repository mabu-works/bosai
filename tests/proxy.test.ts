/* Tests: the A.A.S proxy (lib/upstream.ts + the Route Handlers).
   The token used here is a synthetic test string held only in the test
   process environment; assertions verify it is attached to the upstream
   request and never appears in any response body. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as masterGET } from "@/app/api/a2s/master/[name]/route";
import { GET as eventsGET } from "@/app/api/a2s/events/route";
import { GET as statusGET } from "@/app/api/a2s/status/route";
import { MASTER_DATASETS, getToken, isMasterDataset, jsonError, relayJson } from "@/lib/upstream";

const TEST_TOKEN = "test-token-not-a-real-secret";
const realFetch = globalThis.fetch;

function stubUpstream(body = "{}", status = 200) {
  const fn = vi.fn(async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  process.env.A2S_TOKEN = TEST_TOKEN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.A2S_TOKEN;
  vi.restoreAllMocks();
});

describe("master dataset allowlist", () => {
  it("contains exactly the nine contract datasets", () => {
    expect([...MASTER_DATASETS].sort()).toEqual(
      ["amedas", "coastline", "eew-polygons", "rivers", "station-prefs", "stations", "tsunami-stations", "tsunami-zones", "volcanoes"].sort()
    );
    expect(isMasterDataset("stations")).toBe(true);
    expect(isMasterDataset("secrets")).toBe(false);
    expect(isMasterDataset("")).toBe(false);
  });
});

describe("getToken", () => {
  it("reads only the A2S_TOKEN env var", () => {
    expect(getToken({ A2S_TOKEN: "x" })).toBe("x");
    expect(getToken({ A2S_TOKEN: "" })).toBeNull();
    expect(getToken({})).toBeNull();
    expect(getToken({ OTHER: "x" })).toBeNull();
  });
});

describe("jsonError", () => {
  it("shapes a no-store JSON error", async () => {
    const res = jsonError(404, "unknown_master_dataset");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unknown_master_dataset" });
  });
});

describe("master route", () => {
  it("answers 404 for unknown datasets WITHOUT calling upstream", async () => {
    const upstream = stubUpstream();
    const res = await masterGET(new Request("http://localhost/api/a2s/master/secrets"), {
      params: Promise.resolve({ name: "secrets" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_master_dataset" });
    expect(upstream).not.toHaveBeenCalled();
  });
  it("relays a known dataset with the token attached and a long cache", async () => {
    const upstream = stubUpstream('{"stations":[]}');
    const res = await masterGET(new Request("http://localhost/api/a2s/master/stations"), {
      params: Promise.resolve({ name: "stations" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, stale-while-revalidate=86400");
    const [url, init] = upstream.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://a2s.taildf0a89.ts.net/v1/master/stations");
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    const body = await res.text();
    expect(body).toBe('{"stations":[]}');
    expect(body).not.toContain(TEST_TOKEN);
  });
});

describe("relayJson guards", () => {
  it("returns 500 when the token is not configured, without calling upstream", async () => {
    delete process.env.A2S_TOKEN;
    const upstream = stubUpstream();
    const res = await relayJson(new Request("http://localhost/api/a2s/events"), "/v1/events", "public, s-maxage=5, stale-while-revalidate=10");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "a2s_proxy_not_configured" });
    expect(upstream).not.toHaveBeenCalled();
  });
  it("returns 502 when the upstream fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await relayJson(new Request("http://localhost/api/a2s/events"), "/v1/events", "public, s-maxage=5, stale-while-revalidate=10");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2s_upstream_unavailable" });
  });
  it("rejects non-GET methods with 405", async () => {
    const upstream = stubUpstream();
    const res = await relayJson(new Request("http://localhost/api/a2s/events", { method: "POST" }), "/v1/events", "x");
    expect(res.status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("passes the upstream status through", async () => {
    stubUpstream('{"error":"rate"}', 429);
    const res = await relayJson(new Request("http://localhost/api/a2s/events"), "/v1/events", "x");
    expect(res.status).toBe(429);
  });
});

describe("events and status routes", () => {
  it("forwards kind/limit/since and uses the short events cache", async () => {
    const upstream = stubUpstream("[]");
    const res = await eventsGET(new Request("http://localhost/api/a2s/events?kind=quake&limit=10&since=2026-11-28T00%3A00%3A00.000Z&bogus=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=5, stale-while-revalidate=10");
    const [url] = upstream.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://a2s.taildf0a89.ts.net/v1/events?kind=quake&limit=10&since=2026-11-28T00%3A00%3A00.000Z");
  });
  it("status uses its own cache directive", async () => {
    stubUpstream("{}");
    const res = await statusGET(new Request("http://localhost/api/a2s/status"));
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=15, stale-while-revalidate=30");
  });
});
