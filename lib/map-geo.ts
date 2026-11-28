/* bosai — map geometry (pure functions).
   The view/zoom decision, remote-region inset splitting and label
   placement rules are a browser port of the Aegis Discord bot's map
   renderer (src/intensity-map.ts). Only the coordinate maths lives here
   so it can be unit-tested; drawing is lib/map-render.ts. */

// ------------------------------------------
// 📌 Layout constants (same dimensions as the bot renderer)
// ------------------------------------------
export const MAP_TILE_SIZE = 256;
export const MAP_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale";
// 🌊 The sea colour of the pale GSI tiles (measured from real tiles).
// Tiles that cannot be fetched are filled with it so the map stays
// visually continuous.
export const MAP_SEA_COLOR = "#bed2ff";
export const MAP_TILE_ZOOM_FALLBACK_STEPS = 2;
export const MAP_MIN_ZOOM = 5;
export const MAP_MAX_ZOOM = 9;
// 📍 Minimum span of the fitted view, so a single point is not framed
// absurdly close.
export const MAP_MIN_LAT_SPAN = 0.8;
export const MAP_MIN_LON_SPAN = 1.0;
// 📡 Inner margin so station markers never clip at the panel edge.
export const MAP_VIEW_MARGIN = 22;
// 🖼️ Inset (remote region) size and snap step.
export const INSET_W = 330;
export const INSET_H = 250;
export const INSET_MARGIN = 12;
export const INSET_SNAP = 128;
export const INSET_LABEL_SW = "沖縄・奄美地方";
export const INSET_LABEL_OG = "小笠原・伊豆諸島";
// 📰 Report layout (1280×720): map 960 wide + 320 panel.
export const REPORT_W = 1280;
export const REPORT_H = 720;
export const REPORT_MAP_W = 960;
export const REPORT_PANEL_X = 960;
export const REPORT_PANEL_W = 320;
// 🌍 Overview (whole-Japan) extent and zoom.
export const JAPAN_EXTENT = { latMin: 24.0, latMax: 46.0, lonMin: 124.0, lonMax: 146.5 };
export const OVERVIEW_ZOOM = 4;

// ------------------------------------------
// 📳 Intensity classes (bot table and "5-" style labels)
// ------------------------------------------
export const MAP_SCALE_COLORS: Record<number, string> = {
  10: "#9e9e9e", 20: "#1e88e5", 30: "#43a047", 40: "#fdd835", 45: "#fb8c00",
  50: "#e53935", 55: "#c2185b", 60: "#8e24aa", 70: "#6a1b9a",
};
export const MAP_SCALE_ORDER = [10, 20, 30, 40, 45, 50, 55, 60, 70];
export const MAP_SCALE_LABELS: Record<number, string> = { 10: "1", 20: "2", 30: "3", 40: "4", 45: "5-", 50: "5+", 55: "6-", 60: "6+", 70: "7" };

export function mapScaleLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "不明";
  return MAP_SCALE_LABELS[scale] ?? String(scale);
}
// 🎨 Plot colour for an intensity code; intermediate values take the
// colour of the class below them.
export function mapScaleColor(scale: number): string {
  if (MAP_SCALE_COLORS[scale]) return MAP_SCALE_COLORS[scale];
  let best = MAP_SCALE_COLORS[10];
  for (const s of MAP_SCALE_ORDER) if (scale >= s) best = MAP_SCALE_COLORS[s];
  return best;
}
// 🔢 Marker radius by intensity band.
export function mapScaleRadius(scale: number): number {
  if (scale >= 45) return 16;
  if (scale >= 30) return 13;
  return 11;
}

// ------------------------------------------
// 🔀 Web Mercator conversion
// ------------------------------------------
export function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * MAP_TILE_SIZE * 2 ** zoom;
}
export function latToWorldY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * MAP_TILE_SIZE * 2 ** zoom;
}
export function worldXToLon(x: number, zoom: number): number {
  return (x / (MAP_TILE_SIZE * 2 ** zoom)) * 360 - 180;
}
export function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (MAP_TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// 🔍 Whether a lat/lon pair is drawable.
export function isValidCoord(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

export interface LatLon {
  lat: number;
  lon: number;
}
export interface MapView {
  zoom: number;
  left: number;
  top: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ------------------------------------------
// 📌 View and zoom decision (port of the bot's computeMapView)
// ------------------------------------------
/**
 * Return the largest zoom and the tile-snapped origin such that every
 * coordinate fits inside the viewport with MAP_VIEW_MARGIN to spare.
 * The fit is re-verified against the post-snap viewport, and zooms that
 * fail verification are never adopted, which guarantees every point is
 * drawn. `snap` is the origin snap step (insets use a half tile, 128).
 * `allowFreeOrigin` (insets only) additionally tries a centred free
 * origin when no snapped origin fits. `maxZoom` / `minSpan` can be
 * overridden by callers such as the EEW fill renderer.
 */
export function computeMapView(
  coords: LatLon[],
  vpW: number,
  vpH: number,
  snap = MAP_TILE_SIZE,
  allowFreeOrigin = false,
  maxZoom = MAP_MAX_ZOOM,
  minSpan: { lat: number; lon: number } | null = null
): MapView {
  const minLatSpan = minSpan?.lat ?? MAP_MIN_LAT_SPAN;
  const minLonSpan = minSpan?.lon ?? MAP_MIN_LON_SPAN;
  const lats = coords.map((c) => c.lat);
  const lons = coords.map((c) => c.lon);
  let latMin = Math.min(...lats);
  let latMax = Math.max(...lats);
  let lonMin = Math.min(...lons);
  let lonMax = Math.max(...lons);
  if (latMax - latMin < minLatSpan) {
    const c = (latMin + latMax) / 2;
    latMin = c - minLatSpan / 2;
    latMax = c + minLatSpan / 2;
  }
  if (lonMax - lonMin < minLonSpan) {
    const c = (lonMin + lonMax) / 2;
    lonMin = c - minLonSpan / 2;
    lonMax = c + minLonSpan / 2;
  }
  const fits = (zoom: number, left: number, top: number) =>
    coords.every((c) => {
      const x = lonToWorldX(c.lon, zoom) - left;
      const y = latToWorldY(c.lat, zoom) - top;
      return x >= MAP_VIEW_MARGIN && x <= vpW - MAP_VIEW_MARGIN && y >= MAP_VIEW_MARGIN && y <= vpH - MAP_VIEW_MARGIN;
    });
  for (let z = maxZoom; z >= MAP_MIN_ZOOM; z--) {
    const cx = (lonToWorldX(lonMin, z) + lonToWorldX(lonMax, z)) / 2;
    const cy = (latToWorldY(latMin, z) + latToWorldY(latMax, z)) / 2;
    const baseLeft = Math.floor((cx - vpW / 2) / snap) * snap;
    const baseTop = Math.floor((cy - vpH / 2) / snap) * snap;
    // 📌 Try both the floor-side and ceil-side snap candidates.
    for (const left of [baseLeft, baseLeft + snap]) {
      for (const top of [baseTop, baseTop + snap]) {
        if (fits(z, left, top)) return { zoom: z, left, top };
      }
    }
  }
  if (allowFreeOrigin) {
    for (let z = maxZoom; z >= MAP_MIN_ZOOM; z--) {
      const cx = (lonToWorldX(lonMin, z) + lonToWorldX(lonMax, z)) / 2;
      const cy = (latToWorldY(latMin, z) + latToWorldY(latMax, z)) / 2;
      const left = cx - vpW / 2;
      const top = cy - vpH / 2;
      if (fits(z, left, top)) return { zoom: z, left, top };
    }
  }
  const z = MAP_MIN_ZOOM;
  const cx = (lonToWorldX(lonMin, z) + lonToWorldX(lonMax, z)) / 2;
  const cy = (latToWorldY(latMin, z) + latToWorldY(latMax, z)) / 2;
  return {
    zoom: z,
    left: Math.floor((cx - vpW / 2) / snap) * snap,
    top: Math.floor((cy - vpH / 2) / snap) * snap,
  };
}

// 🗺️ Tile coordinates needed to cover a w×h region under a view.
export function tileJobsForView(view: MapView, w: number, h: number): { tx: number; ty: number }[] {
  const tileX0 = Math.floor(view.left / MAP_TILE_SIZE);
  const tileY0 = Math.floor(view.top / MAP_TILE_SIZE);
  const offX = view.left - tileX0 * MAP_TILE_SIZE;
  const offY = view.top - tileY0 * MAP_TILE_SIZE;
  const jobs: { tx: number; ty: number }[] = [];
  for (let dx = 0; dx * MAP_TILE_SIZE < w + offX; dx++) {
    for (let dy = 0; dy * MAP_TILE_SIZE < h + offY; dy++) {
      jobs.push({ tx: tileX0 + dx, ty: tileY0 + dy });
    }
  }
  return jobs;
}

// ------------------------------------------
// 📌 Remote-region clustering (bot rules, unchanged)
// ------------------------------------------
// - Southwest islands: latitude < 31.5 and longitude < 132.0
//   (Amami, Okinawa, Sakishima)
// - Ogasawara / southern Izu: latitude < 33.5 and longitude >= 139.5
export const SW_LAT_MAX = 31.5;
export const SW_LON_MAX = 132.0;
export const OG_LAT_MAX = 33.5;
export const OG_LON_MIN = 139.5;

export type RemoteRegion = "southwest" | "ogasawara";

// 🌍 Which remote region a coordinate belongs to (null = mainland side).
export function remoteRegionOf(lat: number, lon: number): RemoteRegion | null {
  if (lat < SW_LAT_MAX && lon < SW_LON_MAX) return "southwest";
  if (lat < OG_LAT_MAX && lon >= OG_LON_MIN) return "ogasawara";
  return null;
}
export function isRemoteCoord(lat: number, lon: number): boolean {
  return remoteRegionOf(lat, lon) !== null;
}

/**
 * Split points into mainland (main) and remote (southwest / ogasawara)
 * groups. Splitting happens only when both sides are present: with no
 * mainland point at all, everything stays in main and is fitted on one
 * map, as before.
 */
export function splitRemotePoints<T extends LatLon>(items: T[]): { main: T[]; southwest: T[]; ogasawara: T[] } {
  const main: T[] = [];
  const southwest: T[] = [];
  const ogasawara: T[] = [];
  for (const i of items) {
    const region = remoteRegionOf(i.lat, i.lon);
    if (region === "southwest") southwest.push(i);
    else if (region === "ogasawara") ogasawara.push(i);
    else main.push(i);
  }
  if (main.length === 0) {
    return { main: [...items], southwest: [], ogasawara: [] };
  }
  return { main, southwest, ogasawara };
}

// ------------------------------------------
// 📌 Label placement (collision avoidance; port of chooseLabelRect)
// ------------------------------------------
// 🔢 Overlap area between two rectangles.
export function rectOverlapArea(a: Rect, b: Rect, pad = 0): number {
  const w = Math.min(a.x + a.w + pad, b.x + b.w) - Math.max(a.x - pad, b.x);
  const h = Math.min(a.y + a.h + pad, b.y + b.h) - Math.max(a.y - pad, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Pick a label rectangle around an anchor (above → below → right → left)
 * that avoids already-placed labels and markers; when every candidate
 * overlaps, the one with the smallest total overlap wins. The result is
 * clamped inside bounds.
 */
export function chooseLabelRect(
  anchor: { x: number; y: number },
  size: { w: number; h: number },
  gap: number,
  occupied: Rect[],
  bounds: Rect
): Rect {
  const clamp = (r: Rect): Rect => ({
    x: Math.max(bounds.x + 2, Math.min(r.x, bounds.x + bounds.w - size.w - 2)),
    y: Math.max(bounds.y + 2, Math.min(r.y, bounds.y + bounds.h - size.h - 2)),
    w: size.w,
    h: size.h,
  });
  const candidates = [
    clamp({ x: anchor.x - size.w / 2, y: anchor.y - gap - size.h, w: size.w, h: size.h }), // above
    clamp({ x: anchor.x - size.w / 2, y: anchor.y + gap, w: size.w, h: size.h }), // below
    clamp({ x: anchor.x + gap, y: anchor.y - size.h / 2, w: size.w, h: size.h }), // right
    clamp({ x: anchor.x - gap - size.w, y: anchor.y - size.h / 2, w: size.w, h: size.h }), // left
  ];
  let best = candidates[0];
  let bestArea = Infinity;
  for (const c of candidates) {
    const area = occupied.reduce((sum, o) => sum + rectOverlapArea(c, o, 2), 0);
    if (area === 0) return c;
    if (area < bestArea) {
      bestArea = area;
      best = c;
    }
  }
  return best;
}

// ------------------------------------------
// 📌 Inset placement (port of chooseInsetRect)
// ------------------------------------------
export interface InsetObstacle {
  x: number;
  y: number;
  r: number;
  scale: number;
}

/**
 * Decide where an inset goes. Corners are evaluated starting from the
 * preferred one (southwest islands: bottom-left; Ogasawara: bottom-right),
 * preferring placements that never hide the strongest point (or the
 * hypocentre), then minimising the number of hidden markers. mapRect is
 * the main map area (in report layout, {x:0,y:0,w:960,h:720}).
 */
export function chooseInsetRect(
  obstacles: InsetObstacle[],
  preference: "bottomLeft" | "bottomRight" = "bottomLeft",
  blocked: Rect[] = [],
  mapRect: Rect = { x: 88, y: 64, w: 1024, h: 768 }
): Rect {
  const yBottom = mapRect.y + mapRect.h - INSET_MARGIN - INSET_H;
  const yTop = mapRect.y + INSET_MARGIN;
  const xLeft = mapRect.x + INSET_MARGIN;
  const xRight = mapRect.x + mapRect.w - INSET_MARGIN - INSET_W;
  const corners = {
    bottomLeft: { x: xLeft, y: yBottom, w: INSET_W, h: INSET_H },
    bottomRight: { x: xRight, y: yBottom, w: INSET_W, h: INSET_H },
    topRight: { x: xRight, y: yTop, w: INSET_W, h: INSET_H },
    topLeft: { x: xLeft, y: yTop, w: INSET_W, h: INSET_H },
  };
  const order =
    preference === "bottomRight"
      ? [corners.bottomRight, corners.bottomLeft, corners.topRight, corners.topLeft]
      : [corners.bottomLeft, corners.bottomRight, corners.topRight, corners.topLeft];
  const overlapsRect = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const free = order.filter((c) => !blocked.some((b) => overlapsRect(c, b)));
  const candidates = free.length > 0 ? free : order;
  const maxScale = obstacles.reduce((m, o) => Math.max(m, o.scale), -Infinity);
  const hidden = (rect: Rect, o: InsetObstacle) =>
    o.x + o.r > rect.x && o.x - o.r < rect.x + rect.w && o.y + o.r > rect.y && o.y - o.r < rect.y + rect.h;
  let best = candidates[0];
  let bestKey: [number, number] | null = null;
  for (const c of candidates) {
    const hs = obstacles.filter((o) => hidden(c, o));
    const key: [number, number] = [hs.some((o) => o.scale === maxScale) ? 1 : 0, hs.length];
    if (bestKey === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}
