/* Tests: lib/core.ts — time parsing/formatting, labels, radar freshness. */

import { describe, expect, it } from "vitest";
import {
  depthLabel,
  fmtTime,
  formatRound,
  formatTemp,
  haversineKm,
  numOrNull,
  parseJmaTime14,
  parseJstTime,
  parseNowcastTargets,
  radarFreshness,
  scaleLabel,
  scaleStyle,
} from "@/lib/core";

describe("parseJstTime", () => {
  it("parses a JST timestamp", () => {
    const d = parseJstTime("2026/11/28 07:05:00");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(10);
    expect(d!.getDate()).toBe(28);
    expect(d!.getHours()).toBe(7);
    expect(d!.getMinutes()).toBe(5);
  });
  it("rejects garbage", () => {
    expect(parseJstTime("not a time")).toBeNull();
    expect(parseJstTime("")).toBeNull();
    expect(parseJstTime(null)).toBeNull();
    expect(parseJstTime(123)).toBeNull();
  });
});

describe("fmtTime", () => {
  it("formats as M/D HH:MM", () => {
    expect(fmtTime(parseJstTime("2026/11/28 07:05:00"))).toBe("11/28 07:05");
    expect(fmtTime(null)).toBe("");
  });
});

describe("scaleLabel / scaleStyle", () => {
  it("labels the JMA classes", () => {
    expect(scaleLabel(10)).toBe("1");
    expect(scaleLabel(45)).toBe("5弱");
    expect(scaleLabel(50)).toBe("5強");
    expect(scaleLabel(55)).toBe("6弱");
    expect(scaleLabel(60)).toBe("6強");
    expect(scaleLabel(70)).toBe("7");
  });
  it("labels unknown intensities as 不明", () => {
    expect(scaleLabel(-1)).toBe("不明");
    expect(scaleLabel(0)).toBe("不明");
  });
  it("picks the colour band at or below the value", () => {
    expect(scaleStyle(45).color).toBe(scaleStyle(45).color);
    expect(scaleStyle(47).color).toBe(scaleStyle(45).color);
    expect(scaleStyle(-1).cls).toBe("scale-unknown");
  });
});

describe("depthLabel", () => {
  it("handles the sentinels", () => {
    expect(depthLabel(null)).toBe("深さ不明");
    expect(depthLabel(undefined)).toBe("深さ不明");
    expect(depthLabel(-1)).toBe("深さ不明");
    expect(depthLabel(0)).toBe("ごく浅い");
    expect(depthLabel(10)).toBe("約10km");
  });
});

describe("numOrNull", () => {
  it("accepts numbers and numeric strings only", () => {
    expect(numOrNull(3.5)).toBe(3.5);
    expect(numOrNull("42")).toBe(42);
    expect(numOrNull("abc")).toBeNull();
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull(NaN)).toBeNull();
  });
});

describe("haversineKm", () => {
  it("measures Tokyo–Osaka at roughly 400 km", () => {
    const km = haversineKm(35.6812, 139.7671, 34.6937, 135.5023);
    expect(km).toBeGreaterThan(380);
    expect(km).toBeLessThan(420);
  });
  it("is zero for the same point", () => {
    expect(haversineKm(35, 139, 35, 139)).toBe(0);
  });
});

describe("parseJmaTime14", () => {
  it("interprets the 14 digits as UTC, not JST", () => {
    const d = parseJmaTime14("20261122010000");
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(Date.UTC(2026, 10, 22, 1, 0, 0));
  });
  it("rejects malformed input", () => {
    expect(parseJmaTime14("2026112201000")).toBeNull();
    expect(parseJmaTime14("2026-11-22")).toBeNull();
    expect(parseJmaTime14(null)).toBeNull();
  });
});

describe("parseNowcastTargets / radarFreshness", () => {
  it("takes the first targetTimes entry", () => {
    const t = parseNowcastTargets([
      { basetime: "20261122005500", validtime: "20261122010000" },
      { basetime: "20261122005000", validtime: "20261122005500" },
    ]);
    expect(t?.basetime).toBe("20261122005500");
    expect(t?.validtime).toBe("20261122010000");
    expect(t?.valid.getTime()).toBe(Date.UTC(2026, 10, 22, 1, 0, 0));
  });
  it("returns null for empty data", () => {
    expect(parseNowcastTargets([])).toBeNull();
    expect(parseNowcastTargets(null)).toBeNull();
  });
  it("flags frames older than 20 minutes as stale", () => {
    const now = Date.UTC(2026, 10, 22, 2, 0, 0);
    const fresh = radarFreshness(new Date(now - 10 * 60_000), now);
    expect(fresh.ageMin).toBe(10);
    expect(fresh.stale).toBe(false);
    const stale = radarFreshness(new Date(now - 30 * 60_000), now);
    expect(stale.stale).toBe(true);
    expect(radarFreshness(null, now).text).toBe("");
  });
});

describe("formatTemp / formatRound", () => {
  it("renders one decimal for temperatures and — for missing", () => {
    expect(formatTemp(21.26)).toBe("21.3°");
    expect(formatTemp(null)).toBe("—");
    expect(formatRound(3.6)).toBe("4");
    expect(formatRound(undefined)).toBe("—");
  });
});
