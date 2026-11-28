/* bosai — saved places (a client-side feature stored in localStorage).
   There is no login and nothing is kept server-side; places live only in
   the visitor's browser. The display policy for per-place intensity is a
   standing decision carried over from the previous implementation:
   a place shows a "measured" intensity only when an observation station
   inside the same municipality actually recorded it — no nearest-station
   or area-value estimation. EEW per-area forecasts are official estimates
   and are shown, explicitly labelled as forecasts. */

import type { EewValue, MergedQuake } from "./a2s";
import { GEOCODING_URL, numOrNull } from "./core";

export const PLACES_STORAGE_KEY = "bosai-places";

export interface Place {
  name: string;
  lat: number;
  lon: number;
  city: string;
  pref: string;
  area: string;
}

export interface GeocodingResult extends Place {
  label: string;
}

// 📍 Validate and normalise one place record; malformed entries drop out.
export function normalizePlace(v: unknown): Place | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const name = String(rec.name ?? "").trim();
  const lat = numOrNull(rec.lat);
  const lon = numOrNull(rec.lon);
  if (!name || lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    name,
    lat,
    lon,
    // 🏙️ city feeds the measured-intensity match; pref and area feed the
    // EEW forecast match.
    city: String(rec.city ?? "").trim(),
    pref: String(rec.pref ?? "").trim(),
    area: String(rec.area ?? "").trim(),
  };
}

export function parsePlaces(json: unknown): Place[] {
  let data: unknown = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  const out: Place[] = [];
  for (const v of data) {
    const p = normalizePlace(v);
    if (p) out.push(p);
  }
  return out;
}

// 📥 Read places from localStorage (empty when unavailable).
export function loadPlaces(): Place[] {
  try {
    return parsePlaces(localStorage.getItem(PLACES_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

// 💾 Write places to localStorage (failures are swallowed).
export function savePlaces(places: Place[]): boolean {
  try {
    localStorage.setItem(PLACES_STORAGE_KEY, JSON.stringify(parsePlaces(places)));
    return true;
  } catch {
    return false;
  }
}

// 🔍 Open-Meteo geocoding URL for the add-place search (Japan only).
export function buildGeocodingUrl(query: string): string {
  const q = String(query ?? "").trim();
  return `${GEOCODING_URL}?name=${encodeURIComponent(q)}&count=8&language=ja&format=json&countryCode=JP`;
}

// 🔍 Convert a geocoding response into place candidates.
export function parseGeocodingResults(data: unknown): GeocodingResult[] {
  const results = Array.isArray((data as { results?: unknown[] } | null)?.results)
    ? ((data as { results: unknown[] }).results as Record<string, unknown>[])
    : [];
  return results
    .map((r): GeocodingResult | null => {
      const lat = numOrNull(r?.latitude);
      const lon = numOrNull(r?.longitude);
      if (lat === null || lon === null) return null;
      const admin1 = String(r?.admin1 ?? "");
      const admin2 = String(r?.admin2 ?? "");
      const name = String(r?.name ?? "");
      return {
        name: name || admin2 || admin1,
        lat,
        lon,
        city: admin2 || name,
        pref: admin1,
        area: "",
        label: [admin1, admin2, name].filter(Boolean).join(" "),
      };
    })
    .filter((r): r is GeocodingResult => r !== null);
}

// 📈 Measured intensity at a place: the maximum over the quake's stations
// whose names start with the place's municipality name (stations inside
// the municipality). Null when the place has no municipality or no such
// station — never estimated.
export function localMeasuredScale(quake: MergedQuake | null, place: Place | null): number | null {
  if (!quake || !place || !place.city) return null;
  let best: number | null = null;
  for (const p of quake.points ?? []) {
    if (p.isArea || p.scale < 0) continue;
    if (p.addr && p.addr.startsWith(place.city)) {
      if (best === null || p.scale > best) best = p.scale;
    }
  }
  return best;
}

// 📈 Per-place EEW forecast intensity (an official estimate).
// Match order: (1) exact subdivision name, (2) the single area in the
// place's prefecture, (3) with several areas in the prefecture, the
// maximum — erring on the safe side.
export function eewLocalForecasts(
  eew: EewValue | null,
  placesList: Place[]
): { place: string; scale: number; areaName: string; pref: string }[] {
  if (!eew || !Array.isArray(eew.areas)) return [];
  const out: { place: string; scale: number; areaName: string; pref: string }[] = [];
  for (const place of placesList ?? []) {
    const pref = String(place?.pref ?? "").trim();
    const areaName = String(place?.area ?? "").trim();
    let matched = areaName ? (eew.areas.find((a) => a.name === areaName) ?? null) : null;
    if (!matched && pref) {
      const inPref = eew.areas.filter((a) => a.pref === pref);
      if (inPref.length === 1) matched = inPref[0];
      else if (inPref.length > 1) matched = inPref.reduce((best, a) => (a.scale > best.scale ? a : best), inPref[0]);
    }
    if (matched && matched.scale >= 0) {
      out.push({ place: String(place.name ?? ""), scale: matched.scale, areaName: matched.name, pref: matched.pref });
    }
  }
  return out;
}
