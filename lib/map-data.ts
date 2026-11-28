/* bosai — data resolution for map drawing.
   The lookup rules are a browser port of the Aegis Discord bot's
   eew-area-polygons / eew-area-coords / tsunami-coastline resolvers.
   Data is lazy-loaded from the A.A.S master-data API through the
   same-origin proxy (/api/a2s/master/<name>) and cached per page
   (master data moved from bundled JSON files to A.A.S in v1.1.0 of the
   previous implementation):
   - intensity stations: master/stations (from the JMA station code
     table; shared by the list page and map coordinate lookup, keyed by
     the station name in `addr`)
   - EEW subdivision polygons: master/eew-polygons (derived from the
     JMA disaster-information area dataset by NII, CC BY 4.0)
   - tsunami zone coastlines: master/coastline (from Natural Earth)
   - tsunami zone representative points: master/tsunami-zones */

import type { EewValue, MergedQuake, TsunamiValue } from "./a2s";
import { fetchJson } from "./core";
import { isValidCoord } from "./map-geo";

// ==========================================
// 📐 Types
// ==========================================
// 📍 Polygons are lists of polygons, each a list of rings of [lon, lat].
export type LonLat = [number, number];
export type Polygon = LonLat[][];
export type MultiPolygon = Polygon[];

export interface StationCoord {
  lat: number;
  lon: number;
}

export interface EewPolygonEntry {
  name: string;
  pref: string;
  polygons: MultiPolygon;
  key: string;
}

export interface EewPolygonIndex {
  entries: EewPolygonEntry[];
  byKey: Map<string, EewPolygonEntry>;
  byPrefCore: Map<string, Map<string, EewPolygonEntry>>;
  coreCounts: Map<string, number>;
}

export interface EewFill {
  name: string;
  pref: string;
  scale: number;
  scaleTo: number;
  openEnded: boolean;
  polygons: MultiPolygon | null;
  lat: number | null;
  lon: number | null;
}

export interface TsunamiCoastArea {
  name: string;
  grade: string;
  maxHeight: string | null;
  maxHeightValue: number | null;
  arrival: string | null;
  lines: LonLat[][];
  lat: number;
  lon: number;
}

export interface TsunamiZoneArea {
  name: string;
  grade: string;
  maxHeight: string | null;
  arrival: string | null;
  lat: number;
  lon: number;
}

export interface PlotPoint {
  name: string;
  scale: number;
  lat: number;
  lon: number;
}

interface StationsData {
  stations?: { addr?: unknown; lat?: unknown; lon?: unknown }[];
}
interface StationPrefsData {
  prefs?: Record<string, string>;
}
interface EewPolygonsData {
  regions?: Record<string, { pref?: unknown; polygons?: unknown }>;
}
interface CoastlineData {
  zones?: Record<string, LonLat[][]>;
}
interface TsunamiZonesData {
  zones?: Record<string, { lat: number; lon: number }>;
}

export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

// 📌 Full prefecture name → prefix-matching short form.
export function prefCore(full: string): string {
  if (full === "北海道") return full;
  return full.replace(/(県|府|都)$/, "");
}
// 🏷️ Normalise a prefecture written in either form to the full name.
export function normalizePref(pref: unknown): string | null {
  if (typeof pref !== "string") return null;
  const s = pref.trim();
  if (s === "") return null;
  for (const full of PREFECTURES) {
    if (s === full || s === prefCore(full)) return full;
  }
  return null;
}

// ==========================================
// 📥 Lazy loading (per-page cache)
// ==========================================
const mapDataCache = new Map<string, Promise<unknown>>();
export function loadMapData(url: string): Promise<unknown> {
  if (!mapDataCache.has(url)) {
    mapDataCache.set(
      url,
      fetchJson(url, 30_000).catch(() => null)
    );
  }
  return mapDataCache.get(url)!;
}
export const loadStations = (): Promise<StationsData | null> =>
  loadMapData("/api/a2s/master/stations") as Promise<StationsData | null>;
export const loadStationPrefs = async (): Promise<StationPrefsData | null> =>
  normalizeStationPrefs(await loadMapData("/api/a2s/master/station-prefs"));
export const loadEewPolygons = async (): Promise<EewPolygonsData | null> =>
  normalizeEewPolygons(await loadMapData("/api/a2s/master/eew-polygons"));
export const loadCoastline = (): Promise<CoastlineData | null> =>
  loadMapData("/api/a2s/master/coastline") as Promise<CoastlineData | null>;
export const loadTsunamiZones = async (): Promise<TsunamiZonesData | null> =>
  normalizeTsunamiZones(await loadMapData("/api/a2s/master/tsunami-zones"));

// 📌 Normalise master-data response shapes. The A.A.S contract returns
// the bare payload for station-prefs (a {station: prefecture} map),
// eew-polygons (regions) and tsunami-zones (zones); wrapped shapes
// ({prefs: ...} etc.) are accepted too and yield identical results.
export function normalizeStationPrefs(data: unknown): StationPrefsData | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const prefs = rec.prefs && typeof rec.prefs === "object" ? rec.prefs : rec;
  return { prefs: prefs as Record<string, string> };
}
export function normalizeEewPolygons(data: unknown): EewPolygonsData | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const regions = rec.regions && typeof rec.regions === "object" ? rec.regions : rec;
  return { regions: regions as EewPolygonsData["regions"] };
}
export function normalizeTsunamiZones(data: unknown): TsunamiZonesData | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const zones = rec.zones && typeof rec.zones === "object" ? rec.zones : rec;
  return { zones: zones as TsunamiZonesData["zones"] };
}

// 📍 Build the station-name (stations' addr) → coordinate index.
export function stationCoordIndex(data: StationsData | null): Map<string, StationCoord> {
  const map = new Map<string, StationCoord>();
  for (const s of Array.isArray(data?.stations) ? data.stations : []) {
    if (s && typeof s.addr === "string" && isValidCoord(s.lat, s.lon)) {
      map.set(s.addr, { lat: s.lat as number, lon: s.lon as number });
    }
  }
  return map;
}

// 🌋 Convert a quake record's points into coordinate-bearing plot points.
// Area values are surface information and excluded. Stations that cannot
// be resolved are counted, not drawn; duplicates collapse to the maximum.
export function resolveQuakePoints(
  record: MergedQuake | null,
  coordIndex: Map<string, StationCoord>
): { points: PlotPoint[]; unresolved: number } {
  const points: PlotPoint[] = [];
  let unresolved = 0;
  // 📌 One marker per station: collapse duplicates at the maximum scale.
  const byName = new Map<string, PlotPoint>();
  for (const p of record?.points ?? []) {
    if (p.isArea || !(p.scale > 0)) continue;
    const c = coordIndex.get(p.addr);
    if (!c) {
      unresolved++;
      continue;
    }
    const prev = byName.get(p.addr);
    if (!prev || p.scale > prev.scale) {
      byName.set(p.addr, { name: p.addr, scale: p.scale, lat: c.lat, lon: c.lon });
    }
  }
  points.push(...byName.values());
  return { points, unresolved };
}

// ==========================================
// 🚨 EEW subdivision polygon resolution (bot rules)
// ==========================================
// 🔢 Full-width digits → half-width (東京都２３区 ⇔ 東京都23区).
export function normalizeEewAreaName(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
// 🏷️ Match key: normalised, with every 「地方」 removed (including the one
// that follows a direction word).
export function eewMatchKey(s: unknown): string {
  return normalizeEewAreaName(s).replace(/地方/g, "");
}
// 🏷️ The area name minus its prefecture prefix.
export function eewCoreName(name: string, prefFull: string): string {
  const key = eewMatchKey(name);
  if (key.startsWith(prefFull)) return key.slice(prefFull.length);
  const core = prefCore(prefFull);
  if (core !== prefFull && key.startsWith(core)) return key.slice(core.length);
  return key;
}

// 🗾 Index the polygon table (by name key, by prefecture+core name, and
// core-name occurrence counts).
export function indexEewPolygons(data: EewPolygonsData | null): EewPolygonIndex {
  const entries: EewPolygonEntry[] = [];
  const regions = data?.regions;
  if (regions && typeof regions === "object") {
    for (const [name, rec] of Object.entries(regions)) {
      if (typeof rec?.pref !== "string" || !Array.isArray(rec?.polygons)) continue;
      const polygons = (rec.polygons as MultiPolygon).filter(
        (poly) => Array.isArray(poly) && poly.every((ring) => Array.isArray(ring) && ring.length >= 4)
      );
      if (polygons.length > 0) entries.push({ name, pref: rec.pref, polygons, key: eewMatchKey(name) });
    }
  }
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const byPrefCore = new Map<string, Map<string, EewPolygonEntry>>();
  const coreCounts = new Map<string, number>();
  for (const e of entries) {
    const inner = byPrefCore.get(e.pref) ?? new Map<string, EewPolygonEntry>();
    inner.set(eewCoreName(e.name, e.pref), e);
    byPrefCore.set(e.pref, inner);
    const c = eewCoreName(e.name, e.pref);
    coreCounts.set(c, (coreCounts.get(c) ?? 0) + 1);
  }
  return { entries, byKey, byPrefCore, coreCounts };
}

// 📍 Infer the prefecture from an area name's prefix (fallback helper).
export function prefFromAreaName(name: string, entries: EewPolygonEntry[]): string | null {
  const key = eewMatchKey(name);
  for (const e of entries) {
    if (key.startsWith(e.pref) || key.startsWith(prefCore(e.pref))) return e.pref;
  }
  return null;
}

/**
 * Look up the polygon for one EEW subdivision, with the bot's matching
 * rules:
 * 1) direct match on the formal name (including the 地方-stripped form)
 * 2) core-name match narrowed by prefecture
 * 3) when the prefecture is unknown, only a nationally unique core name
 * Returns null when unresolved (the caller falls back to markers).
 */
export function resolveEewAreaPolygons(
  index: EewPolygonIndex | null,
  prefInput: unknown,
  areaName: unknown
): EewPolygonEntry | null {
  if (!index || typeof areaName !== "string" || areaName.trim() === "") return null;
  const key = eewMatchKey(areaName);
  const direct = index.byKey.get(key);
  if (direct) return direct;
  const pref = normalizePref(prefInput) ?? prefFromAreaName(areaName, index.entries);
  if (pref) {
    const inner = index.byPrefCore.get(pref);
    const hit = inner?.get(eewCoreName(areaName, pref));
    if (hit) return hit;
  } else {
    for (const e of index.entries) {
      const c = eewCoreName(e.name, e.pref);
      if (c === eewCoreName(areaName, e.pref) && index.coreCounts.get(c) === 1) return e;
    }
  }
  return null;
}

// 📍 Polygon anchor: the vertex average of the largest outer ring.
export function polygonAnchor(polygons: MultiPolygon | null | undefined): StationCoord | null {
  let best: LonLat[] | null = null;
  for (const poly of polygons ?? []) {
    const ring = poly?.[0];
    if (Array.isArray(ring) && ring.length >= 4 && (!best || ring.length > best.length)) best = ring;
  }
  if (!best) return null;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of best) {
    lon += x;
    lat += y;
  }
  return { lat: lat / best.length, lon: lon / best.length };
}

// 📍 Representative coordinate for an area from station centroids (for
// areas without polygons): the centroid of the prefecture's stations
// whose names contain the area's core name (direction suffix removed),
// falling back to all stations in the prefecture.
export function stationCentroidForArea(
  areaName: string,
  prefInput: unknown,
  stationIndex: Map<string, StationCoord> | null,
  prefsData: StationPrefsData | null
): StationCoord | null {
  const pref = normalizePref(prefInput) ?? null;
  if (!pref || !stationIndex || !prefsData?.prefs) return null;
  const inPref: (StationCoord & { name: string })[] = [];
  for (const [name, coord] of stationIndex) {
    if (prefsData.prefs[name] === pref) inPref.push({ name, ...coord });
  }
  if (inPref.length === 0) return null;
  const core = eewCoreName(areaName, pref).replace(/(北東部|北西部|南東部|南西部|北部|南部|東部|西部|中部)$/, "");
  const matched = core ? inPref.filter((s) => s.name.includes(core)) : [];
  const pool = matched.length > 0 ? matched : inPref;
  let lat = 0;
  let lon = 0;
  for (const s of pool) {
    lat += s.lat;
    lon += s.lon;
  }
  return { lat: lat / pool.length, lon: lon / pool.length };
}

/**
 * Resolve an EEW value's areas into fill/marker form. Same-name areas keep
 * the maximum intensity. Each area ends up with polygons (when resolvable)
 * and/or lat/lon (the polygon anchor preferred, else the station
 * centroid); areas with neither are collected as unresolved.
 */
export function resolveEewAreaFills(
  eew: EewValue | null,
  polygonIndex: EewPolygonIndex | null,
  stationIndex: Map<string, StationCoord>,
  prefsData: StationPrefsData | null
): { fills: EewFill[]; unresolved: string[] } {
  const byName = new Map<string, EewValue["areas"][number]>();
  for (const a of eew?.areas ?? []) {
    if (!a || typeof a.name !== "string" || a.name === "" || !(a.scale > 0)) continue;
    const prev = byName.get(a.name);
    if (!prev || a.scale > prev.scale) byName.set(a.name, a);
  }
  const fills: EewFill[] = [];
  const unresolved: string[] = [];
  for (const a of byName.values()) {
    const entry = polygonIndex ? resolveEewAreaPolygons(polygonIndex, a.pref, a.name) : null;
    let anchor = entry ? polygonAnchor(entry.polygons) : null;
    if (!anchor) anchor = stationCentroidForArea(a.name, a.pref, stationIndex, prefsData);
    if (!entry && !anchor) {
      unresolved.push(a.name);
      continue;
    }
    fills.push({
      name: a.name,
      pref: a.pref,
      scale: a.scale,
      scaleTo: a.scaleTo,
      openEnded: a.scaleTo === 99,
      polygons: entry ? entry.polygons : null,
      lat: anchor?.lat ?? null,
      lon: anchor?.lon ?? null,
    });
  }
  return { fills, unresolved };
}

// ==========================================
// 🌊 Tsunami zone resolution (bot rules)
// ==========================================
// 🌊 Zone name → coastline polylines and representative point. Zones that
// cannot be resolved are reported, never drawn at a guessed position.
export function resolveTsunamiCoastlines(
  tsunami: TsunamiValue | null,
  coastlineData: CoastlineData | null,
  zonesData: TsunamiZonesData | null
): { areas: TsunamiCoastArea[]; unresolved: string[] } {
  const zones = coastlineData?.zones ?? {};
  const reps = zonesData?.zones ?? {};
  const areas: TsunamiCoastArea[] = [];
  const unresolved: string[] = [];
  for (const a of tsunami?.areas ?? []) {
    if (!a || a.cancelled) continue;
    const lines = zones[a.name];
    const rep = reps[a.name];
    if (!Array.isArray(lines) || lines.length === 0 || !rep) {
      unresolved.push(a.name);
      continue;
    }
    areas.push({
      name: a.name,
      grade: a.grade,
      maxHeight: a.maxHeight,
      maxHeightValue: a.maxHeightValue,
      arrival: a.arrival,
      lines,
      lat: rep.lat,
      lon: rep.lon,
    });
  }
  return { areas, unresolved };
}

// 🌊 Zone name → representative point (marker-style maps).
export function resolveTsunamiZonePoints(
  tsunami: TsunamiValue | null,
  zonesData: TsunamiZonesData | null
): { areas: TsunamiZoneArea[]; unresolved: string[] } {
  const reps = zonesData?.zones ?? {};
  const areas: TsunamiZoneArea[] = [];
  const unresolved: string[] = [];
  for (const a of tsunami?.areas ?? []) {
    if (!a || a.cancelled) continue;
    const rep = reps[a.name];
    if (!rep) {
      unresolved.push(a.name);
      continue;
    }
    areas.push({ name: a.name, grade: a.grade, maxHeight: a.maxHeight, arrival: a.arrival, lat: rep.lat, lon: rep.lon });
  }
  return { areas, unresolved };
}

// ==========================================
// 📥 Load-and-resolve helpers used by the pages
// ==========================================
export async function loadAndResolveQuakePoints(record: MergedQuake) {
  const data = await loadStations();
  return resolveQuakePoints(record, stationCoordIndex(data));
}

export async function loadAndResolveEewFills(eew: EewValue) {
  const [polys, coords, prefs] = await Promise.all([loadEewPolygons(), loadStations(), loadStationPrefs()]);
  return resolveEewAreaFills(eew, indexEewPolygons(polys), stationCoordIndex(coords), prefs);
}

export async function loadAndResolveTsunamiCoast(tsunami: TsunamiValue) {
  const [coast, zones] = await Promise.all([loadCoastline(), loadTsunamiZones()]);
  return resolveTsunamiCoastlines(tsunami, coast, zones);
}

export async function loadAndResolveTsunamiPoints(tsunami: TsunamiValue) {
  const zones = await loadTsunamiZones();
  return resolveTsunamiZonePoints(tsunami, zones);
}
