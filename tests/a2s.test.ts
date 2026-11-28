/* Tests: lib/a2s.ts — config, URL building, converters, merging, store. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  a2sEventsUrl,
  a2sEewToValue,
  a2sQuakeToRecord,
  a2sStreamUrl,
  a2sTsunamiToValue,
  a2sWarningToValue,
  activeWarnings,
  applyA2sEvent,
  currentEew,
  loadA2sConfig,
  mergeEewValue,
  mergeQuakeRecords,
  mergeTsunamiValue,
  parseA2sConfig,
  resetA2sStore,
} from "@/lib/a2s";

describe("parseA2sConfig / URLs", () => {
  it("enables same-origin paths and trims trailing slashes", () => {
    expect(parseA2sConfig("/api/a2s")).toEqual({ enabled: true, baseUrl: "/api/a2s" });
    expect(parseA2sConfig("/api/a2s/")).toEqual({ enabled: true, baseUrl: "/api/a2s" });
  });
  it("enables http(s) URLs and disables everything else", () => {
    expect(parseA2sConfig("https://example.com/a2s").enabled).toBe(true);
    expect(parseA2sConfig("ftp://example.com").enabled).toBe(false);
    expect(parseA2sConfig("javascript:alert(1)").enabled).toBe(false);
    expect(parseA2sConfig("")).toEqual({ enabled: false, baseUrl: "" });
    expect(parseA2sConfig(null)).toEqual({ enabled: false, baseUrl: "" });
  });
  it("loads the default same-origin proxy config", () => {
    expect(loadA2sConfig()).toEqual({ enabled: true, baseUrl: "/api/a2s" });
  });
  it("builds event URLs with limit, kind and since", () => {
    const cfg = parseA2sConfig("/api/a2s");
    expect(a2sEventsUrl(cfg)).toBe("/api/a2s/events?limit=50");
    expect(a2sEventsUrl(cfg, "2026-11-28T00:00:00.000Z", { kind: "quake", limit: 100 })).toBe(
      "/api/a2s/events?limit=100&kind=quake&since=2026-11-28T00%3A00%3A00.000Z"
    );
    expect(a2sEventsUrl(cfg, null, { limit: 0 })).toBe("/api/a2s/events?limit=50");
    expect(a2sStreamUrl(cfg)).toBe("/api/a2s/stream");
  });
});

const quakeEvent = (over: Record<string, unknown> = {}) => ({
  kind: "quake",
  key: "551:2026/11/28 07:05:00",
  updatedAt: "2026-11-28T07:06:00.000Z",
  telegramId: "20261128070500",
  time: "2026/11/28 07:05:00",
  announcedTime: "2026/11/28 07:06:00",
  issueType: "ScalePrompt",
  hypocenter: "宮城県沖",
  magnitude: 5.1,
  depthKm: 40,
  maxScale: 40,
  tsunamiKind: "None",
  lat: 38.3,
  lon: 141.7,
  points: [
    { pref: "宮城県", name: "仙台宮城野区五輪", isArea: false, scale: 40 },
    { pref: "宮城県", name: "宮城県北部", isArea: true, scale: 40 },
  ],
  prefScales: [],
  ...over,
});

describe("a2sQuakeToRecord", () => {
  it("converts points (name → addr) and scalars", () => {
    const rec = a2sQuakeToRecord(quakeEvent());
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe("20261128070500");
    expect(rec!.points[0]).toEqual({ pref: "宮城県", addr: "仙台宮城野区五輪", isArea: false, scale: 40 });
    expect(rec!.typeRank).toBe(1);
    expect(rec!.hypocenter).toBe("宮城県沖");
  });
  it("treats a 不明 hypocenter as absent", () => {
    const rec = a2sQuakeToRecord(quakeEvent({ hypocenter: "不明" }));
    expect(rec!.hypocenter).toBeNull();
  });
  it("falls back to prefScales as area points when no points exist", () => {
    const rec = a2sQuakeToRecord(quakeEvent({ points: [], prefScales: [{ pref: "宮城県", scale: 30 }] }));
    expect(rec!.points).toEqual([{ pref: "宮城県", addr: "宮城県", isArea: true, scale: 30 }]);
  });
  it("rejects other kinds and invalid shapes", () => {
    expect(a2sQuakeToRecord({ kind: "eew", key: "x" })).toBeNull();
    expect(a2sQuakeToRecord(null)).toBeNull();
    expect(a2sQuakeToRecord({ kind: "quake" })).toBeNull();
  });
  it("drops out-of-range coordinates and negative magnitude/depth", () => {
    const rec = a2sQuakeToRecord(quakeEvent({ lat: 123, lon: 999, magnitude: -1, depthKm: -5 }));
    expect(rec!.lat).toBeNull();
    expect(rec!.lon).toBeNull();
    expect(rec!.magnitude).toBeNull();
    expect(rec!.depthKm).toBeNull();
  });
});

describe("mergeQuakeRecords", () => {
  it("merges telegrams of one quake, unioning points at max scale", () => {
    const prompt = a2sQuakeToRecord(quakeEvent())!;
    const detail = a2sQuakeToRecord(
      quakeEvent({
        telegramId: "20261128070501",
        issueType: "DetailScale",
        points: [
          { pref: "宮城県", name: "仙台宮城野区五輪", isArea: false, scale: 45 },
          { pref: "岩手県", name: "盛岡市薮川", isArea: false, scale: 30 },
        ],
      })
    )!;
    const merged = mergeQuakeRecords([prompt, detail]);
    expect(merged).toHaveLength(1);
    expect(merged[0].hasDetail).toBe(true);
    expect(merged[0].points.find((p) => p.addr === "仙台宮城野区五輪")?.scale).toBe(45);
    expect(merged[0].points.some((p) => p.addr === "盛岡市薮川")).toBe(true);
    expect(merged[0].ids).toContain("20261128070501");
  });
  it("joins an unnamed report into the single named group at the same time", () => {
    const named = a2sQuakeToRecord(quakeEvent())!;
    const unnamed = a2sQuakeToRecord(quakeEvent({ telegramId: "x2", hypocenter: "不明", lat: null, lon: null }))!;
    const merged = mergeQuakeRecords([named, unnamed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].hypocenter).toBe("宮城県沖");
  });
  it("fuses same-time groups whose hypocentres are within 30 km", () => {
    const a = a2sQuakeToRecord(quakeEvent({ telegramId: "a", hypocenter: "宮城県沖" }))!;
    const b = a2sQuakeToRecord(
      quakeEvent({ telegramId: "b", hypocenter: "宮城県中部", lat: 38.35, lon: 141.75 })
    )!;
    expect(mergeQuakeRecords([a, b])).toHaveLength(1);
  });
  it("keeps distant same-time groups separate", () => {
    const a = a2sQuakeToRecord(quakeEvent({ telegramId: "a" }))!;
    const b = a2sQuakeToRecord(
      quakeEvent({ telegramId: "b", hypocenter: "北海道西方沖", lat: 43.0, lon: 141.0 })
    )!;
    expect(mergeQuakeRecords([a, b])).toHaveLength(2);
  });
});

const eewEvent = (over: Record<string, unknown> = {}) => ({
  kind: "eew",
  key: "eew:1",
  updatedAt: "2026-11-28T07:05:10.000Z",
  originTime: "2026/11/28 07:05:00",
  time: "2026/11/28 07:05:08",
  cancel: false,
  isFinal: false,
  isWarn: false,
  serial: 1,
  hypocenter: "宮城県沖",
  estScale: 45,
  depthKm: 30,
  estMagnitude: 6.0,
  lat: 38.3,
  lon: 141.7,
  areaScales: [{ pref: "宮城県", name: "宮城県北部", scale: 45, scaleTo: 45 }],
  areaArrivals: [{ pref: "宮城県", arrivalTime: "2026/11/28 07:06:00" }],
  ...over,
});

describe("a2sEewToValue / mergeEewValue", () => {
  it("converts areas and slices arrival times to HH:MM", () => {
    const v = a2sEewToValue(eewEvent());
    expect(v).not.toBeNull();
    expect(v!.areas[0]).toEqual({ pref: "宮城県", name: "宮城県北部", scale: 45, scaleTo: 45, arrival: "07:06" });
    expect(v!.estScale).toBe(45);
    expect(v!.key).not.toContain("-cancel");
  });
  it("gives cancellations their own identity key", () => {
    const v = a2sEewToValue(eewEvent({ cancel: true }));
    expect(v!.key).toContain("-cancel");
  });
  it("newer issue wins; older never rewinds", () => {
    const older = a2sEewToValue(eewEvent())!;
    const newer = a2sEewToValue(eewEvent({ time: "2026/11/28 07:05:20", serial: 2 }))!;
    expect(mergeEewValue(older, newer)).toBe(newer);
    expect(mergeEewValue(newer, older)).toBe(newer);
  });
  it("at the same instant a forecast→warning upgrade wins", () => {
    const forecast = a2sEewToValue(eewEvent({ isWarn: false }))!;
    const warning = a2sEewToValue(eewEvent({ isWarn: true }))!;
    expect(mergeEewValue(forecast, warning)).toBe(warning);
    expect(mergeEewValue(warning, forecast)).toBe(warning);
  });
});

describe("a2sTsunamiToValue / mergeTsunamiValue", () => {
  const tsunamiEvent = (over: Record<string, unknown> = {}) => ({
    kind: "tsunami",
    key: "tsunami:1",
    updatedAt: "2026-11-28T07:10:00.000Z",
    time: "2026/11/28 07:10:00",
    cancelled: false,
    grade: "Warning",
    areas: [{ name: "宮城県沿岸", grade: "Warning", maxHeightLabel: "3m", maxHeightValue: 3, arrivalLabel: "2026/11/28 07:40:00" }],
    ...over,
  });
  it("converts areas and slices arrival labels", () => {
    const v = a2sTsunamiToValue(tsunamiEvent());
    expect(v!.grade).toBe("Warning");
    expect(v!.areas[0].arrival).toBe("07:40");
    expect(v!.areas[0].maxHeight).toBe("3m");
  });
  it("recomputes an out-of-rank event grade from the areas", () => {
    const v = a2sTsunamiToValue(tsunamiEvent({ grade: "SomethingElse" }));
    expect(v!.grade).toBe("Warning");
  });
  it("keeps a valid event grade", () => {
    const v = a2sTsunamiToValue(tsunamiEvent({ grade: "Watch", areas: [{ name: "x", grade: "Warning" }] }));
    expect(v!.grade).toBe("Watch");
  });
  it("newer tsunami wins, ties keep current", () => {
    const a = a2sTsunamiToValue(tsunamiEvent())!;
    const b = a2sTsunamiToValue(tsunamiEvent({ time: "2026/11/28 07:20:00" }))!;
    expect(mergeTsunamiValue(a, b)).toBe(b);
    expect(mergeTsunamiValue(b, a)).toBe(b);
    expect(mergeTsunamiValue(a, a)).toBe(a);
  });
});

describe("event store", () => {
  beforeEach(() => resetA2sStore());
  it("dedupes by key + updatedAt", () => {
    const ev = quakeEvent();
    expect(applyA2sEvent(ev)).toBe("applied");
    expect(applyA2sEvent(ev)).toBe("duplicate");
    expect(applyA2sEvent(quakeEvent({ updatedAt: "2026-11-28T07:07:00.000Z" }))).toBe("applied");
  });
  it("rejects invalid events", () => {
    expect(applyA2sEvent({ kind: "quake" })).toBe("invalid");
    expect(applyA2sEvent(null)).toBe("invalid");
  });
  it("a warning release removes the warning from the active set", () => {
    const warn = {
      kind: "warning",
      key: "warning:宮城県",
      updatedAt: "2026-11-28T07:00:00.000Z",
      prefName: "宮城県",
      areaName: "東部",
      headline: "大雨警報",
      maxSeverity: 3,
      released: false,
      warnings: [{ code: "03", name: "大雨警報", status: "発表", severity: 3 }],
    };
    expect(applyA2sEvent(warn)).toBe("applied");
    expect(activeWarnings()).toHaveLength(1);
    expect(a2sWarningToValue(warn)?.warnings[0].name).toBe("大雨警報");
    expect(applyA2sEvent({ ...warn, updatedAt: "2026-11-28T08:00:00.000Z", released: true })).toBe("applied");
    expect(activeWarnings()).toHaveLength(0);
  });
  it("keeps the latest EEW in the store", () => {
    applyA2sEvent(eewEvent());
    expect(currentEew()?.serial).toBe(1);
    applyA2sEvent(eewEvent({ updatedAt: "2026-11-28T07:05:30.000Z", time: "2026/11/28 07:05:25", serial: 2 }));
    expect(currentEew()?.serial).toBe(2);
  });
});
