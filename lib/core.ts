/* bosai — shared constants, lookup tables and small utilities.
   Display rules (intensity labels and colours, tsunami wording, WMO
   weather names) follow the conventions shared across the AEGIS family
   (Discord bot, Android app, and the previous bosai implementation).
   Event data comes from A.A.S (A2S) only; the single exception is the
   long-range aggregation on the stats page, which reads the P2P history
   API (see the decision log in README.md). */

// ==========================================
// 📌 Endpoints and timing constants
// ==========================================
// 📊 Stats page only: long-range aggregation over the P2P history API.
export const P2P_HISTORY = "https://api.p2pquake.net/v2/history";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
// 🔄 Dashboard REST recovery interval (SSE is the primary channel).
export const REFRESH_MS = 30_000;
// 🚨 An EEW banner is shown only within 10 minutes of the event.
export const EEW_BANNER_WINDOW_MS = 10 * 60_000;
// 🚨 A tsunami cancellation banner is shown for 6 hours after issue: long
// enough to be seen the same day, short enough to avoid stale confusion.
export const TSUNAMI_CANCEL_BANNER_WINDOW_MS = 6 * 60 * 60_000;
// 🌋 Quakes at the same time whose hypocentres are within 30 km are
// treated as the same event even when the reported names differ.
export const HYPOCENTER_NEAR_KM = 30;
// 🧠 Open-Meteo model selection is explicit and order-sensitive: the first
// model (jma_seamless) drives the current block and response grid, while
// precipitation probability is read from ecmwf_ifs025 because the JMA
// models do not provide it.
export const FORECAST_MODELS = "jma_seamless,ecmwf_ifs025";
export const FORECAST_MODEL_NOTE = "予報: Open-Meteo（気温・天気: 気象庁モデル MSM/GSM、降水確率: ECMWF IFS）";
// 🌧️ JMA precipitation nowcast tiles (free, no key).
// Tile URL shape: .../nowc/{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png
export const JMA_NOWCAST_TARGET_TIMES = "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json";
export const JMA_NOWCAST_TILE_URL =
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png";
// 🖼️ Radar frames older than this are flagged as possibly stale.
export const RADAR_STALE_MS = 20 * 60_000;

// ==========================================
// 🏷️ Display tables
// ==========================================
// 📈 Intensity code → web label ("5弱" style; maps use the bot's "5-"
// style, which lives in lib/map-geo.ts).
export const SCALE_LABELS: Record<number, string> = { 10: "1", 20: "2", 30: "3", 40: "4", 45: "5弱", 50: "5強", 55: "6弱", 60: "6強", 70: "7" };
// 🎨 Web intensity colours (same five bands as the AEGIS Android app).
export const SCALE_COLORS: { min: number; color: string; cls: string }[] = [
  { min: 45, color: "#c93a3a", cls: "scale-5" },
  { min: 40, color: "#d97a2b", cls: "scale-4" },
  { min: 30, color: "#a8871d", cls: "scale-3" },
  { min: 20, color: "#3e6b9e", cls: "scale-2" },
  { min: 10, color: "#54687f", cls: "scale-1" },
];

export const TSUNAMI_LABELS: Record<string, string> = {
  None: "津波の心配なし",
  Forecast: "若干の海面変動の可能性あり",
  Advisory: "津波注意報レベル",
  Warning: "津波警報レベル",
  Unknown: "津波の有無は確認中",
};
export const GRADE_LABELS: Record<string, string> = { MajorWarning: "大津波警報", Warning: "津波警報", Watch: "津波注意報" };
export const GRADE_RANK: Record<string, number> = { MajorWarning: 3, Warning: 2, Watch: 1 };

export const WMO_WEATHER: Record<number, string> = {
  0: "快晴", 1: "晴れ", 2: "一部曇り", 3: "曇り", 45: "霧", 48: "霧",
  51: "霧雨", 53: "霧雨", 55: "霧雨", 56: "着氷性の霧雨", 57: "着氷性の霧雨",
  61: "雨", 63: "雨", 65: "大雨", 66: "着氷性の雨", 67: "着氷性の雨",
  71: "雪", 73: "雪", 75: "大雪", 77: "雪あられ",
  80: "にわか雨", 81: "にわか雨", 82: "激しい雨", 85: "雪", 86: "雪",
  95: "雷雨", 96: "雷雨（雹）", 99: "雷雨（雹）",
};
export const WMO_EMOJI: Record<number, string> = {
  0: "☀", 1: "🌤", 2: "⛅", 3: "☁", 45: "🌫", 48: "🌫",
  51: "🌦", 53: "🌦", 55: "🌦", 56: "🌧", 57: "🌧",
  61: "🌧", 63: "🌧", 65: "🌧", 66: "🌧", 67: "🌧",
  71: "🌨", 73: "🌨", 75: "🌨", 77: "🌨",
  80: "🌦", 81: "🌦", 82: "⛈", 85: "🌨", 86: "🌨",
  95: "⛈", 96: "⛈", 99: "⛈",
};

// ==========================================
// 🧰 Utilities
// ==========================================
// 🔢 Coerce a number or numeric string; anything else becomes null.
export function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// 🕐 Parse a JST timestamp "2026/11/19 06:41:00" into a Date (null on failure).
export function parseJstTime(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s.replaceAll("/", "-").replace(" ", "T") + "+09:00");
  return Number.isNaN(d.getTime()) ? null : d;
}
// 🕐 Alias kept for the stats-side code that speaks in P2P terms.
export const parseP2pTime = parseJstTime;

// 🕐 Format a Date as "M/D H:mm".
export function fmtTime(d: Date | null): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 🌐 Fetch JSON with a timeout.
export async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown> {
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

// 📈 Intensity code → display label ("不明" when unknown).
export function scaleLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "不明";
  return SCALE_LABELS[scale] ?? String(scale);
}
// 🎨 Colour band for an intensity code.
export function scaleStyle(scale: number): { min?: number; color: string; cls: string } {
  for (const s of SCALE_COLORS) if (scale >= s.min) return s;
  return { color: "#3a465c", cls: "scale-unknown" };
}
// ⬇️ Depth wording. -1 is the "unknown" sentinel; JMA reports very shallow
// quakes with depth 0, which reads as 「ごく浅い」.
export function depthLabel(depthKm: number | null | undefined): string {
  if (depthKm === null || depthKm === undefined) return "深さ不明";
  if (depthKm < 0) return "深さ不明";
  if (depthKm === 0) return "ごく浅い";
  return `約${depthKm}km`;
}
// 📍 Great-circle distance in km (used by the hypocentre proximity merge).
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// 🌧️ JMA tile timestamps "20261122010000" are UTC, not JST (verified against
// live data: at 04:57 UTC the newest frame was 045500). Parsing them as JST
// would make the freshest radar frame look about 9 hours old.
export function parseJmaTime14(s: unknown): Date | null {
  if (typeof s !== "string" || !/^\d{14}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
// 🌡️ Temperatures render with one decimal; other quantities round whole.
export function formatTemp(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(Math.round(v * 10) / 10).toFixed(1)}°`;
}
export function formatRound(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return String(Math.round(v));
}
// 🖼️ The newest nowcast frame is the first entry of targetTimes_N1.json.
export interface NowcastTarget {
  basetime: string;
  validtime: string;
  valid: Date;
}
export function parseNowcastTargets(data: unknown): NowcastTarget | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { basetime?: unknown; validtime?: unknown } | null;
  const basetime = String(first?.basetime ?? "");
  const validtime = String(first?.validtime ?? "");
  const valid = parseJmaTime14(validtime);
  if (!basetime || !valid) return null;
  return { basetime, validtime, valid };
}
// 🖼️ Human-readable radar age plus a staleness flag.
export function radarFreshness(validDate: Date | null, nowMs = Date.now()): { text: string; stale: boolean; ageMin: number | null } {
  if (!validDate) return { text: "", stale: false, ageMin: null };
  const ageMin = Math.max(0, Math.round((nowMs - validDate.getTime()) / 60_000));
  return { text: `約${ageMin}分前の観測`, stale: nowMs - validDate.getTime() > RADAR_STALE_MS, ageMin };
}
