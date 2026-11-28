/* bosai — weather (Open-Meteo) and rain radar (JMA nowcast).
   The forecast request names its models explicitly (jma_seamless for the
   current block, temperature, weather and wind; ecmwf_ifs025 for
   precipitation probability). Response keys carry the model name as a
   suffix, and unsuffixed hourly/daily keys are never read — silently
   falling back to best_match would mix models. The current block is the
   one exception: the live API returns it with plain keys (verified
   against the real API), so current reads suffixed first, then plain.
   Missing values render as "—".
   The radar composites GSI base tiles with JMA nowcast tiles on a canvas
   (the previous Leaflet-based approach was dropped to remove the external
   library dependency). */

import {
  fetchJson,
  FORECAST_MODELS,
  FORECAST_URL,
  JMA_NOWCAST_TARGET_TIMES,
  JMA_NOWCAST_TILE_URL,
  numOrNull,
  parseNowcastTargets,
  type NowcastTarget,
} from "./core";
import { latToWorldY, lonToWorldX, MAP_SEA_COLOR, MAP_TILE_SIZE, MAP_TILE_URL } from "./map-geo";

// 📍 Default weather/radar point when no place is saved (Tokyo Station).
export const DEFAULT_WEATHER_POINT = { name: "東京", lat: 35.6812, lon: 139.7671 };

export interface ForecastCurrent {
  time: string | null;
  temp: number | null;
  code: number | null;
  windSpeed: number | null;
  windDirDeg: number | null;
  precip: number | null;
}
export interface ForecastHour {
  time: string;
  temp: number | null;
  code: number | null;
  pop: number | null;
}
export interface ForecastDay {
  date: string;
  code: number | null;
  tMax: number | null;
  tMin: number | null;
  popMax: number | null;
}
export interface Forecast {
  current: ForecastCurrent;
  hours: ForecastHour[];
  days: ForecastDay[];
}

// ==========================================
// 🌦️ Open-Meteo forecast
// ==========================================
export function buildForecastUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    models: FORECAST_MODELS,
    current: "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "Asia/Tokyo",
    forecast_days: "7",
  });
  return `${FORECAST_URL}?${params.toString()}`;
}

// 📌 Read a model-suffixed key (null when absent).
function modelValue(obj: Record<string, unknown> | null | undefined, base: string, model: string): unknown {
  if (!obj || typeof obj !== "object") return null;
  const v = obj[`${base}_${model}`];
  return v === undefined ? null : v;
}
function modelArray(obj: Record<string, unknown> | null | undefined, base: string, model: string): unknown[] | null {
  const v = modelValue(obj, base, model);
  return Array.isArray(v) ? v : null;
}

export function parseForecastResponse(json: unknown): Forecast | null {
  if (!json || typeof json !== "object") return null;
  const root = json as { current?: Record<string, unknown>; hourly?: Record<string, unknown>; daily?: Record<string, unknown> };
  const cur = root.current ?? {};
  const hourly = root.hourly ?? {};
  const daily = root.daily ?? {};
  // 📌 Only the current block falls back to the plain key.
  const currentValue = (base: string): unknown =>
    modelValue(cur, base, "jma_seamless") ?? (cur[base] === undefined ? null : cur[base]);
  const current: ForecastCurrent = {
    time: typeof cur.time === "string" ? cur.time : null,
    temp: numOrNull(currentValue("temperature_2m")),
    code: numOrNull(currentValue("weather_code")),
    windSpeed: numOrNull(currentValue("wind_speed_10m")),
    windDirDeg: numOrNull(currentValue("wind_direction_10m")),
    precip: numOrNull(currentValue("precipitation")),
  };
  const hTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const hTemps = modelArray(hourly, "temperature_2m", "jma_seamless") ?? [];
  const hCodes = modelArray(hourly, "weather_code", "jma_seamless") ?? [];
  const hPops = modelArray(hourly, "precipitation_probability", "ecmwf_ifs025") ?? [];
  const hours: ForecastHour[] = hTimes.map((t, i) => ({
    time: String(t),
    temp: numOrNull(hTemps[i]),
    code: numOrNull(hCodes[i]),
    pop: numOrNull(hPops[i]),
  }));
  const dTimes = Array.isArray(daily.time) ? daily.time : [];
  const dCodes = modelArray(daily, "weather_code", "jma_seamless") ?? [];
  const dMax = modelArray(daily, "temperature_2m_max", "jma_seamless") ?? [];
  const dMin = modelArray(daily, "temperature_2m_min", "jma_seamless") ?? [];
  const dPops = modelArray(daily, "precipitation_probability_max", "ecmwf_ifs025") ?? [];
  const days: ForecastDay[] = dTimes.map((t, i) => ({
    date: String(t),
    code: numOrNull(dCodes[i]),
    tMax: numOrNull(dMax[i]),
    tMin: numOrNull(dMin[i]),
    popMax: numOrNull(dPops[i]),
  }));
  return { current, hours, days };
}

export async function fetchForecast(lat: number, lon: number): Promise<Forecast | null> {
  const json = await fetchJson(buildForecastUrl(lat, lon), 12_000);
  return parseForecastResponse(json);
}

// ==========================================
// 🌧️ Rain radar (JMA nowcast over GSI tiles, canvas composite)
// ==========================================
export const RADAR_ZOOM = 7;
export const RADAR_W = 640;
export const RADAR_H = 480;
const TILE_TIMEOUT_MS = 6_000;
const RADAR_FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif';

// 🕐 The newest nowcast frame (basetime / validtime).
export async function fetchNowcastTargets(): Promise<NowcastTarget | null> {
  const json = await fetchJson(JMA_NOWCAST_TARGET_TIMES, 10_000);
  return parseNowcastTargets(json);
}

export function nowcastTileUrl(basetime: string, validtime: string, z: number, x: number, y: number): string {
  return JMA_NOWCAST_TILE_URL.replace("{basetime}", basetime)
    .replace("{validtime}", validtime)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

// 🖼️ Load an image with a timeout (null on failure or timeout).
function loadImageWithTimeout(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), TILE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

// 🗺️ Draw the radar centred on a point: GSI tiles below, nowcast tiles
// above at 80% opacity, a centre marker and the credit line.
export async function drawRadar(
  canvas: HTMLCanvasElement,
  lat: number,
  lon: number,
  target: NowcastTarget | null
): Promise<NowcastTarget | null> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return target;
  canvas.width = RADAR_W;
  canvas.height = RADAR_H;
  ctx.fillStyle = MAP_SEA_COLOR;
  ctx.fillRect(0, 0, RADAR_W, RADAR_H);
  const z = RADAR_ZOOM;
  const cx = lonToWorldX(lon, z);
  const cy = latToWorldY(lat, z);
  const left = Math.round(cx - RADAR_W / 2);
  const top = Math.round(cy - RADAR_H / 2);
  const tx0 = Math.floor(left / MAP_TILE_SIZE);
  const tx1 = Math.floor((left + RADAR_W) / MAP_TILE_SIZE);
  const ty0 = Math.floor(top / MAP_TILE_SIZE);
  const ty1 = Math.floor((top + RADAR_H) / MAP_TILE_SIZE);
  const jobs: { tx: number; ty: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push({ tx, ty });
  const baseTiles = await Promise.all(jobs.map((j) => loadImageWithTimeout(`${MAP_TILE_URL}/${z}/${j.tx}/${j.ty}.png`)));
  baseTiles.forEach((img, i) => {
    if (!img) return;
    const j = jobs[i];
    ctx.drawImage(img, j.tx * MAP_TILE_SIZE - left, j.ty * MAP_TILE_SIZE - top);
  });
  // 🌧️ Nowcast (observed precipitation) overlay.
  if (target) {
    const overlay = await Promise.all(
      jobs.map((j) => loadImageWithTimeout(nowcastTileUrl(target.basetime, target.validtime, z, j.tx, j.ty)))
    );
    ctx.save();
    ctx.globalAlpha = 0.8;
    overlay.forEach((img, i) => {
      if (!img) return;
      const j = jobs[i];
      ctx.drawImage(img, j.tx * MAP_TILE_SIZE - left, j.ty * MAP_TILE_SIZE - top);
    });
    ctx.restore();
  }
  // 📍 Centre marker.
  ctx.beginPath();
  ctx.arc(RADAR_W / 2, RADAR_H / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#e53935";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  // 📌 Credit.
  ctx.font = `11px ${RADAR_FONT}`;
  ctx.fillStyle = "rgba(10, 16, 24, 0.72)";
  const credit = "地図: 国土地理院 / 雨雲: 気象庁ナウキャスト";
  ctx.fillRect(6, RADAR_H - 22, ctx.measureText(credit).width + 12, 17);
  ctx.fillStyle = "#eceff1";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(credit, 12, RADAR_H - 7);
  return target;
}
