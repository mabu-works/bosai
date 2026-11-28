/* bosai — map image generation (browser Canvas).
   A browser port of the Aegis Discord bot's map renderers
   (src/intensity-map.ts and siblings). The background is the GSI pale
   map, fetched from the browser with CORS; tiles that fail are filled
   with the sea colour, missing areas trigger a zoom-out rebuild, and if
   every tile fails a dark-navy + lat/lon grid fallback background is
   used so drawing always continues. Credit lines use the bot's format
   ("地図: 国土地理院 / …｜A.A.S 編集電文").
   Geometry lives in lib/map-geo.ts, data resolution in lib/map-data.ts. */

import type { EewValue, MergedQuake, TsunamiValue } from "./a2s";
import { depthLabel, GRADE_LABELS, GRADE_RANK, parseJstTime, TSUNAMI_LABELS } from "./core";
import { eewCoreName, type EewFill, type MultiPolygon, type PlotPoint, type TsunamiCoastArea, type TsunamiZoneArea } from "./map-data";
import type { Place } from "./places";
import {
  chooseInsetRect,
  chooseLabelRect,
  computeMapView,
  INSET_H,
  INSET_LABEL_OG,
  INSET_LABEL_SW,
  INSET_SNAP,
  INSET_W,
  isValidCoord,
  JAPAN_EXTENT,
  latToWorldY,
  lonToWorldX,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_SCALE_COLORS,
  MAP_SCALE_ORDER,
  MAP_SEA_COLOR,
  MAP_TILE_SIZE,
  MAP_TILE_URL,
  MAP_TILE_ZOOM_FALLBACK_STEPS,
  mapScaleColor,
  mapScaleLabel,
  mapScaleRadius,
  OVERVIEW_ZOOM,
  rectOverlapArea,
  REPORT_H,
  REPORT_MAP_W,
  REPORT_PANEL_W,
  REPORT_PANEL_X,
  REPORT_W,
  splitRemotePoints,
  tileJobsForView,
  worldXToLon,
  worldYToLat,
  type LatLon,
  type MapView,
  type Rect,
} from "./map-geo";

const MAP_FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif';
const MAP_TILE_TIMEOUT_MS = 6_000;

// 📐 A map region: origin + size + the view that projects into it.
export interface MapRegion {
  ox: number;
  oy: number;
  w: number;
  h: number;
  view: MapView;
}
// 📍 A point to draw as a marker (EEW points may be open-ended).
export interface MarkerPoint {
  name: string;
  scale: number;
  lat: number;
  lon: number;
  openEnded?: boolean;
}
export interface PlacedPoint extends MarkerPoint {
  x: number;
  y: number;
  r: number;
}

interface PaintOpts {
  fitSnap?: number;
  fitFreeOrigin?: boolean;
  minSpan?: { lat: number; lon: number } | null;
  maxZoom?: number;
  fallbackJpBox?: boolean;
}
interface RegionOpts extends PaintOpts {
  hypo?: LatLon | null;
  places?: Place[];
  preOccupied?: Rect[];
  fitCoords?: LatLon[];
}

// ==========================================
// 🖼️ Canvas and tile fetching
// ==========================================
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

// 🔄 Tile images, cached per page; failures resolve to null.
const tileImageCache = new Map<string, Promise<HTMLImageElement | null>>();
function fetchTileImage(zoom: number, tx: number, ty: number): Promise<HTMLImageElement | null> {
  const max = 2 ** zoom;
  if (tx < 0 || ty < 0 || tx >= max || ty >= max) return Promise.resolve(null);
  const key = `${zoom}/${tx}/${ty}`;
  if (!tileImageCache.has(key)) {
    tileImageCache.set(
      key,
      new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const timer = setTimeout(() => resolve(null), MAP_TILE_TIMEOUT_MS);
        img.onload = () => {
          clearTimeout(timer);
          resolve(img);
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
        img.src = `${MAP_TILE_URL}/${zoom}/${tx}/${ty}.png`;
      })
    );
  }
  return tileImageCache.get(key)!;
}

// ==========================================
// 🖼️ Small drawing helpers (bot ports)
// ==========================================
// 📌 Draw text so the centre of its actual ink (glyph bounding box) lands
// on (cx, cy); falls back to plain centred text when metrics are absent.
function drawInkCenteredText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number) {
  const prevAlign = ctx.textAlign;
  const prevBaseline = ctx.textBaseline;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(text);
  const inkW = m.actualBoundingBoxRight - m.actualBoundingBoxLeft;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (Number.isFinite(inkW) && Number.isFinite(inkH) && inkH > 0) {
    const dx = cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const dy = cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.fillText(text, dx, dy);
  } else {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy);
  }
  ctx.textAlign = prevAlign;
  ctx.textBaseline = prevBaseline;
}

const LABEL_FONT = `bold 15px ${MAP_FONT}`;
const LABEL_H = 24;
const LABEL_PAD_X = 7;
function measureLabel(ctx: CanvasRenderingContext2D, text: string): { w: number; h: number } {
  ctx.font = LABEL_FONT;
  return { w: ctx.measureText(text).width + LABEL_PAD_X * 2, h: LABEL_H };
}
function drawLabelRect(ctx: CanvasRenderingContext2D, rect: Rect, text: string, opts: { bg?: string; fg?: string } = {}) {
  ctx.fillStyle = opts.bg ?? "rgba(10, 16, 24, 0.82)";
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 5);
  ctx.fill();
  ctx.font = LABEL_FONT;
  ctx.fillStyle = opts.fg ?? "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, rect.x + LABEL_PAD_X, rect.y + rect.h / 2 + 1);
}

// 🌍 Hypocentre mark: a white thick cross under a red thin cross.
function drawHypoMark(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const s = 13;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.stroke();
  ctx.strokeStyle = "#d32f2f";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.stroke();
}

// 🖼️ Fallback background when no tile loads: dark navy + lat/lon grid,
// optionally with a faint box over the rough extent of Japan.
function drawFallbackBackground(
  ctx: CanvasRenderingContext2D,
  region: MapRegion,
  toPx: (lat: number, lon: number) => { x: number; y: number },
  view: { latMin: number; latMax: number; lonMin: number; lonMax: number },
  drawJpBox: boolean
) {
  ctx.fillStyle = "#0b1d33";
  ctx.fillRect(region.ox, region.oy, region.w, region.h);
  if (drawJpBox) {
    const jp = { latMin: 30.9, latMax: 45.6, lonMin: 129.0, lonMax: 146.0 };
    const a = toPx(jp.latMax, jp.lonMin);
    const b = toPx(jp.latMin, jp.lonMax);
    const x1 = Math.max(a.x, region.ox);
    const y1 = Math.max(a.y, region.oy);
    const x2 = Math.min(b.x, region.ox + region.w);
    const y2 = Math.min(b.y, region.oy + region.h);
    if (x2 > x1 && y2 > y1) {
      ctx.fillStyle = "rgba(120, 170, 220, 0.10)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeStyle = "rgba(120, 170, 220, 0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
  }
  ctx.strokeStyle = "rgba(160, 200, 240, 0.25)";
  ctx.fillStyle = "rgba(200, 225, 250, 0.75)";
  ctx.font = `11px ${MAP_FONT}`;
  ctx.lineWidth = 1;
  for (let lon = Math.ceil(view.lonMin); lon <= Math.floor(view.lonMax); lon++) {
    const { x } = toPx(0, lon);
    ctx.beginPath();
    ctx.moveTo(x, region.oy);
    ctx.lineTo(x, region.oy + region.h);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${lon}°E`, x + 3, region.oy + 3);
  }
  for (let lat = Math.ceil(view.latMin); lat <= Math.floor(view.latMax); lat++) {
    const { y } = toPx(lat, 0);
    ctx.beginPath();
    ctx.moveTo(region.ox, y);
    ctx.lineTo(region.ox + region.w, y);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${lat}°N`, region.ox + 3, y - 2);
  }
}

// ==========================================
// 🗺️ Region painting (tiles + zoom fallback)
// ==========================================
function regionToPx(region: MapRegion, view: MapView) {
  return (lat: number, lon: number) => ({
    x: region.ox + (lonToWorldX(lon, view.zoom) - view.left),
    y: region.oy + (latToWorldY(lat, view.zoom) - view.top),
  });
}

/**
 * Paint tiles into a region. When any tile is missing, the view is
 * refitted one zoom level lower (up to MAP_TILE_ZOOM_FALLBACK_STEPS,
 * never below the minimum zoom) and retried; tiles still missing are
 * filled with the sea colour. When nothing loads at all, the fallback
 * background is drawn. Returns the view actually used.
 */
async function paintTiles(
  ctx: CanvasRenderingContext2D,
  region: MapRegion,
  view: MapView,
  fitCoords: LatLon[],
  opts: PaintOpts = {}
): Promise<MapView> {
  const snap = opts.fitSnap ?? MAP_TILE_SIZE;
  const freeOrigin = opts.fitFreeOrigin ?? false;
  const minSpan = opts.minSpan ?? null;
  const maxZoom = opts.maxZoom ?? MAP_MAX_ZOOM;
  let cur = view;
  let jobs = tileJobsForView(cur, region.w, region.h);
  let tiles = await Promise.all(jobs.map((j) => fetchTileImage(cur.zoom, j.tx, j.ty)));
  for (
    let step = 0;
    tiles.some((t) => t === null) && step < MAP_TILE_ZOOM_FALLBACK_STEPS && cur.zoom > MAP_MIN_ZOOM;
    step++
  ) {
    cur = computeMapView(fitCoords, region.w, region.h, snap, freeOrigin, cur.zoom - 1, minSpan);
    jobs = tileJobsForView(cur, region.w, region.h);
    tiles = await Promise.all(jobs.map((j) => fetchTileImage(cur.zoom, j.tx, j.ty)));
  }
  const toPx = regionToPx(region, cur);
  const latLonView = {
    latMin: worldYToLat(cur.top + region.h, cur.zoom),
    latMax: worldYToLat(cur.top, cur.zoom),
    lonMin: worldXToLon(cur.left, cur.zoom),
    lonMax: worldXToLon(cur.left + region.w, cur.zoom),
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.ox, region.oy, region.w, region.h);
  ctx.clip();
  const loadedCount = tiles.filter((t) => t !== null).length;
  if (loadedCount === 0) {
    drawFallbackBackground(ctx, region, toPx, latLonView, opts.fallbackJpBox ?? false);
  } else {
    ctx.fillStyle = MAP_SEA_COLOR;
    ctx.fillRect(region.ox, region.oy, region.w, region.h);
    tiles.forEach((img, i) => {
      if (!img) return;
      const j = jobs[i];
      ctx.drawImage(img, region.ox + (j.tx * MAP_TILE_SIZE - cur.left), region.oy + (j.ty * MAP_TILE_SIZE - cur.top));
    });
  }
  ctx.restore();
  return cur;
}

// 📍 Saved places: a small rotated-square marker plus the place name.
function drawPlaces(ctx: CanvasRenderingContext2D, region: MapRegion, view: MapView, places: Place[]) {
  const toPx = regionToPx(region, view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.ox, region.oy, region.w, region.h);
  ctx.clip();
  for (const pl of places ?? []) {
    if (!isValidCoord(pl.lat, pl.lon)) continue;
    const { x, y } = toPx(pl.lat, pl.lon);
    if (x < region.ox || x > region.ox + region.w || y < region.oy || y > region.oy + region.h) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#263238";
    ctx.lineWidth = 1.5;
    const s = 6;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    ctx.font = `bold 12px ${MAP_FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(10, 16, 24, 0.85)";
    ctx.lineWidth = 3;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.strokeText(pl.name, x + 7, y - 5);
    ctx.fillText(pl.name, x + 7, y - 5);
  }
  ctx.restore();
}

// ==========================================
// 📳 Marker placement and drawing (bot ports)
// ==========================================
// 🖼️ Decide marker positions with proximity separation: stronger points
// keep their true position first; a point more than half hidden is
// nudged up to 14px around its base position to separate it.
function placeScalePoints(points: MarkerPoint[], toPx: (lat: number, lon: number) => { x: number; y: number }): PlacedPoint[] {
  const placed: PlacedPoint[] = [];
  const byScaleDesc = [...points].sort((a, b) => b.scale - a.scale);
  for (const p of byScaleDesc) {
    const base = toPx(p.lat, p.lon);
    const r = mapScaleRadius(p.scale);
    const overlaps = (x: number, y: number) => placed.some((o) => Math.hypot(x - o.x, y - o.y) < (r + o.r) * 0.55);
    let { x, y } = base;
    if (overlaps(x, y)) {
      const offsets: { dx: number; dy: number }[] = [];
      for (const d of [8, 12, 14]) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          offsets.push({ dx: Math.round(Math.cos(a) * d), dy: Math.round(Math.sin(a) * d) });
        }
      }
      const found = offsets.find((o) => !overlaps(base.x + o.dx, base.y + o.dy));
      if (found) {
        x = base.x + found.dx;
        y = base.y + found.dy;
      }
    }
    placed.push({ ...p, x, y, r });
  }
  return placed;
}

// 📳 Draw intensity markers (disc + double outline + label), weakest
// first so the strongest stay on top. Intensity 4 labels use dark text.
function drawScaleMarkers(ctx: CanvasRenderingContext2D, region: MapRegion, placed: PlacedPoint[]) {
  const sorted = [...placed].sort((a, b) => a.scale - b.scale);
  for (const p of sorted) {
    const { x, y, r } = p;
    if (x < region.ox - 20 || x > region.ox + region.w + 20 || y < region.oy - 20 || y > region.oy + region.h + 20) continue;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = mapScaleColor(p.scale);
    ctx.fill();
    ctx.strokeStyle = "rgba(10, 16, 24, 0.85)";
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    const label = mapScaleLabel(p.scale);
    ctx.font = `bold ${label.length >= 2 ? 11 : 13}px ${MAP_FONT}`;
    ctx.fillStyle = p.scale === 40 ? "#212121" : "#ffffff";
    drawInkCenteredText(ctx, label, x, y);
  }
}

// 🏷️ Place the strongest station's name label and the 「震源」 label with
// collision avoidance.
function drawPointLabels(
  ctx: CanvasRenderingContext2D,
  region: MapRegion,
  placed: PlacedPoint[],
  hypoPx: { x: number; y: number } | null,
  preOccupied: Rect[] = []
) {
  const bounds: Rect = { x: region.ox, y: region.oy, w: region.w, h: region.h };
  const occupied: Rect[] = [...preOccupied];
  occupied.push(...placed.map((p) => ({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 })));
  if (hypoPx) occupied.push({ x: hypoPx.x - 15, y: hypoPx.y - 15, w: 30, h: 30 });
  const topPoint = placed.reduce<PlacedPoint | null>((best, p) => (best === null || p.scale > best.scale ? p : best), null);
  if (topPoint) {
    const size = measureLabel(ctx, topPoint.name);
    const rect = chooseLabelRect({ x: topPoint.x, y: topPoint.y }, size, topPoint.r + 4, occupied, bounds);
    drawLabelRect(ctx, rect, topPoint.name);
    occupied.push(rect);
  }
  if (hypoPx) {
    const size = measureLabel(ctx, "震源");
    const rect = chooseLabelRect(hypoPx, size, 17, occupied, bounds);
    drawLabelRect(ctx, rect, "震源", { fg: "#ff8a80" });
  }
}

/**
 * Draw a marker-style map region (main map or inset) in the order
 * tiles → places → stations → hypocentre → labels. Returns the view
 * actually used after any zoom fallback.
 */
async function drawMarkerRegion(
  ctx: CanvasRenderingContext2D,
  region: MapRegion,
  points: MarkerPoint[],
  opts: RegionOpts = {}
): Promise<MapView> {
  const fitCoords = opts.fitCoords ?? points;
  const view = await paintTiles(ctx, region, region.view, fitCoords, opts);
  const toPx = regionToPx(region, view);
  if (opts.places) drawPlaces(ctx, region, view, opts.places);
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.ox, region.oy, region.w, region.h);
  ctx.clip();
  const placed = placeScalePoints(points, toPx);
  drawScaleMarkers(ctx, region, placed);
  const hypoPx = opts.hypo ? toPx(opts.hypo.lat, opts.hypo.lon) : null;
  if (hypoPx) drawHypoMark(ctx, hypoPx.x, hypoPx.y);
  drawPointLabels(ctx, region, placed, hypoPx, opts.preOccupied ?? []);
  ctx.restore();
  return view;
}

// 🖼️ Inset frame (double border) and its region-name label; returns the
// label rectangle.
function drawInsetFrame(ctx: CanvasRenderingContext2D, rect: Rect, label: string): Rect {
  ctx.strokeStyle = "#10161d";
  ctx.lineWidth = 5;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.font = `bold 13px ${MAP_FONT}`;
  const labelRect: Rect = { x: rect.x + 6, y: rect.y + 6, w: ctx.measureText(label).width + 16, h: 22 };
  ctx.fillStyle = "rgba(10, 16, 24, 0.85)";
  ctx.beginPath();
  ctx.roundRect(labelRect.x, labelRect.y, labelRect.w, labelRect.h, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, labelRect.x + 8, labelRect.y + labelRect.h / 2 + 1);
  return labelRect;
}

export interface InsetGroup {
  label: string;
  preference: "bottomLeft" | "bottomRight";
  points: MarkerPoint[];
  hypo: (LatLon & { kind?: string }) | null;
}

/**
 * Draw the remote-region insets (marker style). Placement is decided
 * from the main map's marker pixel positions so insets avoid hiding the
 * important markers.
 */
async function drawPointInsets(
  ctx: CanvasRenderingContext2D,
  mapRect: Rect,
  mainPlaced: PlacedPoint[],
  mainHypoPx: { x: number; y: number } | null,
  groups: InsetGroup[],
  blockedRects: Rect[] = []
) {
  const obstacles = mainPlaced.map((p) => ({ x: p.x, y: p.y, r: p.r, scale: p.scale }));
  if (mainHypoPx) obstacles.push({ x: mainHypoPx.x, y: mainHypoPx.y, r: 15, scale: Number.MAX_SAFE_INTEGER });
  const placedInsets: Rect[] = [...blockedRects];
  for (const group of groups) {
    if (group.points.length === 0 && !group.hypo) continue;
    const items: LatLon[] = [...group.points];
    if (group.hypo) items.push(group.hypo);
    const view = computeMapView(items, INSET_W, INSET_H, INSET_SNAP, true);
    const rect = chooseInsetRect(obstacles, group.preference, placedInsets, mapRect);
    placedInsets.push(rect);
    ctx.font = `bold 13px ${MAP_FONT}`;
    const labelRect: Rect = { x: rect.x + 6, y: rect.y + 6, w: ctx.measureText(group.label).width + 16, h: 22 };
    await drawMarkerRegion(
      ctx,
      { ox: rect.x, oy: rect.y, w: rect.w, h: rect.h, view },
      group.points,
      { hypo: group.hypo ?? null, preOccupied: [labelRect], fitCoords: items, fitSnap: INSET_SNAP, fitFreeOrigin: true }
    );
    drawInsetFrame(ctx, rect, group.label);
  }
}

// ==========================================
// 📰 Report-layout shared parts (panel, overview)
// ==========================================
const PANEL_BG = "#0b0f14";
const PANEL_ACCENT = "#f57c00";

// 📰 Panel base: black background, divider, orange title bar.
function drawPanelBase(ctx: CanvasRenderingContext2D, title: string) {
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(REPORT_PANEL_X, 0, REPORT_PANEL_W, REPORT_H);
  ctx.fillStyle = "#263238";
  ctx.fillRect(REPORT_PANEL_X, 0, 1, REPORT_H);
  ctx.fillStyle = PANEL_ACCENT;
  ctx.fillRect(REPORT_PANEL_X, 0, REPORT_PANEL_W, 40);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 19px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, REPORT_PANEL_X + 16, 21, REPORT_PANEL_W - 32);
}

// 📰 One panel item (small label + large value). `y` is the item's top;
// returns the next item's top. Overlong values are truncated with "…".
function drawPanelItem(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  value: string,
  opts: { color?: string; size?: number; note?: string } = {}
): number {
  const x = REPORT_PANEL_X + 18;
  ctx.fillStyle = "#90a4ae";
  ctx.font = `bold 13px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(label, x, y);
  ctx.fillStyle = opts.color ?? "#ffffff";
  const size = opts.size ?? 30;
  ctx.font = `bold ${size}px ${MAP_FONT}`;
  let text = String(value ?? "");
  while (size > 13 && ctx.measureText(text).width > REPORT_PANEL_W - 36) {
    // 📌 Long hypocentre names are shortened from the tail to fit.
    text = text.slice(0, -2);
    if (text.length <= 1) break;
    ctx.font = `bold ${size}px ${MAP_FONT}`;
    if (ctx.measureText(text + "…").width <= REPORT_PANEL_W - 36) {
      text += "…";
      break;
    }
  }
  ctx.fillText(text, x, y + 17);
  if (opts.note) {
    ctx.fillStyle = "#b0bec5";
    ctx.font = `12px ${MAP_FONT}`;
    ctx.fillText(opts.note, x, y + 17 + size + 4, REPORT_PANEL_W - 36);
    return y + 17 + size + 24;
  }
  return y + 17 + size + 10;
}

// 🌍 Overview (whole Japan): JAPAN_EXTENT at zoom 4, with the main view's
// extent outlined in red and the hypocentre dotted.
async function drawOverview(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  mainView: MapView | null,
  hypo: LatLon | null
) {
  const z = OVERVIEW_ZOOM;
  const wx0 = lonToWorldX(JAPAN_EXTENT.lonMin, z);
  const wx1 = lonToWorldX(JAPAN_EXTENT.lonMax, z);
  const wy0 = latToWorldY(JAPAN_EXTENT.latMax, z);
  const wy1 = latToWorldY(JAPAN_EXTENT.latMin, z);
  const scale = Math.min(rect.w / (wx1 - wx0), rect.h / (wy1 - wy0));
  const drawW = (wx1 - wx0) * scale;
  const drawH = (wy1 - wy0) * scale;
  const dx = rect.x + (rect.w - drawW) / 2;
  const dy = rect.y + (rect.h - drawH) / 2;
  const toOv = (lat: number, lon: number) => ({
    x: dx + (lonToWorldX(lon, z) - wx0) * scale,
    y: dy + (latToWorldY(lat, z) - wy0) * scale,
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.fillStyle = MAP_SEA_COLOR;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const tx0 = Math.floor(wx0 / MAP_TILE_SIZE);
  const tx1 = Math.floor(wx1 / MAP_TILE_SIZE);
  const ty0 = Math.floor(wy0 / MAP_TILE_SIZE);
  const ty1 = Math.floor(wy1 / MAP_TILE_SIZE);
  const jobs: { tx: number; ty: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push({ tx, ty });
  const tiles = await Promise.all(jobs.map((j) => fetchTileImage(z, j.tx, j.ty)));
  tiles.forEach((img, i) => {
    if (!img) return;
    const j = jobs[i];
    ctx.drawImage(
      img,
      dx + (j.tx * MAP_TILE_SIZE - wx0) * scale,
      dy + (j.ty * MAP_TILE_SIZE - wy0) * scale,
      MAP_TILE_SIZE * scale,
      MAP_TILE_SIZE * scale
    );
  });
  if (mainView) {
    const a = toOv(worldYToLat(mainView.top, mainView.zoom), worldXToLon(mainView.left, mainView.zoom));
    const b = toOv(
      worldYToLat(mainView.top + 720, mainView.zoom),
      worldXToLon(mainView.left + REPORT_MAP_W, mainView.zoom)
    );
    const rx = Math.max(a.x, rect.x);
    const ry = Math.max(a.y, rect.y);
    const rw = Math.min(b.x, rect.x + rect.w) - rx;
    const rh = Math.min(b.y, rect.y + rect.h) - ry;
    if (rw > 2 && rh > 2) {
      ctx.strokeStyle = "#e53935";
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }
  if (hypo && isValidCoord(hypo.lat, hypo.lon)) {
    const p = toOv(hypo.lat, hypo.lon);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#e53935";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "#37474f";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "#90a4ae";
  ctx.font = `11px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("出典：国土地理院", rect.x, rect.y + rect.h + 5);
}

// 📌 Credit line at the bottom-left of the map area.
function drawMapCredit(ctx: CanvasRenderingContext2D, text: string, y = REPORT_H - 8) {
  ctx.font = `12px ${MAP_FONT}`;
  ctx.fillStyle = "rgba(10, 16, 24, 0.72)";
  const w = ctx.measureText(text).width + 16;
  ctx.fillRect(8, y - 17, w, 21);
  ctx.fillStyle = "#eceff1";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, 16, y);
}

// ==========================================
// 📳 Intensity marker map (1200×900, the bot's buildIntensityMap)
// ==========================================
export async function buildIntensityMarkerCanvas(
  points: PlotPoint[],
  record: MergedQuake | null,
  opts: { places?: Place[] } = {}
): Promise<HTMLCanvasElement | null> {
  if (!points || points.length === 0) return null;
  const canvas = makeCanvas(1200, 900);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const hypo: LatLon | null = isValidCoord(record?.lat, record?.lon) ? { lat: record!.lat as number, lon: record!.lon as number } : null;
  const { main, southwest, ogasawara } = splitRemotePoints(points);
  const mainCoords: LatLon[] = [...main];
  if (hypo) mainCoords.push(hypo);
  const region: MapRegion = { ox: 0, oy: 0, w: 1200, h: 900, view: computeMapView(mainCoords, 1200, 900) };
  const usedView = await drawMarkerRegion(ctx, region, main, { hypo, places: opts.places, fitCoords: mainCoords, fallbackJpBox: true });
  const toPx = regionToPx(region, usedView);
  const mainPlaced = placeScalePoints(main, toPx);
  const mainHypoPx = hypo ? toPx(hypo.lat, hypo.lon) : null;
  const groups: InsetGroup[] = [];
  if (southwest.length > 0) groups.push({ label: INSET_LABEL_SW, preference: "bottomLeft", points: southwest, hypo: null });
  if (ogasawara.length > 0) groups.push({ label: INSET_LABEL_OG, preference: "bottomRight", points: ogasawara, hypo: null });
  await drawPointInsets(ctx, { x: 0, y: 0, w: 1200, h: 900 }, mainPlaced, mainHypoPx, groups);
  // 📌 Title (top-left, dark translucent plate).
  const dt = record ? parseJstTime(record.time) : null;
  const timeText = dt ? `${dt.getHours()}時${String(dt.getMinutes()).padStart(2, "0")}分ごろ` : "";
  const hypoText = record?.hypocenter && record.hypocenter !== "不明" ? `${record.hypocenter}の地震` : "地震発生";
  const lines = [
    `震度速報 ${timeText} ${hypoText}`.trim(),
    `最大震度 ${mapScaleLabel(record?.maxScale ?? 0)}`,
  ];
  ctx.font = `bold 21px ${MAP_FONT}`;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.fillStyle = "rgba(10, 16, 24, 0.78)";
  ctx.fillRect(12, 12, textW + 24, 74);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(lines[0], 24, 20);
  ctx.fillText(lines[1], 24, 52);
  drawMapCredit(ctx, "地図: 国土地理院｜A.A.S 編集電文", 892);
  return canvas;
}

// ==========================================
// 📰 Intensity report image (1280×720, the bot's buildIntensityReport)
// ==========================================
// 📋 Legend: highest scale first, two columns.
function drawLegend(ctx: CanvasRenderingContext2D, x: number, y: number, counts: Map<number, number>) {
  const present = MAP_SCALE_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).sort((a, b) => b - a);
  ctx.fillStyle = "#90a4ae";
  ctx.font = `bold 13px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("凡例（地点数）", x, y);
  let ly = y + 22;
  const rows = Math.ceil(present.length / 2);
  present.forEach((s, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const lx = x + col * 150;
    const ry = ly + row * 26;
    ctx.beginPath();
    ctx.arc(lx + 9, ry + 9, 9, 0, Math.PI * 2);
    ctx.fillStyle = MAP_SCALE_COLORS[s];
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.font = `bold 12px ${MAP_FONT}`;
    ctx.fillStyle = s === 40 ? "#212121" : "#ffffff";
    drawInkCenteredText(ctx, mapScaleLabel(s), lx + 9, ry + 9);
    ctx.font = `13px ${MAP_FONT}`;
    ctx.fillStyle = "#eceff1";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${mapScaleLabel(s)}：${counts.get(s)}`, lx + 24, ry + 9);
  });
}

export async function buildIntensityReportCanvas(
  points: PlotPoint[],
  record: MergedQuake | null,
  opts: { places?: Place[] } = {}
): Promise<HTMLCanvasElement | null> {
  if (!points || points.length === 0) return null;
  const canvas = makeCanvas(REPORT_W, REPORT_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const hypo: LatLon | null = isValidCoord(record?.lat, record?.lon) ? { lat: record!.lat as number, lon: record!.lon as number } : null;
  const { main, southwest, ogasawara } = splitRemotePoints(points);
  const mainCoords: LatLon[] = [...main];
  if (hypo) mainCoords.push(hypo);
  const region: MapRegion = { ox: 0, oy: 0, w: REPORT_MAP_W, h: REPORT_H, view: computeMapView(mainCoords, REPORT_MAP_W, REPORT_H) };
  const usedView = await drawMarkerRegion(ctx, region, main, { hypo, places: opts.places, fitCoords: mainCoords, fallbackJpBox: true });
  const toPx = regionToPx(region, usedView);
  const mainPlaced = placeScalePoints(main, toPx);
  const mainHypoPx = hypo ? toPx(hypo.lat, hypo.lon) : null;
  const groups: InsetGroup[] = [];
  if (southwest.length > 0) groups.push({ label: INSET_LABEL_SW, preference: "bottomLeft", points: southwest, hypo: null });
  if (ogasawara.length > 0) groups.push({ label: INSET_LABEL_OG, preference: "bottomRight", points: ogasawara, hypo: null });
  await drawPointInsets(ctx, { x: 0, y: 0, w: REPORT_MAP_W, h: REPORT_H }, mainPlaced, mainHypoPx, groups);
  // 📰 Panel.
  drawPanelBase(ctx, "震度情報");
  const dt = record ? parseJstTime(record.time) : null;
  const timeText = dt
    ? `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, "0")}時${String(dt.getMinutes()).padStart(2, "0")}分ごろ`
    : "―";
  let y = 56;
  y = drawPanelItem(ctx, y, "最大震度", mapScaleLabel(record?.maxScale ?? 0), { color: mapScaleColor(record?.maxScale ?? 0), size: 44 });
  y = drawPanelItem(ctx, y, "発生時刻", timeText, { size: 22 });
  y = drawPanelItem(ctx, y, "震源", record?.hypocenter ?? "―", { size: 24 });
  y = drawPanelItem(
    ctx,
    y,
    "規模・マグニチュード",
    record?.magnitude !== null && record?.magnitude !== undefined ? `M${record.magnitude}` : "―",
    { size: 24 }
  );
  y = drawPanelItem(ctx, y, "深さ", depthLabel(record?.depthKm ?? null), { size: 24 });
  const tsunamiText = TSUNAMI_LABELS[record?.tsunamiKind ?? "Unknown"] ?? "―";
  y = drawPanelItem(ctx, y, "津波", tsunamiText, {
    size: 24,
    color: record?.tsunamiKind === "Advisory" || record?.tsunamiKind === "Warning" ? "#ff8a80" : "#ffffff",
  });
  const counts = new Map<number, number>();
  for (const p of points) counts.set(p.scale, (counts.get(p.scale) ?? 0) + 1);
  drawLegend(ctx, REPORT_PANEL_X + 18, y + 4, counts);
  await drawOverview(ctx, { x: REPORT_PANEL_X + 18, y: REPORT_H - 190, w: 284, h: 160 }, usedView, hypo);
  drawMapCredit(ctx, "地図: 国土地理院｜A.A.S 編集電文");
  return canvas;
}

// ==========================================
// 🚨 EEW polygon fill (browser port of buildEewFillMap)
// ==========================================
export interface EewFillResult {
  canvas: HTMLCanvasElement;
  resolved: number;
  unresolved: string[];
}
interface FillPlaced extends EewFill {
  x: number;
  y: number;
  r: number;
}
interface EewFillInput {
  name: string;
  pref: string;
  scale: number;
  scaleTo: number;
  openEnded: boolean;
  polygons: MultiPolygon | null;
  lat: number | null;
  lon: number | null;
}

// 🎨 Fill style for an EEW intensity: solid for fixed values, diagonal
// hatching for open-ended (scaleTo 99).
function eewFillStyle(ctx: CanvasRenderingContext2D, scale: number, openEnded: boolean, x: number, y: number): string | CanvasPattern {
  const base = mapScaleColor(scale);
  if (!openEnded) return base;
  const pattern = document.createElement("canvas");
  pattern.width = 14;
  pattern.height = 14;
  const pctx = pattern.getContext("2d");
  if (!pctx) return base;
  pctx.fillStyle = base;
  pctx.fillRect(0, 0, 14, 14);
  pctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
  pctx.lineWidth = 2.5;
  pctx.beginPath();
  pctx.moveTo(-4, 10);
  pctx.lineTo(10, -4);
  pctx.moveTo(4, 18);
  pctx.lineTo(18, 4);
  pctx.stroke();
  const pat = ctx.createPattern(pattern, "repeat");
  if (pat && typeof (pat as CanvasPattern & { setTransform?: unknown }).setTransform === "function") {
    const m = new DOMMatrix();
    m.translateSelf(x, y);
    (pat as CanvasPattern).setTransform(m);
  }
  return pat ?? base;
}

// 🖊️ Trace all rings of a polygon set into the current path.
function tracePolygons(ctx: CanvasRenderingContext2D, toPx: (lat: number, lon: number) => { x: number; y: number }, polygons: MultiPolygon) {
  for (const poly of polygons) {
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      ring.forEach((pt, i) => {
        const p = toPx(pt[1], pt[0]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
    }
  }
}

// 🏷️ EEW labels: the area core name plus the intensity; collision-chosen.
function drawEewLabels(ctx: CanvasRenderingContext2D, region: MapRegion, fills: FillPlaced[], hypoPx: { x: number; y: number } | null) {
  const bounds: Rect = { x: region.ox, y: region.oy, w: region.w, h: region.h };
  const occupied: Rect[] = fills.map((f) => ({ x: f.x - f.r, y: f.y - f.r, w: f.r * 2, h: f.r * 2 }));
  if (hypoPx) occupied.push({ x: hypoPx.x - 15, y: hypoPx.y - 15, w: 30, h: 30 });
  const sorted = [...fills].sort((a, b) => b.scale - a.scale);
  for (const f of sorted) {
    const text = `${eewCoreName(f.name, f.pref) || f.name} ${mapScaleLabel(f.scale)}`;
    const size = measureLabel(ctx, text);
    const rect = chooseLabelRect({ x: f.x, y: f.y }, size, f.r + 4, occupied, bounds);
    if (occupied.some((o) => rectOverlapArea(rect, o, 1) > size.w * size.h * 0.45)) continue;
    drawLabelRect(ctx, rect, text);
    occupied.push(rect);
  }
  if (hypoPx) {
    const size = measureLabel(ctx, "震源");
    const rect = chooseLabelRect(hypoPx, size, 17, occupied, bounds);
    drawLabelRect(ctx, rect, "震源", { fg: "#ff8a80" });
  }
}

/**
 * Paint one EEW fill region (main map or inset) in the order tiles →
 * polygon fills → polygon outlines → hypo → markers → labels. Returns
 * the view actually used.
 */
async function drawFillRegion(
  ctx: CanvasRenderingContext2D,
  region: MapRegion,
  fills: EewFillInput[],
  opts: RegionOpts = {}
): Promise<MapView> {
  const fitCoords: LatLon[] = opts.fitCoords ?? [];
  const view = await paintTiles(ctx, region, region.view, fitCoords, {
    fitSnap: opts.fitSnap,
    fitFreeOrigin: opts.fitFreeOrigin,
    minSpan: opts.minSpan,
    maxZoom: opts.maxZoom,
    fallbackJpBox: opts.fallbackJpBox,
  });
  const toPx = regionToPx(region, view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.ox, region.oy, region.w, region.h);
  ctx.clip();
  // 🎨 Fills first: weakest on the bottom, strongest on top.
  for (const f of [...fills].sort((a, b) => a.scale - b.scale)) {
    if (!f.polygons || f.polygons.length === 0) continue;
    ctx.beginPath();
    tracePolygons(ctx, toPx, f.polygons);
    ctx.fillStyle = eewFillStyle(ctx, f.scale, f.openEnded, region.ox, region.oy);
    ctx.fill("evenodd");
  }
  // 🖊️ Outlines on top of every fill.
  for (const f of fills) {
    if (!f.polygons || f.polygons.length === 0) continue;
    ctx.beginPath();
    tracePolygons(ctx, toPx, f.polygons);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.strokeStyle = "rgba(10, 16, 24, 0.55)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
  const hypoPx = opts.hypo ? toPx(opts.hypo.lat, opts.hypo.lon) : null;
  if (hypoPx) drawHypoMark(ctx, hypoPx.x, hypoPx.y);
  const coordFills = fills.filter((f) => isValidCoord(f.lat, f.lon));
  const placed = placeScalePoints(
    coordFills.map((f) => ({ name: f.name, scale: f.scale, lat: f.lat as number, lon: f.lon as number, openEnded: f.openEnded })),
    toPx
  ).map((p) => {
    const src = coordFills.find((f) => f.name === p.name)!;
    return { ...src, lat: p.lat, lon: p.lon, x: p.x, y: p.y, r: p.r };
  });
  drawScaleMarkers(ctx, region, placed);
  drawEewLabels(ctx, region, placed, hypoPx);
  ctx.restore();
  return view;
}

// 🖼️ EEW insets (fill style): frame + region-name label.
async function drawEewInsets(
  ctx: CanvasRenderingContext2D,
  mapRect: Rect,
  mainPlaced: FillPlaced[],
  mainHypoPx: { x: number; y: number } | null,
  groups: { label: string; preference: "bottomLeft" | "bottomRight"; fills: EewFillInput[]; coords: LatLon[] }[]
) {
  const obstacles = mainPlaced.map((p) => ({ x: p.x, y: p.y, r: p.r, scale: p.scale }));
  if (mainHypoPx) obstacles.push({ x: mainHypoPx.x, y: mainHypoPx.y, r: 15, scale: Number.MAX_SAFE_INTEGER });
  const placedInsets: Rect[] = [];
  for (const group of groups) {
    if (group.fills.length === 0) continue;
    const view = computeMapView(group.coords, INSET_W, INSET_H, INSET_SNAP, true, MAP_MAX_ZOOM, { lat: 0.45, lon: 0.55 });
    const rect = chooseInsetRect(obstacles, group.preference, placedInsets, mapRect);
    placedInsets.push(rect);
    await drawFillRegion(ctx, { ox: rect.x, oy: rect.y, w: rect.w, h: rect.h, view }, group.fills, {
      fitCoords: group.coords,
      fitSnap: INSET_SNAP,
      fitFreeOrigin: true,
      maxZoom: MAP_MAX_ZOOM,
      minSpan: { lat: 0.45, lon: 0.55 },
    });
    drawInsetFrame(ctx, rect, group.label);
  }
}

const EEW_MIN_SPAN = { lat: 0.45, lon: 0.55 };
const EEW_MAX_ZOOM = 11;

// 📰 The EEW panel (shared by the fill and report images).
function drawEewPanel(ctx: CanvasRenderingContext2D, eew: EewValue, headline: string) {
  drawPanelBase(ctx, "緊急地震速報");
  let y = 56;
  y = drawPanelItem(ctx, y, "見出し", headline || "―", { size: 22 });
  y = drawPanelItem(ctx, y, "最大震度", mapScaleLabel(eew.estScale ?? 0), {
    color: mapScaleColor(eew.estScale ?? 0),
    size: 44,
  });
  const dt = parseJstTime(eew.originTime);
  const timeText = dt
    ? `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, "0")}時${String(dt.getMinutes()).padStart(2, "0")}分ごろ`
    : "―";
  y = drawPanelItem(ctx, y, "発生時刻", timeText, { size: 22 });
  y = drawPanelItem(ctx, y, "震源", eew.hypocenter ?? "―", { size: 24 });
  y = drawPanelItem(ctx, y, "規模・マグニチュード", eew.estMagnitude !== null && eew.estMagnitude !== undefined ? `M${eew.estMagnitude}` : "―", { size: 24 });
  y = drawPanelItem(ctx, y, "深さ", depthLabel(eew.estDepthKm ?? null), { size: 24 });
  const areaCount = eew.areas?.length ?? 0;
  const topAreas = [...(eew.areas ?? [])]
    .sort((a, b) => b.scale - a.scale)
    .slice(0, 3)
    .map((a) => a.name)
    .join("、");
  y = drawPanelItem(ctx, y, "対象地域", `${areaCount}地域`, { size: 24, note: topAreas ? `強い地域: ${topAreas}` : undefined });
  const legendY = REPORT_H - 160;
  ctx.fillStyle = "#90a4ae";
  ctx.font = `bold 13px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("凡例", REPORT_PANEL_X + 18, legendY);
  ctx.fillStyle = MAP_SCALE_COLORS[45];
  ctx.fillRect(REPORT_PANEL_X + 18, legendY + 22, 18, 12);
  ctx.fillStyle = "#eceff1";
  ctx.font = `12px ${MAP_FONT}`;
  ctx.fillText("面で塗りつぶし（予測震度）", REPORT_PANEL_X + 44, legendY + 21);
  ctx.fillStyle = MAP_SCALE_COLORS[45];
  ctx.fillRect(REPORT_PANEL_X + 18, legendY + 42, 18, 12);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(REPORT_PANEL_X + 18, legendY + 54);
  ctx.lineTo(REPORT_PANEL_X + 36, legendY + 42);
  ctx.stroke();
  ctx.fillStyle = "#eceff1";
  ctx.fillText("斜線は「以上」（5弱以上など）", REPORT_PANEL_X + 44, legendY + 41);
}

export async function buildEewFillCanvas(eew: EewValue, headline: string): Promise<EewFillResult | null> {
  const { loadAndResolveEewFills } = await import("./map-data");
  const { fills, unresolved } = await loadAndResolveEewFills(eew);
  if (fills.length === 0) return null;
  const canvas = makeCanvas(REPORT_W, REPORT_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const hypo: LatLon | null = isValidCoord(eew.lat, eew.lon) ? { lat: eew.lat as number, lon: eew.lon as number } : null;
  const { main, southwest, ogasawara } = splitRemotePoints(fills.filter((f): f is EewFill & LatLon => isValidCoord(f.lat, f.lon)));
  const mainCoords: LatLon[] = main.map((f) => ({ lat: f.lat, lon: f.lon }));
  if (hypo) mainCoords.push(hypo);
  const region: MapRegion = {
    ox: 0,
    oy: 0,
    w: REPORT_MAP_W,
    h: REPORT_H,
    view: computeMapView(mainCoords, REPORT_MAP_W, REPORT_H, MAP_TILE_SIZE, false, EEW_MAX_ZOOM, EEW_MIN_SPAN),
  };
  const usedView = await drawFillRegion(ctx, region, main, {
    hypo,
    fitCoords: mainCoords,
    maxZoom: EEW_MAX_ZOOM,
    minSpan: EEW_MIN_SPAN,
    fallbackJpBox: true,
  });
  const toPx = regionToPx(region, usedView);
  const mainPlaced: FillPlaced[] = main
    .filter((f) => isValidCoord(f.lat, f.lon))
    .map((f) => {
      const p = toPx(f.lat, f.lon);
      return { ...f, x: p.x, y: p.y, r: mapScaleRadius(f.scale) };
    });
  const mainHypoPx = hypo ? toPx(hypo.lat, hypo.lon) : null;
  const groups = [];
  if (southwest.length > 0)
    groups.push({ label: INSET_LABEL_SW, preference: "bottomLeft" as const, fills: southwest, coords: southwest.map((f) => ({ lat: f.lat, lon: f.lon })) });
  if (ogasawara.length > 0)
    groups.push({ label: INSET_LABEL_OG, preference: "bottomRight" as const, fills: ogasawara, coords: ogasawara.map((f) => ({ lat: f.lat, lon: f.lon })) });
  await drawEewInsets(ctx, { x: 0, y: 0, w: REPORT_MAP_W, h: REPORT_H }, mainPlaced, mainHypoPx, groups);
  drawEewPanel(ctx, eew, headline);
  await drawOverview(ctx, { x: REPORT_PANEL_X + 18, y: REPORT_H - 190, w: 284, h: 160 }, usedView, hypo);
  drawMapCredit(ctx, "地図: 国土地理院 / 区域: NII 気象庁防災情報XMLフォーマット・データセット｜A.A.S 編集電文");
  return { canvas, resolved: fills.length, unresolved };
}

// ==========================================
// 🚨 EEW report image (browser port of buildEewReport)
// ==========================================
export async function buildEewReportCanvas(eew: EewValue, headline: string): Promise<HTMLCanvasElement | null> {
  const { loadAndResolveEewFills } = await import("./map-data");
  const { fills } = await loadAndResolveEewFills(eew);
  const coordFills = fills.filter((f) => isValidCoord(f.lat, f.lon));
  if (coordFills.length === 0) return null;
  const canvas = makeCanvas(REPORT_W, REPORT_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const hypo: LatLon | null = isValidCoord(eew.lat, eew.lon) ? { lat: eew.lat as number, lon: eew.lon as number } : null;
  const { main, southwest, ogasawara } = splitRemotePoints(
    coordFills.map((f) => ({ name: f.name, scale: f.scale, lat: f.lat as number, lon: f.lon as number, openEnded: f.openEnded }))
  );
  const mainCoords: LatLon[] = [...main];
  if (hypo) mainCoords.push(hypo);
  const region: MapRegion = { ox: 0, oy: 0, w: REPORT_MAP_W, h: REPORT_H, view: computeMapView(mainCoords, REPORT_MAP_W, REPORT_H) };
  const usedView = await drawMarkerRegion(ctx, region, main, { hypo, fitCoords: mainCoords, fallbackJpBox: true });
  const toPx = regionToPx(region, usedView);
  const mainPlaced = placeScalePoints(main, toPx);
  const mainHypoPx = hypo ? toPx(hypo.lat, hypo.lon) : null;
  const groups: InsetGroup[] = [];
  if (southwest.length > 0) groups.push({ label: INSET_LABEL_SW, preference: "bottomLeft", points: southwest, hypo: null });
  if (ogasawara.length > 0) groups.push({ label: INSET_LABEL_OG, preference: "bottomRight", points: ogasawara, hypo: null });
  await drawPointInsets(ctx, { x: 0, y: 0, w: REPORT_MAP_W, h: REPORT_H }, mainPlaced, mainHypoPx, groups);
  drawEewPanel(ctx, eew, headline);
  await drawOverview(ctx, { x: REPORT_PANEL_X + 18, y: REPORT_H - 190, w: 284, h: 160 }, usedView, hypo);
  drawMapCredit(ctx, "地図: 国土地理院｜A.A.S 編集電文");
  return canvas;
}

// ==========================================
// 🌊 Tsunami maps (browser ports of buildTsunamiMap / buildTsunamiReport)
// ==========================================
export const TSUNAMI_GRADE_COLORS: Record<string, string> = { MajorWarning: "#c2185b", Warning: "#e53935", Watch: "#fdd835" };
export const TSUNAMI_GRADE_RANK: Record<string, number> = GRADE_RANK;

// 📰 The tsunami panel (shared by the coastline and report images).
function drawTsunamiPanel(ctx: CanvasRenderingContext2D, tsunami: TsunamiValue) {
  drawPanelBase(ctx, "津波情報");
  let y = 56;
  const dt = parseJstTime(tsunami.time);
  const timeText = dt
    ? `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, "0")}時${String(dt.getMinutes()).padStart(2, "0")}分`
    : "―";
  y = drawPanelItem(ctx, y, "発表時刻", timeText, { size: 22 });
  const grade = tsunami.grade ?? "";
  y = drawPanelItem(ctx, y, "発表種別", GRADE_LABELS[grade] ?? grade ?? "―", {
    size: 30,
    color: TSUNAMI_GRADE_COLORS[grade] ?? "#ffffff",
  });
  const top = [...(tsunami.areas ?? [])]
    .filter((a) => !a.cancelled)
    .sort((a, b) => (GRADE_RANK[b.grade] ?? 0) - (GRADE_RANK[a.grade] ?? 0))[0];
  y = drawPanelItem(ctx, y, "対象区域", `${tsunami.areas?.filter((a) => !a.cancelled).length ?? 0}区域`, {
    size: 24,
    note: top ? `最も強い区域: ${top.name}` : undefined,
  });
  const legendY = REPORT_H - 160;
  ctx.fillStyle = "#90a4ae";
  ctx.font = `bold 13px ${MAP_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("凡例", REPORT_PANEL_X + 18, legendY);
  const legend: [string, string][] = [
    ["MajorWarning", "大津波警報"],
    ["Warning", "津波警報"],
    ["Watch", "津波注意報"],
  ];
  legend.forEach(([g, label], i) => {
    const ly = legendY + 24 + i * 22;
    ctx.fillStyle = TSUNAMI_GRADE_COLORS[g];
    ctx.fillRect(REPORT_PANEL_X + 18, ly, 22, 6);
    ctx.fillStyle = "#eceff1";
    ctx.font = `12px ${MAP_FONT}`;
    ctx.fillText(label, REPORT_PANEL_X + 48, ly - 3);
  });
}

// 🌊 Coastline map: grade-coloured 5px polylines with a white underlay.
export async function buildTsunamiCoastCanvas(tsunami: TsunamiValue): Promise<HTMLCanvasElement | null> {
  const { loadAndResolveTsunamiCoast } = await import("./map-data");
  const { areas } = await loadAndResolveTsunamiCoast(tsunami);
  if (areas.length === 0) return null;
  const canvas = makeCanvas(REPORT_W, REPORT_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const fitCoords: LatLon[] = areas.map((a) => ({ lat: a.lat, lon: a.lon }));
  for (const a of areas) for (const line of a.lines) for (const [lon, lat] of line) fitCoords.push({ lat, lon });
  const region: MapRegion = { ox: 0, oy: 0, w: REPORT_MAP_W, h: REPORT_H, view: computeMapView(fitCoords, REPORT_MAP_W, REPORT_H) };
  const usedView = await paintTiles(ctx, region, region.view, fitCoords, { fallbackJpBox: true });
  const toPx = regionToPx(region, usedView);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, REPORT_MAP_W, REPORT_H);
  ctx.clip();
  for (const pass of [0, 1]) {
    for (const a of areas) {
      ctx.beginPath();
      for (const line of a.lines) {
        line.forEach(([lon, lat], i) => {
          const p = toPx(lat, lon);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
      }
      if (pass === 0) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 8;
      } else {
        ctx.strokeStyle = TSUNAMI_GRADE_COLORS[a.grade] ?? "#1e88e5";
        ctx.lineWidth = 5;
      }
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  }
  ctx.restore();
  drawTsunamiPanel(ctx, tsunami);
  await drawOverview(ctx, { x: REPORT_PANEL_X + 18, y: REPORT_H - 190, w: 284, h: 160 }, usedView, null);
  drawMapCredit(ctx, "地図: 国土地理院 / 海岸線: Natural Earth｜A.A.S 編集電文");
  return canvas;
}

// 🌊 Report image: zone markers in the same style as intensity markers.
export async function buildTsunamiReportCanvas(tsunami: TsunamiValue): Promise<HTMLCanvasElement | null> {
  const { loadAndResolveTsunamiPoints } = await import("./map-data");
  const { areas } = await loadAndResolveTsunamiPoints(tsunami);
  if (areas.length === 0) return null;
  const canvas = makeCanvas(REPORT_W, REPORT_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const markers: (TsunamiZoneArea & { rank: number })[] = areas.map((a) => ({ ...a, rank: TSUNAMI_GRADE_RANK[a.grade] ?? 0 }));
  const { main, southwest, ogasawara } = splitRemotePoints(markers);
  const region: MapRegion = { ox: 0, oy: 0, w: REPORT_MAP_W, h: REPORT_H, view: computeMapView(main, REPORT_MAP_W, REPORT_H) };
  const usedView = await paintTiles(ctx, region, region.view, main, { fallbackJpBox: true });
  const toPx = regionToPx(region, usedView);
  const drawZone = (a: TsunamiZoneArea & { rank: number }) => {
    const p = toPx(a.lat, a.lon);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = TSUNAMI_GRADE_COLORS[a.grade] ?? "#1e88e5";
    ctx.fill();
    ctx.strokeStyle = "rgba(10, 16, 24, 0.85)";
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `bold 11px ${MAP_FONT}`;
    ctx.fillStyle = a.grade === "Watch" ? "#212121" : "#ffffff";
    drawInkCenteredText(ctx, "津", p.x, p.y);
    return { ...a, x: p.x, y: p.y, r: 13 };
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, REPORT_MAP_W, REPORT_H);
  ctx.clip();
  const mainPlaced = [...main].sort((a, b) => a.rank - b.rank).map(drawZone);
  ctx.restore();
  const insetGroups: InsetGroup[] = [];
  const toInsetPoints = (list: (TsunamiZoneArea & { rank: number })[]): MarkerPoint[] =>
    list.map((a) => ({ name: a.name, scale: a.rank === 3 ? 70 : a.rank === 2 ? 50 : 20, lat: a.lat, lon: a.lon }));
  if (southwest.length > 0) insetGroups.push({ label: INSET_LABEL_SW, preference: "bottomLeft", points: toInsetPoints(southwest), hypo: null });
  if (ogasawara.length > 0) insetGroups.push({ label: INSET_LABEL_OG, preference: "bottomRight", points: toInsetPoints(ogasawara), hypo: null });
  await drawPointInsets(
    ctx,
    { x: 0, y: 0, w: REPORT_MAP_W, h: REPORT_H },
    mainPlaced.map((p) => ({ name: p.name, scale: p.rank, lat: p.lat, lon: p.lon, x: p.x, y: p.y, r: p.r })),
    null,
    insetGroups
  );
  drawTsunamiPanel(ctx, tsunami);
  await drawOverview(ctx, { x: REPORT_PANEL_X + 18, y: REPORT_H - 190, w: 284, h: 160 }, usedView, null);
  drawMapCredit(ctx, "地図: 国土地理院｜A.A.S 編集電文");
  return canvas;
}
