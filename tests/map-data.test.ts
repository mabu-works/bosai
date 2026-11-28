/* Tests: lib/map-data.ts — master-data normalisation and resolution. */

import { describe, expect, it } from "vitest";
import type { EewValue, MergedQuake, TsunamiValue } from "@/lib/a2s";
import {
  eewMatchKey,
  indexEewPolygons,
  normalizeEewAreaName,
  normalizeEewPolygons,
  normalizeStationPrefs,
  normalizeTsunamiZones,
  polygonAnchor,
  resolveEewAreaFills,
  resolveQuakePoints,
  resolveTsunamiCoastlines,
  resolveTsunamiZonePoints,
  stationCoordIndex,
} from "@/lib/map-data";

describe("master-data shape normalisation", () => {
  it("accepts wrapped and bare shapes identically", () => {
    const bare = { "仙台宮城野区五輪": "宮城県" };
    expect(normalizeStationPrefs({ prefs: bare })).toEqual(normalizeStationPrefs(bare));
    const zones = { "宮城県沿岸": { lat: 38.3, lon: 141.5 } };
    expect(normalizeTsunamiZones({ zones })).toEqual(normalizeTsunamiZones(zones));
    const regions = { "宮城県北部": { pref: "宮城県", polygons: [] } };
    expect(normalizeEewPolygons({ regions })).toEqual(normalizeEewPolygons(regions));
    expect(normalizeStationPrefs(null)).toBeNull();
    expect(normalizeStationPrefs("x")).toBeNull();
  });
});

describe("stationCoordIndex / resolveQuakePoints", () => {
  const stations = {
    stations: [
      { addr: "仙台宮城野区五輪", lat: 38.3, lon: 140.9 },
      { addr: "盛岡市薮川", lat: 39.8, lon: 141.3 },
      { addr: "座標なし", lat: "x", lon: 141.3 },
    ],
  };
  it("indexes only stations with valid coordinates", () => {
    const idx = stationCoordIndex(stations);
    expect(idx.size).toBe(2);
    expect(idx.get("仙台宮城野区五輪")).toEqual({ lat: 38.3, lon: 140.9 });
  });
  const record = {
    points: [
      { pref: "宮城県", addr: "仙台宮城野区五輪", isArea: false, scale: 40 },
      { pref: "宮城県", addr: "仙台宮城野区五輪", isArea: false, scale: 45 },
      { pref: "宮城県", addr: "宮城県北部", isArea: true, scale: 45 },
      { pref: "福島県", addr: "未知の観測点", isArea: false, scale: 30 },
      { pref: "岩手県", addr: "盛岡市薮川", isArea: false, scale: -1 },
    ],
  } as unknown as MergedQuake;
  it("excludes area values, collapses duplicates at max, counts unresolved", () => {
    const { points, unresolved } = resolveQuakePoints(record, stationCoordIndex(stations));
    expect(points).toEqual([{ name: "仙台宮城野区五輪", scale: 45, lat: 38.3, lon: 140.9 }]);
    expect(unresolved).toBe(1);
  });
});

describe("EEW area name matching", () => {
  it("normalises full-width digits and strips 地方", () => {
    expect(normalizeEewAreaName("東京都２３区")).toBe("東京都23区");
    expect(eewMatchKey("東北地方北部")).toBe("東北北部");
    expect(eewMatchKey("宮城県北部")).toBe("宮城県北部");
  });
  const square: [number, number][] = [
    [140.8, 38.2],
    [141.0, 38.2],
    [141.0, 38.4],
    [140.8, 38.4],
    [140.8, 38.2],
  ];
  const polyData = {
    regions: {
      "宮城県北部": { pref: "宮城県", polygons: [[square]] },
      "東京都23区": { pref: "東京都", polygons: [[square]] },
    },
  };
  it("indexes polygons and anchors at the ring average", () => {
    const idx = indexEewPolygons(polyData);
    expect(idx.entries).toHaveLength(2);
    const anchor = polygonAnchor([[square]]);
    // 📌 The closed ring's first vertex is counted twice (5 points).
    expect(anchor?.lat).toBeCloseTo(38.28, 5);
    expect(anchor?.lon).toBeCloseTo(140.88, 5);
  });
  it("resolves fills by direct name, keeping max scale per area", () => {
    const eew = {
      areas: [
        { pref: "宮城県", name: "宮城県北部", scale: 40, scaleTo: 40, arrival: null },
        { pref: "宮城県", name: "宮城県北部", scale: 45, scaleTo: 99, arrival: null },
        { pref: "不明県", name: "存在しない地域", scale: 30, scaleTo: 30, arrival: null },
      ],
    } as unknown as EewValue;
    const { fills, unresolved } = resolveEewAreaFills(eew, indexEewPolygons(polyData), new Map(), null);
    expect(fills).toHaveLength(1);
    expect(fills[0].scale).toBe(45);
    expect(fills[0].openEnded).toBe(true);
    expect(fills[0].polygons).not.toBeNull();
    expect(unresolved).toEqual(["存在しない地域"]);
  });
});

describe("tsunami resolution", () => {
  const tsunami = {
    time: "2026/11/28 07:10:00",
    cancelled: false,
    grade: "Warning",
    areas: [
      { name: "宮城県沿岸", grade: "Warning", cancelled: false, maxHeight: "3m", maxHeightValue: 3, arrival: "07:40" },
      { name: "未知の区域", grade: "Watch", cancelled: false, maxHeight: null, maxHeightValue: null, arrival: null },
      { name: "解除区域", grade: "Watch", cancelled: true, maxHeight: null, maxHeightValue: null, arrival: null },
    ],
    source: "a2s",
  } as TsunamiValue;
  const coastline = { zones: { "宮城県沿岸": [[[141.0, 38.0], [141.5, 38.5]] as [number, number][]] } };
  const zones = { zones: { "宮城県沿岸": { lat: 38.3, lon: 141.5 } } };
  it("resolves coastlines and reports unknown zones, skipping cancelled", () => {
    const { areas, unresolved } = resolveTsunamiCoastlines(tsunami, coastline, zones);
    expect(areas).toHaveLength(1);
    expect(areas[0].lines).toHaveLength(1);
    expect(unresolved).toEqual(["未知の区域"]);
  });
  it("resolves zone points for the report map", () => {
    const { areas, unresolved } = resolveTsunamiZonePoints(tsunami, zones);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ name: "宮城県沿岸", lat: 38.3, lon: 141.5 });
    expect(unresolved).toEqual(["未知の区域"]);
  });
});
