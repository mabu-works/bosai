/* Tests: lib/map-geo.ts — Mercator maths, view fitting, remote split,
   label/inset placement. */

import { describe, expect, it } from "vitest";
import {
  chooseInsetRect,
  chooseLabelRect,
  computeMapView,
  isValidCoord,
  latToWorldY,
  lonToWorldX,
  mapScaleColor,
  mapScaleLabel,
  rectOverlapArea,
  remoteRegionOf,
  splitRemotePoints,
  tileJobsForView,
  worldXToLon,
  worldYToLat,
} from "@/lib/map-geo";

describe("Mercator conversions", () => {
  it("round-trips lon/lat", () => {
    for (const z of [4, 7, 9]) {
      expect(worldXToLon(lonToWorldX(139.7671, z), z)).toBeCloseTo(139.7671, 6);
      expect(worldYToLat(latToWorldY(35.6812, z), z)).toBeCloseTo(35.6812, 6);
    }
  });
  it("clamps latitude to the Mercator limit", () => {
    expect(latToWorldY(89, 5)).toBe(latToWorldY(85.0511, 5));
  });
});

describe("isValidCoord", () => {
  it("accepts in-range numbers only", () => {
    expect(isValidCoord(35, 139)).toBe(true);
    expect(isValidCoord(91, 139)).toBe(false);
    expect(isValidCoord(35, 181)).toBe(false);
    expect(isValidCoord("35", 139)).toBe(false);
    expect(isValidCoord(null, 139)).toBe(false);
    expect(isValidCoord(NaN, 139)).toBe(false);
  });
});

describe("map scale helpers", () => {
  it("uses the bot-format labels (5- / 5+ style)", () => {
    expect(mapScaleLabel(45)).toBe("5-");
    expect(mapScaleLabel(50)).toBe("5+");
    expect(mapScaleLabel(70)).toBe("7");
    expect(mapScaleLabel(-1)).toBe("不明");
  });
  it("colours intermediate values with the class below", () => {
    expect(mapScaleColor(45)).toBe("#fb8c00");
    expect(mapScaleColor(47)).toBe("#fb8c00");
    expect(mapScaleColor(70)).toBe("#6a1b9a");
  });
});

describe("computeMapView", () => {
  const pts = [
    { lat: 35.0, lon: 139.0 },
    { lat: 36.0, lon: 140.0 },
    { lat: 35.5, lon: 139.5 },
  ];
  it("fits every point inside the viewport with margin", () => {
    const view = computeMapView(pts, 960, 720);
    for (const p of pts) {
      const x = lonToWorldX(p.lon, view.zoom) - view.left;
      const y = latToWorldY(p.lat, view.zoom) - view.top;
      expect(x).toBeGreaterThanOrEqual(22);
      expect(x).toBeLessThanOrEqual(960 - 22);
      expect(y).toBeGreaterThanOrEqual(22);
      expect(y).toBeLessThanOrEqual(720 - 22);
    }
    expect(view.zoom).toBeGreaterThanOrEqual(5);
    expect(view.zoom).toBeLessThanOrEqual(9);
  });
  it("snaps the origin to the tile grid by default", () => {
    const view = computeMapView(pts, 960, 720);
    expect(view.left % 256).toBe(0);
    expect(view.top % 256).toBe(0);
  });
  it("honours a caller maxZoom and min span (EEW fill settings)", () => {
    const view = computeMapView([{ lat: 35.6, lon: 139.7 }], 960, 720, 256, false, 11, { lat: 0.45, lon: 0.55 });
    expect(view.zoom).toBeLessThanOrEqual(11);
    const x = lonToWorldX(139.7, view.zoom) - view.left;
    expect(x).toBeGreaterThanOrEqual(22);
  });
  it("tile jobs cover the region", () => {
    const view = computeMapView(pts, 960, 720);
    const jobs = tileJobsForView(view, 960, 720);
    expect(jobs.length).toBeGreaterThan(0);
    const maxDx = Math.max(...jobs.map((j) => j.tx)) - Math.min(...jobs.map((j) => j.tx));
    expect((maxDx + 1) * 256).toBeGreaterThanOrEqual(960);
  });
});

describe("remote region split", () => {
  it("classifies by the bot thresholds", () => {
    expect(remoteRegionOf(31.4, 131.9)).toBe("southwest");
    expect(remoteRegionOf(31.4, 132.0)).toBeNull();
    expect(remoteRegionOf(33.4, 139.5)).toBe("ogasawara");
    expect(remoteRegionOf(35.6, 139.7)).toBeNull();
  });
  it("splits only when a mainland point exists", () => {
    const items = [
      { lat: 35.6, lon: 139.7, id: "main" },
      { lat: 26.2, lon: 127.7, id: "sw" },
      { lat: 27.1, lon: 142.2, id: "og" },
    ];
    const split = splitRemotePoints(items);
    expect(split.main.map((i) => i.id)).toEqual(["main"]);
    expect(split.southwest.map((i) => i.id)).toEqual(["sw"]);
    expect(split.ogasawara.map((i) => i.id)).toEqual(["og"]);
    const remoteOnly = splitRemotePoints(items.slice(1));
    expect(remoteOnly.main).toHaveLength(2);
    expect(remoteOnly.southwest).toHaveLength(0);
  });
});

describe("label and inset placement", () => {
  it("rectOverlapArea measures intersections", () => {
    expect(rectOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
    expect(rectOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
  });
  it("chooseLabelRect avoids occupied space and stays in bounds", () => {
    const bounds = { x: 0, y: 0, w: 400, h: 300 };
    const above = { x: 180, y: 76, w: 40, h: 20 };
    const rect = chooseLabelRect({ x: 200, y: 100 }, { w: 40, h: 20 }, 4, [above], bounds);
    expect(rectOverlapArea(rect, above, 2)).toBe(0);
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.w).toBeLessThanOrEqual(bounds.x + bounds.w);
  });
  it("chooseInsetRect prefers the requested corner when free", () => {
    const mapRect = { x: 0, y: 0, w: 960, h: 720 };
    const rect = chooseInsetRect([], "bottomLeft", [], mapRect);
    expect(rect.x).toBe(12);
    expect(rect.y).toBe(720 - 12 - 250);
    const rectR = chooseInsetRect([], "bottomRight", [], mapRect);
    expect(rectR.x).toBe(960 - 12 - 330);
  });
  it("chooseInsetRect avoids blocked corners", () => {
    const mapRect = { x: 0, y: 0, w: 960, h: 720 };
    const blocked = [{ x: 12, y: 720 - 12 - 250, w: 330, h: 250 }];
    const rect = chooseInsetRect([], "bottomLeft", blocked, mapRect);
    expect(rect.x).toBe(960 - 12 - 330);
  });
  it("chooseInsetRect never hides the strongest marker when avoidable", () => {
    const mapRect = { x: 0, y: 0, w: 960, h: 720 };
    // Strongest marker sits in the bottom-left corner.
    const obstacles = [{ x: 60, y: 660, r: 16, scale: 70 }];
    const rect = chooseInsetRect(obstacles, "bottomLeft", [], mapRect);
    const hides = 60 + 16 > rect.x && 60 - 16 < rect.x + rect.w && 660 + 16 > rect.y && 660 - 16 < rect.y + rect.h;
    expect(hides).toBe(false);
  });
});
