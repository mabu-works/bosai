/* Tests: lib/places.ts — storage shape, geocoding, per-place intensities. */

import { describe, expect, it } from "vitest";
import type { EewValue, MergedQuake } from "@/lib/a2s";
import {
  buildGeocodingUrl,
  eewLocalForecasts,
  localMeasuredScale,
  normalizePlace,
  parseGeocodingResults,
  parsePlaces,
  type Place,
} from "@/lib/places";

const place: Place = { name: "自宅", lat: 38.27, lon: 140.87, city: "仙台市", pref: "宮城県", area: "宮城県中部" };

describe("place normalisation / storage parsing", () => {
  it("keeps well-formed places and drops malformed ones", () => {
    expect(normalizePlace(place)).toEqual(place);
    expect(normalizePlace({ name: "x", lat: "abc", lon: 140 })).toBeNull();
    expect(normalizePlace({ name: "x", lat: 91, lon: 140 })).toBeNull();
    expect(normalizePlace({ name: "", lat: 38, lon: 140 })).toBeNull();
    expect(normalizePlace(null)).toBeNull();
    expect(parsePlaces(JSON.stringify([place, { bad: true }]))).toEqual([place]);
    expect(parsePlaces("not json")).toEqual([]);
    expect(parsePlaces(null)).toEqual([]);
  });
});

describe("geocoding", () => {
  it("builds the Open-Meteo search URL for Japan", () => {
    const url = new URL(buildGeocodingUrl("高崎駅"));
    expect(url.searchParams.get("name")).toBe("高崎駅");
    expect(url.searchParams.get("language")).toBe("ja");
    expect(url.searchParams.get("countryCode")).toBe("JP");
  });
  it("parses results into places with labels", () => {
    const results = parseGeocodingResults({
      results: [
        { name: "高崎市", latitude: 36.32, longitude: 139.0, admin1: "群馬県", admin2: "高崎市" },
        { name: "壊れた結果" },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("高崎市");
    expect(results[0].pref).toBe("群馬県");
    expect(results[0].label).toContain("高崎市");
    expect(parseGeocodingResults(null)).toEqual([]);
  });
});

describe("localMeasuredScale", () => {
  const quake = {
    points: [
      { pref: "宮城県", addr: "仙台市宮城野区五輪", isArea: false, scale: 40 },
      { pref: "宮城県", addr: "仙台市青葉区本町", isArea: false, scale: 45 },
      { pref: "宮城県", addr: "宮城県中部", isArea: true, scale: 50 },
      { pref: "岩手県", addr: "盛岡市薮川", isArea: false, scale: 30 },
    ],
  } as unknown as MergedQuake;
  it("takes the max over measured points in the place's city (no estimation)", () => {
    expect(localMeasuredScale(quake, place)).toBe(45);
  });
  it("ignores area values and other cities", () => {
    const other: Place = { ...place, city: "石巻市" };
    expect(localMeasuredScale(quake, other)).toBeNull();
    expect(localMeasuredScale(quake, { ...place, city: "" })).toBeNull();
    expect(localMeasuredScale(null, place)).toBeNull();
  });
});

describe("eewLocalForecasts", () => {
  const eew = {
    areas: [
      { pref: "宮城県", name: "宮城県中部", scale: 45, scaleTo: 45, arrival: null },
      { pref: "宮城県", name: "宮城県北部", scale: 40, scaleTo: 40, arrival: null },
      { pref: "岩手県", name: "岩手県沿岸北部", scale: 30, scaleTo: 30, arrival: null },
    ],
  } as unknown as EewValue;
  it("matches the exact subdivision name first", () => {
    const out = eewLocalForecasts(eew, [place]);
    expect(out).toEqual([{ place: "自宅", scale: 45, areaName: "宮城県中部", pref: "宮城県" }]);
  });
  it("falls back to the prefecture maximum when several areas share the prefecture", () => {
    const p2: Place = { ...place, name: "実家", area: "" };
    const out = eewLocalForecasts(eew, [p2]);
    expect(out[0].scale).toBe(45);
    expect(out[0].areaName).toBe("宮城県中部");
  });
  it("uses the single prefecture area when only one exists", () => {
    const p3: Place = { ...place, name: "盛岡の家", pref: "岩手県", area: "" };
    const out = eewLocalForecasts(eew, [p3]);
    expect(out[0].areaName).toBe("岩手県沿岸北部");
  });
  it("omits places with no matching area", () => {
    const p4: Place = { ...place, name: "大阪の家", pref: "大阪府", area: "" };
    expect(eewLocalForecasts(eew, [p4])).toEqual([]);
    expect(eewLocalForecasts(null, [place])).toEqual([]);
  });
});
