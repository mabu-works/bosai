"use client";

/* bosai — top-page dashboard.
   Live data comes from the A.A.S client store (lib/a2s.ts): an SSE
   stream plus a 30-second REST recovery pass. The page composes the EEW
   and tsunami banners, the latest quake with its report/marker maps,
   saved places with their measured/forecast intensities, the weather
   and radar cards for one selected point, active warnings and typhoons,
   and the A.A.S status line. */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  activeTyphoons,
  activeWarnings,
  currentEew,
  currentTsunami,
  fetchA2sStatus,
  mergedQuakeList,
  refreshA2sEvents,
  setA2sOnChange,
  startA2sStream,
  type A2sStatus,
  type EewValue,
} from "@/lib/a2s";
import {
  EEW_BANNER_WINDOW_MS,
  FORECAST_MODEL_NOTE,
  GRADE_LABELS,
  REFRESH_MS,
  TSUNAMI_CANCEL_BANNER_WINDOW_MS,
  TSUNAMI_LABELS,
  WMO_EMOJI,
  WMO_WEATHER,
  depthLabel,
  fetchJson,
  fmtTime,
  formatRound,
  formatTemp,
  parseJmaTime14,
  parseJstTime,
  radarFreshness,
  scaleLabel,
} from "@/lib/core";
import { loadAndResolveQuakePoints } from "@/lib/map-data";
import { buildEewFillCanvas, buildIntensityMarkerCanvas, buildIntensityReportCanvas, buildTsunamiCoastCanvas } from "@/lib/map-render";
import {
  buildGeocodingUrl,
  eewLocalForecasts,
  loadPlaces,
  localMeasuredScale,
  parseGeocodingResults,
  savePlaces,
  type Place,
} from "@/lib/places";
import { DEFAULT_WEATHER_POINT, drawRadar, fetchForecast, fetchNowcastTargets, type Forecast } from "@/lib/weather";
import CanvasSlot from "./CanvasSlot";
import ScaleBadge from "./ScaleBadge";

// 🕐 "M/D HH:MM" from a JST timestamp string.
function fmtDateTime(s: string | null | undefined): string {
  const d = parseJstTime(s ?? null);
  if (!d) return s ? String(s) : "―";
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
}

// 🚨 The EEW headline shown in the banner and the map panel.
function eewHeadline(eew: EewValue): string {
  const base = eew.cancel ? "緊急地震速報（取消）" : eew.isWarn ? "緊急地震速報（警報）" : "緊急地震速報（予報）";
  const serial = eew.serial ? ` 第${eew.serial}報` : "";
  return base + serial + (eew.isFinal ? "（最終）" : "");
}

interface WeatherPoint {
  name: string;
  lat: number;
  lon: number;
}

export default function Dashboard() {
  const [, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [status, setStatus] = useState<A2sStatus | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [query, setQuery] = useState("");
  const [placeMsg, setPlaceMsg] = useState("");
  const [weatherPoint, setWeatherPoint] = useState<WeatherPoint>(DEFAULT_WEATHER_POINT);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [radarText, setRadarText] = useState("");
  const radarRef = useRef<HTMLCanvasElement>(null);

  // 📡 Live store: stream + periodic REST recovery + status.
  useEffect(() => {
    setA2sOnChange(() => setTick((t) => t + 1));
    startA2sStream();
    const refresh = () => {
      void refreshA2sEvents();
      void fetchA2sStatus().then((s) => {
        if (s) setStatus(s);
      });
      setNowMs(Date.now());
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(timer);
      setA2sOnChange(null);
    };
  }, []);

  // 📍 Saved places (localStorage).
  useEffect(() => {
    setPlaces(loadPlaces());
  }, []);

  // 🌦️ Forecast for the selected point.
  useEffect(() => {
    let cancelled = false;
    setForecast(null);
    void fetchForecast(weatherPoint.lat, weatherPoint.lon).then((f) => {
      if (!cancelled) setForecast(f);
    });
    return () => {
      cancelled = true;
    };
  }, [weatherPoint]);

  // 🌧️ Radar for the selected point.
  useEffect(() => {
    let cancelled = false;
    const canvas = radarRef.current;
    if (!canvas) return;
    void (async () => {
      const target = await fetchNowcastTargets();
      if (cancelled) return;
      await drawRadar(canvas, weatherPoint.lat, weatherPoint.lon, target);
      if (cancelled) return;
      const fresh = radarFreshness(target ? parseJmaTime14(target.validtime) : null);
      setRadarText(fresh.text);
    })();
    return () => {
      cancelled = true;
    };
  }, [weatherPoint]);

  const updatePlaces = (next: Place[]) => {
    setPlaces(next);
    savePlaces(next);
  };

  const onAddPlace = async () => {
    const q = query.trim();
    if (!q) return;
    setPlaceMsg("検索しています…");
    const data = await fetchJson(buildGeocodingUrl(q), 12_000);
    const results = parseGeocodingResults(data);
    if (results.length === 0) {
      setPlaceMsg("場所が見つかりませんでした。");
      return;
    }
    const r = results[0];
    updatePlaces([...places, { name: r.name, lat: r.lat, lon: r.lon, city: r.city, pref: r.pref, area: r.area }]);
    setQuery("");
    setPlaceMsg(`「${r.label}」を追加しました。`);
  };

  const onUseCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setPlaceMsg("このブラウザでは位置情報が使えません。");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updatePlaces([
          ...places,
          { name: "現在地", lat: pos.coords.latitude, lon: pos.coords.longitude, city: "", pref: "", area: "" },
        ]);
        setPlaceMsg("現在地を追加しました。");
      },
      () => setPlaceMsg("位置情報を取得できませんでした。")
    );
  };

  const eew = currentEew();
  const tsunami = currentTsunami();
  const quakes = mergedQuakeList(10);
  const latest = quakes[0] ?? null;
  const warnings = activeWarnings();
  const typhoons = activeTyphoons();

  // 🚨 EEW banner window: within 10 minutes of issue (60s future skew).
  const eewIssueMs = eew ? parseJstTime(eew.issueTime)?.getTime() ?? null : null;
  const showEew = eew !== null && eewIssueMs !== null && nowMs - eewIssueMs <= EEW_BANNER_WINDOW_MS && eewIssueMs - nowMs <= 60_000;
  const tsunamiMs = tsunami ? parseJstTime(tsunami.time)?.getTime() ?? null : null;
  const showTsunamiCancel =
    tsunami !== null && tsunami.cancelled && tsunamiMs !== null && nowMs - tsunamiMs <= TSUNAMI_CANCEL_BANNER_WINDOW_MS;
  const placeForecasts = showEew && eew ? eewLocalForecasts(eew, places) : [];

  return (
    <div className="dashboard">
      {showEew && eew ? (
        <section className={`banner ${eew.cancel ? "banner-cancel" : "banner-eew"}`} aria-live="polite">
          <div className="banner-head">
            <strong>{eewHeadline(eew)}</strong>
            <ScaleBadge scale={eew.estScale} size="lg" />
          </div>
          <p>
            {fmtDateTime(eew.originTime)}ごろ {eew.hypocenter} 深さ{depthLabel(eew.estDepthKm)}{" "}
            {eew.estMagnitude !== null ? `M${eew.estMagnitude}` : ""}
            {eew.isAssumption ? "（仮定震源要素）" : ""}
          </p>
          {placeForecasts.length > 0 ? (
            <ul className="place-forecasts">
              {placeForecasts.map((f) => (
                <li key={f.place}>
                  {f.place}（{f.areaName}）: 予測震度 <ScaleBadge scale={f.scale} size="sm" />
                </li>
              ))}
            </ul>
          ) : null}
          {!eew.cancel ? (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>地域</th>
                    <th>予測震度</th>
                    <th>到達予想</th>
                  </tr>
                </thead>
                <tbody>
                  {[...eew.areas]
                    .sort((a, b) => b.scale - a.scale)
                    .slice(0, 8)
                    .map((a) => (
                      <tr key={a.name}>
                        <td>{a.name}</td>
                        <td>
                          {scaleLabel(a.scale)}
                          {a.scaleTo === 99 ? "以上" : ""}
                        </td>
                        <td>{a.arrival ?? "―"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <CanvasSlot
                key={`eew-${eew.key}-${eew.serial ?? 0}`}
                build={async () => {
                  const result = await buildEewFillCanvas(eew, eewHeadline(eew));
                  return result ? result.canvas : null;
                }}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {tsunami && !tsunami.cancelled ? (
        <section className="banner banner-tsunami" aria-live="polite">
          <div className="banner-head">
            <strong>{GRADE_LABELS[tsunami.grade] ?? "津波情報"}</strong>
            <span>{fmtDateTime(tsunami.time)}発表</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>区域</th>
                <th>種別</th>
                <th>予想高さ</th>
                <th>到達予想</th>
              </tr>
            </thead>
            <tbody>
              {tsunami.areas
                .filter((a) => !a.cancelled)
                .map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td>{GRADE_LABELS[a.grade] ?? a.grade}</td>
                    <td>{a.maxHeight ?? "―"}</td>
                    <td>{a.arrival ?? "―"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <CanvasSlot
            key={`tsunami-${tsunami.time}-${tsunami.grade}`}
            build={() => buildTsunamiCoastCanvas(tsunami)}
          />
        </section>
      ) : null}
      {showTsunamiCancel ? (
        <section className="banner banner-cancel" aria-live="polite">
          <strong>津波警報・注意報は解除されました</strong>
          <span>（{fmtDateTime(tsunami?.time)}発表分）</span>
        </section>
      ) : null}

      <section className="card">
        <h2>最新の地震</h2>
        {latest ? (
          <>
            <p className="quake-summary">
              <ScaleBadge scale={latest.maxScale} size="lg" /> {fmtDateTime(latest.time)}ごろ {latest.hypocenter}{" "}
              {latest.magnitude !== null ? `M${latest.magnitude}` : ""} 深さ{depthLabel(latest.depthKm)}
            </p>
            <p className="muted">
              {TSUNAMI_LABELS[latest.tsunamiKind] ?? ""}
              {latest.maxPoint ? ` ／ 最大震度観測: ${latest.maxPoint.addr}（震度${scaleLabel(latest.maxPoint.scale)}）ほか${latest.maxPoint.count}地点` : ""}
            </p>
            {places.length > 0 ? (
              <ul className="place-forecasts">
                {places.map((p) => {
                  const measured = localMeasuredScale(latest, p);
                  return (
                    <li key={p.name}>
                      {p.name}: {measured !== null ? <>実測震度 <ScaleBadge scale={measured} size="sm" /></> : "実測震度 ―（観測点なし）"}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <CanvasSlot
              key={`report-${latest.id}-${latest.points.length}`}
              build={async () => {
                const { points } = await loadAndResolveQuakePoints(latest);
                return buildIntensityReportCanvas(points, latest, { places });
              }}
            />
            <CanvasSlot
              key={`marker-${latest.id}-${latest.points.length}`}
              build={async () => {
                const { points } = await loadAndResolveQuakePoints(latest);
                return buildIntensityMarkerCanvas(points, latest, { places });
              }}
            />
            <p>
              <Link href={`/quake?id=${encodeURIComponent(latest.id)}`}>この地震の詳細</Link> ／ <Link href="/quakes">地震一覧</Link>
            </p>
            <ul className="quake-list">
              {quakes.slice(1, 6).map((q) => (
                <li key={q.id}>
                  <Link href={`/quake?id=${encodeURIComponent(q.id)}`}>
                    <ScaleBadge scale={q.maxScale} size="sm" /> {fmtDateTime(q.time)} {q.hypocenter}
                    {q.magnitude !== null ? ` M${q.magnitude}` : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">地震情報を取得しています…</p>
        )}
      </section>

      <section className="card">
        <h2>登録地点</h2>
        {places.length === 0 ? (
          <p className="muted">地点を登録すると、その場所の実測震度と EEW 予測震度を表示します（この端末にのみ保存されます）。</p>
        ) : (
          <ul className="place-list">
            {places.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <span>
                  {p.name}
                  {p.pref ? `（${p.pref}${p.city}）` : ""}
                </span>
                <span className="place-actions">
                  <button type="button" onClick={() => setWeatherPoint({ name: p.name, lat: p.lat, lon: p.lon })}>
                    天気・レーダー
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePlaces(places.filter((_, j) => j !== i))}
                  >
                    削除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="place-form">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="地名・住所で検索（例: 高崎駅）"
            aria-label="地点検索"
          />
          <button type="button" onClick={() => void onAddPlace()}>
            追加
          </button>
          <button type="button" onClick={onUseCurrentLocation}>
            現在地を使う
          </button>
        </div>
        {placeMsg ? <p className="muted">{placeMsg}</p> : null}
      </section>

      <section className="card">
        <h2>天気（{weatherPoint.name}）</h2>
        {forecast ? (
          <>
            <p className="weather-current">
              <span className="weather-emoji">{WMO_EMOJI[forecast.current.code ?? -1] ?? ""}</span>
              {WMO_WEATHER[forecast.current.code ?? -1] ?? "―"} {formatTemp(forecast.current.temp)} 風速
              {formatRound(forecast.current.windSpeed)}m/s 降水{formatRound(forecast.current.precip)}mm
            </p>
            <div className="weather-hours">
              {forecast.hours.slice(0, 24).map((h) => (
                <div className="weather-hour" key={h.time}>
                  <span>{fmtTime(parseJstTime(h.time))}</span>
                  <span>{WMO_EMOJI[h.code ?? -1] ?? ""}</span>
                  <span>{formatTemp(h.temp)}</span>
                  <span className="muted">{h.pop !== null ? `${h.pop}%` : "―"}</span>
                </div>
              ))}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>天気</th>
                  <th>最高</th>
                  <th>最低</th>
                  <th>降水確率</th>
                </tr>
              </thead>
              <tbody>
                {forecast.days.map((d) => {
                  const dt = parseJstTime(d.date);
                  return (
                    <tr key={d.date}>
                      <td>{dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : d.date}</td>
                      <td>
                        {WMO_EMOJI[d.code ?? -1] ?? ""} {WMO_WEATHER[d.code ?? -1] ?? "―"}
                      </td>
                      <td>{formatTemp(d.tMax)}</td>
                      <td>{formatTemp(d.tMin)}</td>
                      <td>{d.popMax !== null ? `${d.popMax}%` : "―"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted">{FORECAST_MODEL_NOTE}</p>
          </>
        ) : (
          <p className="muted">天気を取得しています…</p>
        )}
      </section>

      <section className="card">
        <h2>雨雲レーダー（{weatherPoint.name}）</h2>
        <canvas ref={radarRef} className="radar-canvas" />
        {radarText ? <p className="muted">{radarText}</p> : null}
      </section>

      {warnings.length > 0 ? (
        <section className="card">
          <h2>気象警報・注意報</h2>
          {warnings.map((w) => (
            <div key={w.key} className="warning-block">
              <h3>
                {w.prefName} {w.areaName}
              </h3>
              <p className="muted">{w.headline}</p>
              <ul className="warning-items">
                {w.warnings.map((item) => (
                  <li key={item.code} className={item.status.includes("解除") ? "muted" : undefined}>
                    {item.name}（{item.status}）
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {typhoons.length > 0 ? (
        <section className="card">
          <h2>台風情報</h2>
          {typhoons.map((t) => (
            <div key={t.key} className="typhoon-block">
              <h3>
                台風第{t.number ?? "―"}号（{t.name}）
              </h3>
              {t.lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      <p className="status-line muted">
        {status?.eewDelivery ? "A.A.S: 接続中（EEW配信あり）" : "A.A.S: 接続中"}
      </p>
      <p className="credit muted">出典: 気象庁・P2P地震情報｜A.A.S 編集電文</p>
    </div>
  );
}
