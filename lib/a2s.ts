/* bosai — A.A.S (A2S) client.
   Event data (quakes, EEW, tsunami, warnings, typhoons) comes only from
   the A2S public API; there is deliberately no direct P2P / Wolfx
   fallback (the stats page's long-range aggregation is the one documented
   exception). The contract is defined by the aegis-alert-system repo's
   API.md. Semantics follow the verified reference behaviour:
   - SSE is the primary channel; REST `since=` recovers anything missed.
   - An event is a duplicate when its key + updatedAt pair is already seen.
   - The browser holds no credential: it only talks to the same-origin
     proxy (lib/config.ts), which attaches the token server-side.
   When no endpoint is configured the client reports enabled=false and the
   UI shows an empty state instead of attempting connections. */

import { A2S_BASE_URL } from "./config";
import { GRADE_RANK, HYPOCENTER_NEAR_KM, haversineKm, numOrNull, parseJstTime } from "./core";

// ==========================================
// 📐 Types
// ==========================================
export interface A2sConfig {
  enabled: boolean;
  baseUrl: string;
}

// 📥 An event as delivered by A2S (raw, not yet validated).
export type A2sEvent = {
  kind: string;
  key: string;
  updatedAt?: unknown;
  [name: string]: unknown;
};

export interface QuakePoint {
  pref: string;
  addr: string;
  isArea: boolean;
  scale: number;
}

export interface QuakeRecord {
  id: string;
  a2sKey: string;
  time: string;
  issueTime: string;
  issueType: string;
  typeRank: number;
  hypocenter: string | null;
  magnitude: number | null;
  depthKm: number | null;
  maxScale: number;
  tsunamiKind: string;
  tsunamiText: string | null;
  foreign: boolean;
  lat: number | null;
  lon: number | null;
  points: QuakePoint[];
  source: string;
}

export interface MaxObserved {
  scale: number;
  addr: string;
  count: number;
  isArea: boolean;
}

export interface MergedQuake {
  id: string;
  ids: string[];
  a2sKey: string | null;
  time: string;
  types: string[];
  hasDetail: boolean;
  hypocenter: string;
  magnitude: number | null;
  depthKm: number | null;
  maxScale: number;
  tsunamiKind: string;
  tsunamiText: string | null;
  foreign: boolean;
  lat: number | null;
  lon: number | null;
  points: QuakePoint[];
  maxPoint: MaxObserved | null;
}

export interface EewArea {
  pref: string;
  name: string;
  scale: number;
  scaleTo: number;
  arrival: string | null;
}

export interface EewValue {
  originTime: string;
  issueTime: string;
  cancel: boolean;
  isFinal: boolean;
  isWarn: boolean;
  serial: number | null;
  eventId: string | null;
  isAssumption: boolean;
  hypocenter: string;
  estScale: number;
  estDepthKm: number | null;
  estMagnitude: number | null;
  prefs: string[];
  areas: EewArea[];
  lat: number | null;
  lon: number | null;
  key: string;
  source: string;
}

export interface TsunamiArea {
  name: string;
  grade: string;
  cancelled: boolean;
  maxHeight: string | null;
  maxHeightValue: number | null;
  arrival: string | null;
}

export interface TsunamiValue {
  time: string;
  cancelled: boolean;
  grade: string;
  areas: TsunamiArea[];
  source: string;
}

export interface WarningItem {
  code: string;
  name: string;
  status: string;
  severity: number;
}

export interface WarningValue {
  key: string;
  prefName: string;
  areaName: string;
  headline: string;
  reportDatetime: string;
  maxSeverity: number;
  released: boolean;
  warnings: WarningItem[];
  source: string;
}

export interface TyphoonValue {
  key: string;
  number: number | null;
  name: string;
  englishName: string;
  time: string;
  lines: string[];
  source: string;
}

export interface A2sStatus {
  eewDelivery?: boolean;
  [name: string]: unknown;
}

// ==========================================
// 🎛️ Configuration
// ==========================================
// 🎛️ Normalise a raw endpoint value. Enabled only for a same-origin path
// (starting with "/") or an http/https URL; trailing slashes are trimmed.
export function parseA2sConfig(rawUrl: unknown): A2sConfig {
  const baseUrl = String(rawUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { enabled: false, baseUrl: "" };
  if (baseUrl.startsWith("/")) return { enabled: true, baseUrl };
  let parsed: URL | null = null;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return { enabled: false, baseUrl: "" };
  }
  return { enabled: true, baseUrl };
}

// 🎛️ Build the config from the site settings (lib/config.ts).
export function loadA2sConfig(): A2sConfig {
  return parseA2sConfig(A2S_BASE_URL);
}

// 🌐 REST event-list URL under the proxy. `since` is an updatedAt lower
// bound (ISO 8601 or epoch ms); limit defaults to 50.
export function a2sEventsUrl(config: A2sConfig, since: string | number | null = null, opts: { kind?: string; limit?: number } = {}): string {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.trunc(opts.limit) : 50;
  let url = `${config.baseUrl}/events?limit=${limit}`;
  if (opts?.kind) url += `&kind=${encodeURIComponent(String(opts.kind))}`;
  if (since) url += `&since=${encodeURIComponent(String(since))}`;
  return url;
}

// 🌐 SSE stream URL under the proxy (no credential is attached here; the
// proxy authenticates server-side).
export function a2sStreamUrl(config: A2sConfig): string {
  return `${config.baseUrl}/stream`;
}

// ==========================================
// 🔍 Validation and conversion
// ==========================================
type Raw = Record<string, unknown>;

// 🔍 Minimal shape check per event kind; anything missing a required field
// is rejected rather than partially displayed.
export function isA2sEvent(v: unknown): v is A2sEvent {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const ev = v as Raw;
  if (typeof ev.key !== "string" || ev.key === "") return false;
  if (ev.kind === "quake") {
    return (
      typeof ev.time === "string" &&
      typeof ev.hypocenter === "string" &&
      typeof ev.maxScale === "number" &&
      Array.isArray(ev.points) &&
      Array.isArray(ev.prefScales)
    );
  }
  if (ev.kind === "eew") {
    return (
      typeof ev.originTime === "string" &&
      typeof ev.estScale === "number" &&
      typeof ev.isWarn === "boolean" &&
      typeof ev.cancel === "boolean"
    );
  }
  if (ev.kind === "tsunami") {
    return typeof ev.grade === "string" && Array.isArray(ev.areas);
  }
  if (ev.kind === "warning") {
    return Array.isArray(ev.warnings) && typeof ev.maxSeverity === "number";
  }
  if (ev.kind === "typhoon") {
    return typeof ev.time === "string";
  }
  return false;
}

// 🏷️ Telegram-type priority used when merging reports of one quake.
export const QUAKE_TYPE_RANK: Record<string, number> = { DetailScale: 4, ScaleAndDestination: 3, Foreign: 3, Destination: 2, ScalePrompt: 1 };

// 🌋 Convert an A2S quake event into a display record. A2S points carry the
// station name in `name`, which becomes `addr` here.
export function a2sQuakeToRecord(ev: unknown): QuakeRecord | null {
  if (!isA2sEvent(ev) || ev.kind !== "quake") return null;
  const rawPoints = Array.isArray(ev.points) ? (ev.points as Raw[]) : [];
  let points: QuakePoint[] = rawPoints
    .map((p) => ({
      pref: String(p?.pref ?? ""),
      addr: String(p?.name ?? p?.addr ?? ""),
      isArea: Boolean(p?.isArea),
      scale: numOrNull(p?.scale) ?? -1,
    }))
    .filter((p) => p.addr || p.pref);
  // 📈 Reports without observation points fall back to per-prefecture
  // maximum intensities, marked as area values.
  if (points.length === 0 && Array.isArray(ev.prefScales)) {
    points = (ev.prefScales as Raw[])
      .map((p) => ({
        pref: String(p?.pref ?? ""),
        addr: String(p?.pref ?? ""),
        isArea: true,
        scale: numOrNull(p?.scale) ?? -1,
      }))
      .filter((p) => p.addr);
  }
  const mag = numOrNull(ev.magnitude);
  const depth = numOrNull(ev.depthKm);
  const lat = numOrNull(ev.lat);
  const lon = numOrNull(ev.lon);
  const issueType = String(ev.issueType ?? "");
  // 📌 A hypocenter of 「不明」 is a missing-value marker (e.g. in prompt
  // reports), not a name; treat it as absent so the report can merge into
  // the named group for the same moment.
  const rawName = String(ev.hypocenter ?? "").trim();
  const name = rawName === "不明" ? "" : rawName;
  return {
    // 📌 The primary telegram id doubles as the detail-page lookup id.
    id: String(ev.telegramId ?? "") || ev.key,
    a2sKey: ev.key,
    time: String(ev.time ?? ""),
    issueTime: String(ev.announcedTime ?? ev.time ?? ""),
    issueType,
    typeRank: QUAKE_TYPE_RANK[issueType] ?? 0,
    hypocenter: name || null,
    magnitude: mag !== null && mag >= 0 ? mag : null,
    depthKm: depth !== null && depth >= 0 ? depth : null,
    maxScale: numOrNull(ev.maxScale) ?? -1,
    tsunamiKind: String(ev.tsunamiKind ?? "Unknown"),
    tsunamiText: typeof ev.tsunamiText === "string" ? ev.tsunamiText : null,
    foreign: Boolean(ev.foreign),
    lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    lon: lon !== null && lon >= -180 && lon <= 180 ? lon : null,
    points,
    source: "a2s",
  };
}

// 📈 The strongest observed point: real stations (isArea=false) win over
// area values; ties report how many points share the maximum.
export function maxObservedPoint(points: QuakePoint[]): MaxObserved | null {
  if (!Array.isArray(points)) return null;
  const valid = points.filter((p) => p.scale >= 0 && (p.addr || p.pref));
  const stations = valid.filter((p) => !p.isArea);
  const pool = stations.length ? stations : valid;
  if (!pool.length) return null;
  const max = Math.max(...pool.map((p) => p.scale));
  const tops = pool.filter((p) => p.scale === max);
  return { scale: max, addr: tops[0].addr || tops[0].pref, count: tops.length, isArea: !stations.length };
}

// 🌋 Merge the reports of one quake into a single record: the most complete
// report is primary, missing fields are filled from the others, and points
// are unioned keeping the maximum intensity per station.
export function mergeQuakeGroup(records: QuakeRecord[]): MergedQuake {
  const sorted = [...records].sort((a, b) =>
    b.typeRank - a.typeRank || (a.issueTime < b.issueTime ? 1 : a.issueTime > b.issueTime ? -1 : 0)
  );
  const pick = <T,>(fn: (r: QuakeRecord) => T | null | undefined): T | null => {
    for (const r of sorted) {
      const v = fn(r);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const primary = sorted[0];
  const pointMap = new Map<string, QuakePoint>();
  for (const r of records) {
    for (const p of r.points ?? []) {
      const key = `${p.pref}|${p.addr}|${p.isArea ? 1 : 0}`;
      const prev = pointMap.get(key);
      if (!prev || p.scale > prev.scale) pointMap.set(key, { ...p });
    }
  }
  const points = [...pointMap.values()];
  return {
    id: primary.id,
    ids: records.map((r) => r.id).filter(Boolean),
    a2sKey: pick((r) => r.a2sKey),
    time: primary.time,
    types: [...new Set(records.map((r) => r.issueType).filter(Boolean))],
    hasDetail: records.some((r) => r.issueType === "DetailScale"),
    hypocenter: pick((r) => r.hypocenter) ?? "不明",
    magnitude: pick((r) => r.magnitude),
    depthKm: pick((r) => r.depthKm),
    maxScale: pick((r) => (r.maxScale >= 0 ? r.maxScale : null)) ?? -1,
    tsunamiKind: pick((r) => (r.tsunamiKind !== "Checking" && r.tsunamiKind !== "Unknown" ? r.tsunamiKind : null)) ?? primary.tsunamiKind,
    tsunamiText: pick((r) => r.tsunamiText),
    foreign: records.some((r) => r.foreign),
    lat: pick((r) => r.lat),
    lon: pick((r) => r.lon),
    points,
    maxPoint: maxObservedPoint(points),
  };
}

// 🌋 Group records by quake and merge each group. Grouping is by
// origin time + hypocenter name; unnamed reports join the single named
// group at the same time, and groups at the same time whose hypocentres
// are within HYPOCENTER_NEAR_KM are fused as well.
export function mergeQuakeRecords(records: QuakeRecord[], limit = 10): MergedQuake[] {
  const groups = new Map<string, QuakeRecord[]>();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec) continue;
    const key = rec.time ? `${rec.time}|${rec.hypocenter ?? ""}` : `id:${rec.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rec);
  }
  for (const [key, recs] of [...groups]) {
    if (!key.endsWith("|")) continue;
    const time = key.slice(0, -1);
    const named = [...groups.keys()].filter((k) => k.startsWith(`${time}|`) && !k.endsWith("|"));
    if (named.length === 1) {
      groups.get(named[0])!.push(...recs);
      groups.delete(key);
    }
  }
  const groupList = [...groups.values()];
  const times = groupList.map((recs) => recs[0]?.time ?? "");
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    outer: for (let i = 0; i < groupList.length; i++) {
      for (let j = i + 1; j < groupList.length; j++) {
        if (!times[i] || times[i] !== times[j]) continue;
        const near = groupList[i].some((a) => {
          if (a.lat === null || a.lon === null) return false;
          const { lat, lon } = a;
          return groupList[j].some(
            (b) => b.lat !== null && b.lon !== null && haversineKm(lat, lon, b.lat, b.lon) <= HYPOCENTER_NEAR_KM
          );
        });
        if (near) {
          groupList[i].push(...groupList[j]);
          groupList.splice(j, 1);
          times.splice(j, 1);
          mergedAny = true;
          break outer;
        }
      }
    }
  }
  return groupList.map(mergeQuakeGroup).slice(0, limit);
}

// 🔑 Identity key for one EEW sequence: origin time + rounded hypocentre
// coordinates (or the name when coordinates are absent); cancellations
// get their own key via the "-cancel" suffix.
export function roundedCoordKey(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return "";
  return `@${lat.toFixed(1)},${lon.toFixed(1)}`;
}
export function eewIdentityKey(originTime: string, hypocenter: string, lat: number | null, lon: number | null, cancel: boolean): string {
  const coordKey = roundedCoordKey(lat, lon);
  const base = coordKey ? `eew-${originTime}${coordKey}` : `eew-${originTime}-${hypocenter}`;
  return base + (cancel ? "-cancel" : "");
}

// 🚨 Convert an A2S EEW event into a display value. Per-area expected
// intensities (areaScales) are joined with per-prefecture arrival estimates
// (areaArrivals) by prefecture; arrival times render as "HH:MM".
export function a2sEewToValue(ev: unknown): EewValue | null {
  if (!isA2sEvent(ev) || ev.kind !== "eew") return null;
  const arrivalByPref = new Map<string, string>();
  for (const a of Array.isArray(ev.areaArrivals) ? (ev.areaArrivals as Raw[]) : []) {
    const pref = String(a?.pref ?? "");
    const at = typeof a?.arrivalTime === "string" ? a.arrivalTime : "";
    if (pref && at && !arrivalByPref.has(pref)) {
      arrivalByPref.set(pref, at.length >= 16 ? at.slice(11, 16) : at);
    }
  }
  const areas: EewArea[] = (Array.isArray(ev.areaScales) ? (ev.areaScales as Raw[]) : []).map((a) => {
    const pref = String(a?.pref ?? "");
    return {
      pref,
      name: String(a?.name ?? pref),
      scale: numOrNull(a?.scale) ?? -1,
      scaleTo: numOrNull(a?.scaleTo) ?? -1,
      arrival: arrivalByPref.get(pref) ?? null,
    };
  });
  const prefs: string[] = [];
  for (const p of Array.isArray(ev.prefs) ? ev.prefs : []) {
    const pref = String(p ?? "");
    if (pref && !prefs.includes(pref)) prefs.push(pref);
  }
  if (prefs.length === 0) {
    for (const a of areas) if (a.pref && !prefs.includes(a.pref)) prefs.push(a.pref);
  }
  const mag = numOrNull(ev.estMagnitude);
  const depth = numOrNull(ev.depthKm);
  const lat = numOrNull(ev.lat);
  const lon = numOrNull(ev.lon);
  const originTime = String(ev.originTime ?? "");
  const hypocenter = String(ev.hypocenter ?? "不明");
  const cancel = Boolean(ev.cancel);
  return {
    originTime,
    issueTime: String(ev.time ?? ""),
    cancel,
    isFinal: Boolean(ev.isFinal),
    isWarn: Boolean(ev.isWarn),
    serial: numOrNull(ev.serial),
    eventId: ev.eventId !== null && ev.eventId !== undefined && ev.eventId !== "" ? String(ev.eventId) : null,
    isAssumption: Boolean(ev.isAssumption),
    hypocenter,
    estScale: numOrNull(ev.estScale) ?? -1,
    estDepthKm: depth !== null && depth >= 0 ? depth : null,
    estMagnitude: mag !== null && mag >= 0 ? mag : null,
    prefs,
    areas,
    lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    lon: lon !== null && lon >= -180 && lon <= 180 ? lon : null,
    key: eewIdentityKey(originTime, hypocenter, lat, lon, cancel),
    source: "a2s",
  };
}

// 📢 Compare two timestamp strings (positive when a is newer). Falls back
// to string comparison when either side cannot be parsed.
export function compareTimeStr(a: string, b: string): number {
  const da = parseJstTime(a);
  const db = parseJstTime(b);
  if (da && db) return da.getTime() - db.getTime();
  if (da) return 1;
  if (db) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// 📢 Merge EEW values: the newer issue wins so the display never rewinds;
// at the same instant, an upgrade from forecast to warning takes priority.
export function mergeEewValue(current: EewValue | null, candidate: EewValue | null): EewValue | null {
  if (!candidate) return current ?? null;
  if (!current) return candidate;
  const cmp = compareTimeStr(candidate.issueTime ?? "", current.issueTime ?? "");
  if (cmp > 0) return candidate;
  if (cmp < 0) return current;
  if (candidate.key === current.key && candidate.isWarn && !current.isWarn) return candidate;
  if (current.key === candidate.key && current.isWarn && !candidate.isWarn) return current;
  return candidate;
}

// 🌊 Convert an A2S tsunami event into a display value. An event-level
// grade outside the known ranks is recomputed from the strongest area.
export function a2sTsunamiToValue(ev: unknown): TsunamiValue | null {
  if (!isA2sEvent(ev) || ev.kind !== "tsunami") return null;
  const cancelled = Boolean(ev.cancelled);
  const areas: TsunamiArea[] = (Array.isArray(ev.areas) ? (ev.areas as Raw[]) : []).map((a) => {
    const at = typeof a?.arrivalLabel === "string" ? a.arrivalLabel : null;
    return {
      name: String(a?.name ?? ""),
      grade: String(a?.grade ?? ""),
      cancelled,
      maxHeight: typeof a?.maxHeightLabel === "string" ? a.maxHeightLabel : null,
      maxHeightValue: numOrNull(a?.maxHeightValue),
      arrival: at ? (at.length >= 16 ? at.slice(11, 16) : at) : null,
    };
  });
  let grade = String(ev.grade ?? "Unknown");
  if (!(grade in GRADE_RANK) && grade !== "Unknown") {
    grade = "Unknown";
    for (const a of areas) {
      if (!a.cancelled && (GRADE_RANK[a.grade] ?? 0) > (GRADE_RANK[grade] ?? 0)) grade = a.grade;
    }
  }
  return { time: String(ev.time ?? ""), cancelled, grade, areas, source: "a2s" };
}

// 🌊 Merge tsunami values: the newer issue wins; ties keep the current one.
export function mergeTsunamiValue(current: TsunamiValue | null, candidate: TsunamiValue | null): TsunamiValue | null {
  if (!candidate) return current ?? null;
  if (!current) return candidate;
  return compareTimeStr(candidate.time ?? "", current.time ?? "") > 0 ? candidate : current;
}

// 🌦️ Convert an A2S warning event (one per primary subdivision) into a
// display value.
export function a2sWarningToValue(ev: unknown): WarningValue | null {
  if (!isA2sEvent(ev) || ev.kind !== "warning") return null;
  return {
    key: ev.key,
    prefName: String(ev.prefName ?? ""),
    areaName: String(ev.areaName ?? ""),
    headline: String(ev.headline ?? ""),
    reportDatetime: String(ev.reportDatetime ?? ev.time ?? ""),
    maxSeverity: numOrNull(ev.maxSeverity) ?? 0,
    released: Boolean(ev.released),
    warnings: (Array.isArray(ev.warnings) ? (ev.warnings as Raw[]) : []).map((w) => ({
      code: String(w?.code ?? ""),
      name: String(w?.name ?? ""),
      status: String(w?.status ?? ""),
      severity: numOrNull(w?.severity) ?? 0,
    })),
    source: "a2s",
  };
}

// 🌀 Convert an A2S typhoon event into a display value.
export function a2sTyphoonToValue(ev: unknown): TyphoonValue | null {
  if (!isA2sEvent(ev) || ev.kind !== "typhoon") return null;
  return {
    key: ev.key,
    number: numOrNull(ev.number),
    name: String(ev.name ?? ""),
    englishName: String(ev.englishName ?? ""),
    time: String(ev.time ?? ""),
    lines: (Array.isArray(ev.lines) ? ev.lines : []).map((l) => String(l ?? "")),
    source: "a2s",
  };
}

// ==========================================
// 🗃 Event store
// ==========================================
// 🗃 Quakes are kept per key, EEW and tsunami as single latest values,
// warnings as the active set keyed by event key (a release only removes
// the entry; releases are delivered over SSE only, per the API contract),
// and typhoons per key.
const a2sQuakeRecords = new Map<string, QuakeRecord>();
const a2sWarningValues = new Map<string, WarningValue>();
const a2sTyphoonValues = new Map<string, TyphoonValue>();
let a2sEewValue: EewValue | null = null;
let a2sTsunamiValue: TsunamiValue | null = null;
// 🔍 Duplicate detection: key + updatedAt.
const a2sSeenUpdatedAt = new Map<string, string>();
// 🕐 The newest updatedAt seen, used as the REST `since=` lower bound.
let a2sLastUpdatedAt: string | null = null;
// 🔄 Change hook the page installs to re-render.
let a2sOnChange: (() => void) | null = null;

export function setA2sOnChange(fn: (() => void) | null): void {
  a2sOnChange = typeof fn === "function" ? fn : null;
}

// 🗃 Clear all retained state.
export function resetA2sStore(): void {
  a2sQuakeRecords.clear();
  a2sWarningValues.clear();
  a2sTyphoonValues.clear();
  a2sSeenUpdatedAt.clear();
  a2sEewValue = null;
  a2sTsunamiValue = null;
  a2sLastUpdatedAt = null;
}

// 🚨 The current EEW value (null when none).
export function currentEew(): EewValue | null {
  return a2sEewValue;
}

// 🌊 The current tsunami value (cancelled values are kept so the banner
// logic can apply its display window).
export function currentTsunami(): TsunamiValue | null {
  return a2sTsunamiValue;
}

// 🌀 Retained typhoons, newest issue first.
export function activeTyphoons(): TyphoonValue[] {
  return [...a2sTyphoonValues.values()].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// 🌋 The retained quakes, merged and newest first.
export function mergedQuakeList(limit = 10): MergedQuake[] {
  const merged = mergeQuakeRecords([...a2sQuakeRecords.values()], Number.MAX_SAFE_INTEGER);
  merged.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return merged.slice(0, limit);
}

// 🌦️ Currently active warnings, ordered by severity, prefecture, area.
export function activeWarnings(): WarningValue[] {
  return [...a2sWarningValues.values()].sort(
    (a, b) =>
      b.maxSeverity - a.maxSeverity ||
      (a.prefName < b.prefName ? -1 : a.prefName > b.prefName ? 1 : 0) ||
      (a.areaName < b.areaName ? -1 : a.areaName > b.areaName ? 1 : 0)
  );
}

// 📥 Apply one event to the store. Returns "applied" (state changed),
// "duplicate" (key + updatedAt already seen) or "invalid" (bad shape).
export function applyA2sEvent(ev: unknown): "applied" | "duplicate" | "invalid" {
  if (!isA2sEvent(ev)) return "invalid";
  const updatedAt = typeof ev.updatedAt === "string" ? ev.updatedAt : "";
  if (a2sSeenUpdatedAt.has(ev.key) && a2sSeenUpdatedAt.get(ev.key) === updatedAt) return "duplicate";
  if (ev.kind === "quake") {
    const converted = a2sQuakeToRecord(ev);
    if (!converted) return "invalid";
    a2sQuakeRecords.set(ev.key, converted);
  } else if (ev.kind === "eew") {
    const converted = a2sEewToValue(ev);
    if (!converted) return "invalid";
    a2sEewValue = mergeEewValue(a2sEewValue, converted);
  } else if (ev.kind === "tsunami") {
    const converted = a2sTsunamiToValue(ev);
    if (!converted) return "invalid";
    a2sTsunamiValue = mergeTsunamiValue(a2sTsunamiValue, converted);
  } else if (ev.kind === "warning") {
    const converted = a2sWarningToValue(ev);
    if (!converted) return "invalid";
    // 📌 A release is never retained; it only leaves the active set.
    if (converted.released || converted.warnings.length === 0) a2sWarningValues.delete(ev.key);
    else a2sWarningValues.set(ev.key, converted);
  } else if (ev.kind === "typhoon") {
    const converted = a2sTyphoonToValue(ev);
    if (!converted) return "invalid";
    a2sTyphoonValues.set(ev.key, converted);
  } else {
    return "invalid";
  }
  a2sSeenUpdatedAt.set(ev.key, updatedAt);
  if (updatedAt && (a2sLastUpdatedAt === null || updatedAt > a2sLastUpdatedAt)) {
    a2sLastUpdatedAt = updatedAt;
  }
  return "applied";
}

// ==========================================
// 📥 REST fetch (initial sync and gap recovery)
// ==========================================
// 📥 Fetch JSON through the proxy with a timeout.
export async function fetchA2sJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 📥 Fetch the event list and merge it into the store (initial-sync style:
// applied oldest-first for stable merging, and the change hook fires once
// at the end if anything changed). Failures return false, never throw.
export async function refreshA2sEvents(config: A2sConfig = loadA2sConfig()): Promise<boolean> {
  if (!config?.enabled) return false;
  try {
    const data = (await fetchA2sJson(a2sEventsUrl(config, a2sLastUpdatedAt, { limit: 200 }))) as { events?: unknown[] } | null;
    const events = Array.isArray(data?.events) ? data.events : [];
    let changed = false;
    // 📌 REST returns newest-first; apply in reverse so merges settle.
    for (const ev of [...events].reverse()) {
      if (applyA2sEvent(ev) === "applied") changed = true;
    }
    if (changed && a2sOnChange) a2sOnChange();
    return true;
  } catch {
    return false;
  }
}

// 🌋 Fetch quake events and return them merged (used by /quakes and
// /quake). A2S retains 72 hours, so older quakes cannot be resolved.
// Disabled config yields an empty list; fetch failures throw so the
// caller can show an error state.
export async function fetchA2sQuakes(config: A2sConfig = loadA2sConfig(), limit = 100): Promise<MergedQuake[]> {
  if (!config?.enabled) return [];
  const data = (await fetchA2sJson(a2sEventsUrl(config, null, { kind: "quake", limit }))) as { events?: unknown[] } | null;
  const events = Array.isArray(data?.events) ? data.events : [];
  const records: QuakeRecord[] = [];
  for (const ev of events) {
    const rec = a2sQuakeToRecord(ev);
    if (rec) records.push(rec);
  }
  const merged = mergeQuakeRecords(records, Number.MAX_SAFE_INTEGER);
  merged.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return merged;
}

// 🛰 Fetch the A2S status through the proxy. Null when disabled; failures
// throw.
export async function fetchA2sStatus(config: A2sConfig = loadA2sConfig()): Promise<A2sStatus | null> {
  if (!config?.enabled) return null;
  return (await fetchA2sJson(`${config.baseUrl}/status`)) as A2sStatus;
}

// ==========================================
// 🌐 SSE subscription (primary channel)
// ==========================================
let a2sEventSource: EventSource | null = null;
let a2sStreamConfigKey = "";

// 🌐 Start the SSE subscription. EventSource reconnects on its own; after
// a reconnect the server replays retained events, which are held back
// (treated as replay) until the `ready` frame arrives, then reflected in
// one batch — the same replay guard the reference bot client uses.
export function startA2sStream(config: A2sConfig = loadA2sConfig()): boolean {
  if (!config?.enabled || typeof EventSource === "undefined") return false;
  const configKey = config.baseUrl;
  if (a2sEventSource && a2sStreamConfigKey === configKey) return true;
  stopA2sStream();
  let es: EventSource;
  try {
    es = new EventSource(a2sStreamUrl(config));
  } catch {
    return false;
  }
  a2sEventSource = es;
  a2sStreamConfigKey = configKey;
  // 📌 Until `ready`, incoming frames are the connect-time replay.
  let replay = true;
  let replayChanged = false;
  es.addEventListener("ready", () => {
    replay = false;
    if (replayChanged) {
      replayChanged = false;
      if (a2sOnChange) a2sOnChange();
    }
  });
  for (const kind of ["quake", "eew", "tsunami", "warning", "typhoon", "flood", "sediment", "tornado", "record-rain", "linear-rain", "volcano", "heat"]) {
    es.addEventListener(kind, (event) => {
      let ev: A2sEvent;
      try {
        ev = JSON.parse((event as MessageEvent).data) as A2sEvent;
      } catch {
        return;
      }
      if (!ev || ev.kind !== kind) return;
      if (applyA2sEvent(ev) !== "applied") return;
      if (replay) replayChanged = true;
      else if (a2sOnChange) a2sOnChange();
    });
  }
  es.addEventListener("error", () => {
    // 📌 EventSource reconnects automatically; the next connection starts
    // with a replay again, so return to replay mode until `ready`.
    replay = true;
  });
  return true;
}

// 🛑 Stop the SSE subscription.
export function stopA2sStream(): void {
  if (a2sEventSource) {
    try {
      a2sEventSource.close();
    } catch {
      /* Already closed: nothing to do. */
    }
    a2sEventSource = null;
  }
  a2sStreamConfigKey = "";
}

// ==========================================
// 🏷️ Source credit
// ==========================================
// 🏷️ Per the A2S API.md §6 handling of edited telegrams, displays derived
// from A2S events carry the source (JMA / P2P) plus "｜A.A.S 編集電文",
// matching the Aegis Discord bot's footer format.
export const EVENT_SOURCE_CREDIT = "出典: 気象庁・P2P地震情報｜A.A.S 編集電文";
export function eventSourceLine(variant?: string): string {
  if (variant === "quakes") {
    return "地震情報: A.A.S（Aegis Alert System）から取得（出典: 気象庁・P2P地震情報｜A.A.S 編集電文）";
  }
  return "地震・津波・EEW・警報: A.A.S（Aegis Alert System）から取得（出典: 気象庁・P2P地震情報｜A.A.S 編集電文）";
}
