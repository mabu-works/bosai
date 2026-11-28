/* bosai — statistics (P2P history API) and AMeDAS logic.
   The stats page aggregates over weeks to months, beyond the A.A.S
   retention window (72 hours), so it is the one documented exception
   that reads the P2P earthquake history API directly. Live event
   delivery remains A.A.S-only. */

import { fetchJson, numOrNull, P2P_HISTORY, parseJstTime } from "./core";

// ==========================================
// 🌡️ AMeDAS
// ==========================================
// 📌 The station table is master data and comes through A.A.S (the
// same-origin proxy). The observations themselves (latest_time and the
// per-timestamp map JSON) are time-series data, not master data, and stay
// on the direct JMA endpoints.
export const AMEDAS_TABLE_URL = "/api/a2s/master/amedas";
export const AMEDAS_LATEST_URL = "https://www.jma.go.jp/bosai/amedas/data/latest_time.txt";
export const AMEDAS_MAP_URL = (ts: string) => `https://www.jma.go.jp/bosai/amedas/data/map/${ts}.json`;
export const WIND_DIRS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];

// 📌 AMeDAS values arrive as [value, quality flag] pairs; missing is null.
export function amedasValue(v: unknown): number | null {
  if (!Array.isArray(v) || v[0] === null || v[0] === undefined) return null;
  return numOrNull(v[0]);
}

// 📌 10-minute-step data file name (YYYYMMDDHHmm00).
export function amedasTimestamp(latest: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${latest.getFullYear()}${p2(latest.getMonth() + 1)}${p2(latest.getDate())}${p2(latest.getHours())}${p2(Math.floor(latest.getMinutes() / 10) * 10)}00`;
}

export interface AmedasRow {
  name: string;
  temp: number | null;
  humidity: number | null;
  precip10: number | null;
  wind: number | null;
  windDir: number | null;
  snow: number | null;
  pressure: number | null;
}

// 📋 Join the station table with the latest observations, keeping only
// stations that reported something, sorted by name (Japanese collation).
export function buildAmedasRows(table: unknown, data: unknown): AmedasRow[] {
  if (!table || typeof table !== "object") return [];
  const dataRec = (data ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(table as Record<string, { kjName?: unknown }>)
    .map(([code, st]) => {
      const d = dataRec[code] ?? {};
      return {
        name: String(st?.kjName ?? code),
        temp: amedasValue(d.temp),
        humidity: amedasValue(d.humidity),
        precip10: amedasValue(d.precipitation10m),
        wind: amedasValue(d.wind),
        windDir: amedasValue(d.windDirection),
        snow: amedasValue(d.snow),
        pressure: amedasValue(d.pressure),
      };
    })
    .filter((r) => r.temp !== null || r.precip10 !== null || r.wind !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

// ==========================================
// 📊 Stats page (exception: P2P history API)
// ==========================================
export interface HistoryPoint {
  pref: string;
  addr: string;
  scale: number;
}
export interface HistoryQuake {
  id: string;
  time: string;
  hypocenter: string;
  maxScale: number;
  magnitude: number | null;
  depthKm: number | null;
  points: HistoryPoint[];
}

// 📊 Normalise one P2P history quake entry (code 551) for aggregation.
export function parseHistoryQuake(entry: unknown): HistoryQuake | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as {
    id?: unknown;
    earthquake?: { time?: unknown; hypocenter?: { name?: unknown }; maxScale?: unknown; magnitude?: { value?: unknown }; depth?: { value?: unknown } };
    issue?: { time?: unknown };
    points?: { pref?: unknown; addr?: unknown; scale?: unknown }[];
  };
  const eq = e.earthquake ?? {};
  const time = typeof eq.time === "string" ? eq.time : typeof e.issue?.time === "string" ? e.issue.time : "";
  if (!time) return null;
  return {
    id: String(e.id ?? ""),
    time,
    hypocenter: typeof eq.hypocenter?.name === "string" ? eq.hypocenter.name : "",
    maxScale: numOrNull(eq.maxScale) ?? -1,
    magnitude: numOrNull(eq.magnitude?.value),
    depthKm: numOrNull(eq.depth?.value),
    points: (Array.isArray(e.points) ? e.points : []).map((p) => ({
      pref: String(p?.pref ?? ""),
      addr: String(p?.addr ?? ""),
      scale: numOrNull(p?.scale) ?? -1,
    })),
  };
}

// 📊 Display order for intensity classes (descending).
export const STATS_SCALE_ORDER = [70, 60, 55, 50, 45, 40, 30, 20, 10];

export interface QuakeStats {
  total: number;
  byScale: { scale: number; count: number }[];
  byPref: { pref: string; count: number }[];
  byDay: { date: string; count: number }[];
  strongest: HistoryQuake | null;
}

// 📊 Aggregate the quakes inside the period (pure function; unit-tested).
// Per-prefecture counts count each quake once per prefecture no matter
// how many of its stations are in that prefecture.
export function aggregateQuakeStats(records: HistoryQuake[], days: number, nowMs = Date.now()): QuakeStats {
  const from = nowMs - days * 24 * 3600_000;
  const inRange = records.filter((r) => {
    const t = parseJstTime(r.time);
    return t !== null && t.getTime() >= from && t.getTime() <= nowMs + 3600_000;
  });
  const byScale = new Map<number, number>();
  const byPref = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const r of inRange) {
    if (r.maxScale > 0) byScale.set(r.maxScale, (byScale.get(r.maxScale) ?? 0) + 1);
    const prefs = new Set(r.points.map((p) => p.pref).filter(Boolean));
    for (const pref of prefs) byPref.set(pref, (byPref.get(pref) ?? 0) + 1);
    const t = parseJstTime(r.time)!;
    const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  // 📌 Records whose maximum intensity is unknown (prompt-only reports)
  // are folded into an "unknown" row so the per-scale counts still sum
  // to the total.
  const unknownCount = inRange.filter((r) => !STATS_SCALE_ORDER.includes(r.maxScale)).length;
  return {
    total: inRange.length,
    byScale: [
      ...STATS_SCALE_ORDER.filter((s) => byScale.has(s)).map((s) => ({ scale: s, count: byScale.get(s)! })),
      ...(unknownCount > 0 ? [{ scale: -1, count: unknownCount }] : []),
    ],
    byPref: [...byPref.entries()].map(([pref, count]) => ({ pref, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    byDay: [...byDay.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    strongest: inRange.reduce<HistoryQuake | null>((best, r) => (best === null || r.maxScale > best.maxScale ? r : best), null),
  };
}

// 📥 Page through the P2P history API (stats page only).
export async function fetchHistory(code: number, pages: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < pages; i++) {
    const json = await fetchJson(`${P2P_HISTORY}?codes=${code}&limit=100&offset=${i * 100}`, 15_000);
    if (!Array.isArray(json) || json.length === 0) break;
    out.push(...json);
    if (json.length < 100) break;
  }
  return out;
}
