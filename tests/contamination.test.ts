/* Tests: the token-contamination scan. The A.A.S token's env var name may
   appear only in server-side modules (lib/upstream.ts and the API route
   handlers), and the upstream host may appear only in lib/upstream.ts.
   This is the regression guard for the 2026-11-27 incident in which a
   token shipped in client code. */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SOURCE_DIRS = ["app", "components", "lib"];
const TOKEN_ENV_NAME = "A2S_TOKEN";
const UPSTREAM_HOST = "a2s.taildf0a89";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) yield path;
  }
}

function isServerSide(relPath: string): boolean {
  return relPath === join("lib", "upstream.ts") || relPath.startsWith(join("app", "api") + "/");
}

describe("token contamination scan", () => {
  it("the token env name appears only in server-side files", () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (readFileSync(file, "utf8").includes(TOKEN_ENV_NAME) && !isServerSide(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the upstream host appears only in lib/upstream.ts", () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === join("lib", "upstream.ts")) continue;
        if (readFileSync(file, "utf8").includes(UPSTREAM_HOST)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the client base URL is the same-origin proxy path", async () => {
    const { A2S_BASE_URL } = await import("@/lib/config");
    expect(A2S_BASE_URL).toBe("/api/a2s");
  });
});
