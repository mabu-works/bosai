/* Tests: lib/stats.ts (AMeDAS shaping + P2P history aggregation) and
   lib/master.ts (river rows). */

import { describe, expect, it } from "vitest";
import { riverRowsOf } from "@/lib/master";
import {
  aggregateQuakeStats,
  amedasTimestamp,
  amedasValue,
  buildAmedasRows,
  parseHistoryQuake,
  type HistoryQuake,
} from "@/lib/stats";

describe("amedasValue / amedasTimestamp", () => {
  it("unwraps [value, flag] pairs", () => {
    expect(amedasValue([21.5, 0])).toBe(21.5);
    expect(amedasValue([null, 1])).toBeNull();
    expect(amedasValue(3)).toBeNull();
    expect(amedasValue("x")).toBeNull();
    expect(amedasValue(null)).toBeNull();
  });
  it("floors the latest time to a 10-minute boundary", () => {
    expect(amedasTimestamp(new Date(2026, 10, 28, 7, 47, 30))).toBe("20261128074000");
    expect(amedasTimestamp(new Date(2026, 0, 3, 0, 0, 0))).toBe("20260103000000");
  });
});

describe("buildAmedasRows", () => {
  // 📌 The station table is a record keyed by station code (kjName inside).
  const table = {
    "36201": { kjName: "仙台" },
    "33301": { kjName: "盛岡" },
    "99999": { kjName: "欠測局" },
  };
  const data = {
    "36201": { temp: [20.1, 0], humidity: [55, 0], precipitation10m: [0.5, 0], wind: [3.2, 0], windDirection: [90, 0], snow: [0, 0], pressure: [1013.2, 0] },
    "33301": { temp: [18.0, 0], humidity: [60, 0], precipitation10m: [null, 1], wind: [2.0, 0], windDirection: [180, 0] },
    "99999": { temp: [null, 1], humidity: [null, 1], precipitation10m: [null, 1], wind: [null, 1], windDirection: [null, 1] },
  };
  it("keeps rows with any of temp / precip10 / wind, dropping all-missing rows", () => {
    const rows = buildAmedasRows(table, data);
    expect(rows.map((r) => r.name).sort()).toEqual(["仙台", "盛岡"]);
    const sendai = rows.find((r) => r.name === "仙台");
    expect(sendai).toMatchObject({ temp: 20.1, precip10: 0.5, wind: 3.2, windDir: 90 });
  });
  it("returns an empty list for unusable input", () => {
    expect(buildAmedasRows(null, null)).toEqual([]);
  });
});

describe("parseHistoryQuake", () => {
  it("normalises a P2P 551 entry", () => {
    const q = parseHistoryQuake({
      id: "abc",
      earthquake: {
        time: "2026/11/28 07:05:00",
        hypocenter: { name: "宮城県沖" },
        maxScale: 40,
        magnitude: { value: 5.1 },
        depth: { value: 40 },
      },
      issue: { type: "DetailScale" },
      points: [{ pref: "宮城県", addr: "仙台宮城野区五輪", scale: 40 }],
    });
    expect(q).not.toBeNull();
    expect(q!.hypocenter).toBe("宮城県沖");
    expect(q!.maxScale).toBe(40);
    expect(q!.magnitude).toBe(5.1);
    expect(q!.depthKm).toBe(40);
    expect(q!.points[0].addr).toBe("仙台宮城野区五輪");
  });
  it("rejects entries without an earthquake block", () => {
    expect(parseHistoryQuake({})).toBeNull();
    expect(parseHistoryQuake(null)).toBeNull();
  });
});

describe("aggregateQuakeStats", () => {
  const now = new Date(2026, 10, 28, 12, 0, 0).getTime();
  const mk = (time: string, maxScale: number, prefs: string[]): HistoryQuake => ({
    id: time,
    time,
    hypocenter: "x",
    maxScale,
    magnitude: null,
    depthKm: null,
    points: prefs.map((pref) => ({ pref, addr: `${pref}の点`, scale: maxScale })),
  });
  const records: HistoryQuake[] = [
    mk("2026/11/27 10:00:00", 45, ["宮城県", "宮城県", "岩手県"]),
    mk("2026/11/26 09:00:00", -1, ["宮城県"]),
    mk("2026/10/01 09:00:00", 70, ["北海道"]),
  ];
  it("counts a quake once per prefecture and buckets unknown scales", () => {
    const stats = aggregateQuakeStats(records, 7, now);
    expect(stats.total).toBe(2);
    const sum = stats.byScale.reduce((s, r) => s + r.count, 0);
    expect(sum).toBe(2);
    expect(stats.byScale.find((r) => r.scale === -1)?.count).toBe(1);
    expect(stats.byScale.find((r) => r.scale === 45)?.count).toBe(1);
    expect(stats.byPref.find((r) => r.pref === "宮城県")?.count).toBe(2);
    expect(stats.byPref.find((r) => r.pref === "岩手県")?.count).toBe(1);
    expect(stats.strongest?.maxScale).toBe(45);
  });
  it("widens the window with the period", () => {
    expect(aggregateQuakeStats(records, 90, now).total).toBe(3);
  });
});

describe("riverRowsOf", () => {
  it("summarises lines and points from wrapped and bare shapes", () => {
    const data = {
      rivers: {
        "北上川": { lines: [[[141, 39], [141.1, 39.1]], [[141.2, 39.2]]] },
        "壊れた川": { lines: "nope" },
      },
    };
    const rows = riverRowsOf(data);
    expect(rows).toEqual([{ name: "北上川", lineCount: 2, pointCount: 3 }]);
    expect(riverRowsOf(data.rivers)).toEqual(rows);
  });
  it("returns null for non-objects", () => {
    expect(riverRowsOf(null)).toBeNull();
    expect(riverRowsOf([1, 2])).toBeNull();
    expect(riverRowsOf("x")).toBeNull();
  });
});
